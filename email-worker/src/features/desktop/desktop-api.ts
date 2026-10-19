import type { Env, SessionUser } from '../../app/types'
import { authenticatePassword } from '../auth/session/password-login'
import { mfaEnabled, verifyMfaForLogin } from '../auth/mfa/mfa'
import { clientIp } from '../../shared/http/api-helpers'
import { writeAudit } from '../../shared/audit/audit'
import { desktopCatalog } from './desktop-catalog'
import { desktopSecret } from './desktop-secrets'

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Pragma: 'no-cache' },
  })
}

export async function listDesktopAccounts(env: Env, user: SessionUser, authKind: string) {
  if (authKind !== 'bearer') return json({ error: '此接口需要桌面设备令牌。' }, 403)
  try {
    return json({ accounts: await desktopCatalog(env, user) })
  } catch {
    return json({ error: '无法读取导入目录。' }, 503)
  }
}

export function parseDesktopSelection(body: unknown): {
  accounts: Array<{ id: string; provider: string }>
  password: string
  mfaCode: string
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (
    !Array.isArray(value.accounts) ||
    !value.accounts.length ||
    value.accounts.length > 50 ||
    typeof value.password !== 'string' ||
    !value.password ||
    value.password.length > 1024 ||
    (value.mfaCode !== undefined &&
      (typeof value.mfaCode !== 'string' || value.mfaCode.length > 128))
  )
    return null
  const accounts: Array<{ id: string; provider: string }> = []
  const seen = new Set<string>()
  for (const raw of value.accounts) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      raw.id.length > 254 ||
      typeof raw.provider !== 'string' ||
      !['omnimail', 'gmail', 'qq', 'naver', 'yandex', 'icloud', 'microsoft', 'linuxdo'].includes(
        raw.provider,
      )
    )
      return null
    const key = JSON.stringify([raw.provider, raw.id])
    if (seen.has(key)) return null
    seen.add(key)
    accounts.push({ id: raw.id, provider: raw.provider })
  }
  return {
    accounts,
    password: value.password,
    mfaCode: typeof value.mfaCode === 'string' ? value.mfaCode : '',
  }
}

export async function exportDesktopCredentials(
  env: Env,
  user: SessionUser,
  request: Request,
  authKind: string,
) {
  if (authKind !== 'bearer') return json({ error: '此接口需要桌面设备令牌。' }, 403)
  // 先限制流读取，不能只信任可缺失或伪造的 Content-Length。
  const reader = request.body?.getReader()
  if (!reader) return json({ error: '缺少导入请求。' }, 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > 32 * 1024) {
        await reader.cancel()
        return json({ error: '导入请求过大。' }, 413)
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(data))
  } catch {
    return json({ error: '导入参数无效。' }, 400)
  } finally {
    data.fill(0)
  }
  const body = parseDesktopSelection(parsed)
  if (!body) return json({ error: '导入参数无效。' }, 400)
  const ip = clientIp(request.headers)
  // 设备令牌单独不足以导出密码；每次导出都重新验证当前用户的密码和 MFA。
  const login = await authenticatePassword(env.DB, user.email, body.password, ip)
  if ('error' in login || login.user.id !== user.id) {
    await writeAudit(env, user.id, 'desktop.export_denied', user.id, ip, {})
    return json({ error: '身份验证失败。' }, 'error' in login ? login.status : 403)
  }
  if (await mfaEnabled(env.DB, user.id)) {
    const verified = await verifyMfaForLogin(env, user.id, body.mfaCode, ip)
    if (!verified.ok) return json({ error: '二次验证失败。' }, verified.rateLimited ? 429 : 403)
  }
  try {
    const catalog = await desktopCatalog(env, user)
    const selected = body.accounts.map((item) =>
      catalog.find(
        (account) => account.provider === item.provider && account.id === item.id && account.ready,
      ),
    )
    if (selected.some((item) => !item))
      return json({ error: '所选账号不存在、不属于当前用户或不可导入。' }, 403)
    const accounts = []
    for (const account of selected) {
      if (account) accounts.push(await desktopSecret(env, user.id, account))
    }
    await writeAudit(env, user.id, 'desktop.credentials_exported', user.id, ip, {
      count: accounts.length,
    })
    return json({ accounts })
  } catch {
    return json({ error: '无法读取所选邮箱凭据。' }, 503)
  }
}
