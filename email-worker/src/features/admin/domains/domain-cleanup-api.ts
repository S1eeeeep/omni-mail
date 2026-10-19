import type { Env, SessionUser } from '../../../app/types'
import { normalizeEmail, validEmail } from '../../../shared/http/api-helpers'
import { activeDomainCleanup, pathDomain, validDomainName } from './domain-api'
import { cleanupJob, cleanupProgress, dispatchDomainCleanup, validJobId } from './domain-cleanup-store'

const json = (error: string, status: number) => Response.json({ error }, { status })

async function input(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('Content-Length')) > 16384) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 16384) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    const body: unknown = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch { return null } finally { reader.releaseLock() }
}

export async function previewDomainCleanup(env: Env, user: SessionUser, encoded: string, request: Request): Promise<Response> {
  if (user.role !== 'super_admin') return json('只有主管理员可以批量清理关联邮箱。', 403)
  const name = pathDomain(encoded)
  const body = await input(request)
  if (!validDomainName(name) || !body || typeof body.mode !== 'string' || !['selected', 'all_and_remove'].includes(body.mode)) return json('清理参数无效。', 400)
  const mode = body.mode as 'selected' | 'all_and_remove'
  let addresses: string[] = []
  if (mode === 'selected') {
    if (!Array.isArray(body.addresses) || !body.addresses.length || body.addresses.length > 100
      || body.addresses.some((address) => typeof address !== 'string' || address.length > 254)) return json('请选择 1 至 100 个有效邮箱。', 400)
    addresses = [...new Set(body.addresses.map((address: string) => normalizeEmail(address)))]
    if (addresses.some((address) => !validEmail(address) || address.slice(address.lastIndexOf('@') + 1) !== name)) return json('所选邮箱必须属于当前域名。', 400)
  }
  if (await activeDomainCleanup(env, name)) return json('该域名正在清理，请等待任务完成。', 409)
  const id = crypto.randomUUID()
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO domain_cleanup_jobs (id, domain_name, mode, requested_by, previous_active, expires_at)
       SELECT ?, name, ?, ?, is_active, unixepoch() + 600 FROM domains WHERE name = ?`,
    ).bind(id, mode, user.id, name),
    env.DB.prepare(
      `INSERT INTO domain_cleanup_items (job_id, address, user_id, previous_active)
       SELECT ?, m.address, m.user_id, m.is_active FROM mailboxes m
       WHERE LOWER(SUBSTR(m.address, INSTR(m.address, '@') + 1)) = ?
         AND (? = 'all_and_remove' OR m.address IN (SELECT value FROM json_each(?)))
         AND EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE id = ?)`,
    ).bind(id, name, mode, JSON.stringify(addresses), id),
  ])
  if (!results[0].meta.changes) return json('域名不存在。', 404)
  const blocked = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM domain_cleanup_items i JOIN mailboxes m ON m.address = i.address
     WHERE i.job_id = ? AND (m.is_primary = 1 OR m.is_hidden = 1 OR m.cleanup_job_id IS NOT NULL)`,
  ).bind(id).first<{ count: number }>()
  if (!results[1].meta.changes || (mode === 'selected' && results[1].meta.changes !== addresses.length) || blocked?.count) {
    await env.DB.prepare('DELETE FROM domain_cleanup_jobs WHERE id = ?').bind(id).run()
    return json('目标中包含主邮箱、正在清理或不存在的邮箱，请先处理后重新预览。', 409)
  }
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS mailboxCount, COUNT(DISTINCT user_id) AS userCount,
       COALESCE(SUM((SELECT COUNT(*) FROM messages WHERE mailbox_address = i.address)), 0) AS messageCount,
       COALESCE(SUM((SELECT COUNT(*) FROM mail_drafts WHERE mailbox_address = i.address)), 0) AS draftCount,
       COALESCE(SUM((SELECT COUNT(*) FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.mailbox_address = i.address)
         + (SELECT COUNT(*) FROM mail_draft_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.mailbox_address = i.address)), 0) AS attachmentCount,
       COALESCE(SUM((SELECT COALESCE(SUM(quota_bytes), 0) FROM messages WHERE mailbox_address = i.address)
         + (SELECT COALESCE(SUM(a.size), 0) FROM mail_draft_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.mailbox_address = i.address)), 0) AS bytes
     FROM domain_cleanup_items i WHERE job_id = ?`,
  ).bind(id).first<Record<string, number>>()
  const unassigned = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM messages WHERE mailbox_address = '__unassigned__@omnimail.invalid'
     AND LOWER(SUBSTR(delivered_to, INSTR(delivered_to, '@') + 1)) = ?`,
  ).bind(name).first<{ count: number }>()
  const preview = { ...summary, unassignedMessageCount: unassigned?.count || 0 }
  await env.DB.prepare('UPDATE domain_cleanup_jobs SET summary_json = ? WHERE id = ?').bind(JSON.stringify(preview), id).run()
  return Response.json({ jobId: id, expiresAt: Math.floor(Date.now() / 1000) + 600, summary: preview })
}

export async function submitDomainCleanup(env: Env, user: SessionUser, encoded: string, request: Request, ip: string): Promise<Response> {
  if (user.role !== 'super_admin') return json('只有主管理员可以批量清理关联邮箱。', 403)
  const name = pathDomain(encoded)
  const body = await input(request)
  if (!validDomainName(name) || !body || !validJobId(body.jobId) || body.confirmDomain !== name) return json('请输入完整域名确认清理。', 400)
  const job = await cleanupJob(env, body.jobId)
  if (!job || job.domain_name !== name || job.requested_by !== user.id) return json('清理预览不存在。', 404)
  if (!env.CLEANUP_WORKFLOW) return json('邮箱删除服务暂时不可用，请稍后重试。', 503)
  if (job.status === 'preview') {
    try {
      await env.DB.batch([
        // 先冻结配置，再提交任务；任一校验失败由同一事务恢复全部修改。
        env.DB.prepare(
          `UPDATE domains SET is_active = 0, updated_at = unixepoch() WHERE name = ? AND ? = 'all_and_remove'
           AND EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE id = ? AND status = 'preview')`,
        ).bind(name, job.mode, job.id),
        env.DB.prepare(`UPDATE domain_cleanup_jobs SET status = 'pending', updated_at = unixepoch() WHERE id = ? AND status = 'preview'`).bind(job.id),
        env.DB.prepare(
          `UPDATE mailboxes SET is_active = 0, is_hidden = 1, cleanup_job_id = ?
           WHERE address IN (SELECT address FROM domain_cleanup_items WHERE job_id = ?) AND cleanup_job_id IS NULL
             AND EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE id = ? AND status = 'pending')`,
        ).bind(job.id, job.id, job.id),
        env.DB.prepare(
          `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
           SELECT ?, 'domain.cleanup_scheduled', ?, ?, ? WHERE changes() > 0`,
        ).bind(user.id, name, ip, JSON.stringify({ jobId: job.id, mode: job.mode })),
      ])
    } catch {
      const current = await cleanupJob(env, job.id)
      if (!current || current.status === 'preview') return json('邮箱数据或清理状态已变化，请重新预览。', 409)
    }
  }
  // 预览可能被过期回收；相关冻结与审计同样受事务内的任务状态约束，不能留下半次提交。
  const current = await cleanupJob(env, job.id)
  if (!current) return json('邮箱数据或清理状态已变化，请重新预览。', 409)
  if (current.status === 'pending') {
    try { await dispatchDomainCleanup(env, current) } catch { /* 意图已持久化，由调度恢复，客户端也可以重试。 */ }
  }
  return Response.json({ jobId: job.id, status: current.status }, { status: 202 })
}

export async function domainCleanupStatus(env: Env, user: SessionUser, id: string): Promise<Response> {
  if (user.role !== 'super_admin') return json('只有主管理员可以查看清理任务。', 403)
  if (!validJobId(id)) return json('任务编号无效。', 400)
  const job = await cleanupJob(env, id)
  if (!job || job.status === 'preview') return json('清理任务不存在。', 404)
  return Response.json({ job: await cleanupProgress(env, job) })
}

export async function retryDomainCleanup(env: Env, user: SessionUser, id: string, ip: string): Promise<Response> {
  if (user.role !== 'super_admin') return json('只有主管理员可以重试清理任务。', 403)
  if (!validJobId(id)) return json('任务编号无效。', 400)
  const job = await cleanupJob(env, id)
  if (!job || job.status === 'preview') return json('清理任务不存在。', 404)
  if (!env.CLEANUP_WORKFLOW) return json('邮箱删除服务暂时不可用，请稍后重试。', 503)
  if (job.status === 'failed') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE domain_cleanup_jobs SET status = 'pending', attempt = attempt + 1, error_code = '', updated_at = unixepoch() WHERE id = ? AND status = 'failed'`).bind(id),
      env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json) VALUES (?, 'domain.cleanup_retry', ?, ?, ?)`).bind(user.id, job.domain_name, ip, JSON.stringify({ jobId: id })),
    ])
  }
  const current = (await cleanupJob(env, id))!
  if (current.status === 'pending') {
    try { await dispatchDomainCleanup(env, current) } catch { return json('任务已保存，后台派发暂时失败，请稍后重试。', 503) }
  }
  return Response.json({ jobId: id, status: current.status }, { status: 202 })
}
