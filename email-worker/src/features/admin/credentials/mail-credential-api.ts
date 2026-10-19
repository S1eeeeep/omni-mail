import type { Env, SessionUser } from '../../../app/types'
import { writeAudit } from '../../../shared/audit/audit'
import { globalMailKeyId } from '../../../shared/security/mail-credentials'
import { mailCredentialMigrationStatus, migrateMailCredentialBatch, parseMigrationRequest } from './mail-credential-migration'

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

function allowed(user: SessionUser, authKind: string): boolean {
  return user.role === 'super_admin' && authKind === 'cookie'
}

export async function getMailCredentialMigration(env: Env, user: SessionUser, authKind: string) {
  if (!allowed(user, authKind)) return json({ error: '只有网页登录的主管理员可以管理邮箱密钥迁移。' }, 403)
  try {
    return json(await mailCredentialMigrationStatus(env))
  } catch {
    return json({ error: '无法读取邮箱密钥迁移状态。' }, 503)
  }
}

export async function postMailCredentialMigration(
  env: Env, user: SessionUser, request: Request, authKind: string, ip: string,
) {
  if (!allowed(user, authKind)) return json({ error: '只有网页登录的主管理员可以管理邮箱密钥迁移。' }, 403)
  // 只接收有限的确认信息和游标，不接收密钥值；流读取上限不依赖 Content-Length。
  const reader = request.body?.getReader()
  if (!reader) return json({ error: '迁移参数无效。' }, 400)
  let raw = ''
  let size = 0
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2048) { await reader.cancel(); return json({ error: '迁移参数无效。' }, 413) }
      raw += decoder.decode(chunk.value, { stream: true })
    }
    raw += decoder.decode()
  } catch {
    return json({ error: '迁移参数无效。' }, 400)
  } finally { reader.releaseLock() }
  let body: ReturnType<typeof parseMigrationRequest>
  try { body = parseMigrationRequest(JSON.parse(raw)) } catch { body = null }
  if (!body) return json({ error: '迁移参数无效。' }, 400)
  if (await globalMailKeyId(env) !== body.keyId) {
    return json({ error: '全局密钥未就绪或已变化，请重新检查配置。' }, 409)
  }
  try {
    const batch = await migrateMailCredentialBatch(env, body.keyId, body.cursor)
    await writeAudit(env, user.id, 'system.mail_credentials_migrated', null, ip, {
      scanned: batch.scanned, migrated: batch.migrated, failed: batch.failed, conflicts: batch.conflicts,
    })
    return json({ ...batch, status: await mailCredentialMigrationStatus(env) })
  } catch {
    return json({ error: '本批迁移未完成，已处理的数据会保留，请重新检查后继续。' }, 503)
  }
}
