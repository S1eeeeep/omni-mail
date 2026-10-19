import type { Env, SessionUser } from '../../../app/types'

interface DomainRow {
  name: string
  is_active: number
  mailbox_count: number
  created_at: number
  updated_at: number
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function isAdministrator(user: SessionUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin'
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

export function validDomainName(value: string): boolean {
  if (!value || value.length > 253 || value.includes('@')) return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
  ))
}

export function pathDomain(encoded: string): string {
  try {
    return normalizeDomain(decodeURIComponent(encoded))
  } catch {
    return ''
  }
}

function domainJson(row: DomainRow) {
  return {
    name: row.name,
    isActive: Boolean(row.is_active),
    mailboxCount: row.mailbox_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function audit(
  env: Env,
  userId: string,
  action: string,
  domain: string,
  ip: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
     VALUES (?, ?, ?, ?, '{}')`,
  ).bind(userId, action, domain, ip).run()
}

async function domainRow(env: Env, name: string): Promise<DomainRow | null> {
  return env.DB.prepare(
    `SELECT d.name, d.is_active, d.created_at, d.updated_at,
            (SELECT COUNT(*) FROM mailboxes m
              WHERE LOWER(SUBSTR(m.address, INSTR(m.address, '@') + 1)) = d.name
            ) AS mailbox_count
       FROM domains d
      WHERE d.name = ?`,
  ).bind(name).first<DomainRow>()
}

export async function listDomains(env: Env, user: SessionUser): Promise<Response> {
  const condition = isAdministrator(user) ? '' : 'WHERE d.is_active = 1'
  const { results } = await env.DB.prepare(
    `SELECT d.name, d.is_active, d.created_at, d.updated_at,
            (SELECT COUNT(*) FROM mailboxes m
              WHERE LOWER(SUBSTR(m.address, INSTR(m.address, '@') + 1)) = d.name
            ) AS mailbox_count
       FROM domains d
       ${condition}
      ORDER BY d.is_active DESC, d.name`,
  ).all<DomainRow>()
  return json({ domains: results.map(domainJson) })
}

export async function createDomain(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  if (!isAdministrator(user)) return json({ error: '只有管理员可以添加域名。' }, 403)
  const body = await request.json<{ name?: string }>()
    .catch(() => ({} as { name?: string }))
  const name = normalizeDomain(typeof body?.name === 'string' ? body.name : '')
  if (!validDomainName(name)) return json({ error: '请输入有效的域名。' }, 400)

  try {
    await env.DB.prepare(
      `INSERT INTO domains (name, is_active, created_by)
       VALUES (?, 1, ?)`,
    ).bind(name, user.id).run()
  } catch (error) {
    if (error instanceof Error && error.message.includes('domain_cleanup_in_progress')) {
      return json({ error: '该域名正在清理，请等待任务完成。' }, 409)
    }
    return json({ error: '这个域名已经存在。' }, 409)
  }
  await audit(env, user.id, 'domain.create', name, ip)
  const created = await domainRow(env, name)
  return json({ domain: created && domainJson(created) }, 201)
}

export async function updateDomain(
  env: Env,
  user: SessionUser,
  encodedName: string,
  request: Request,
  ip: string,
): Promise<Response> {
  if (!isAdministrator(user)) return json({ error: '只有管理员可以设置域名。' }, 403)
  const name = pathDomain(encodedName)
  const body = await request.json<{ isActive?: boolean }>()
    .catch(() => ({} as { isActive?: boolean }))
  if (!validDomainName(name)) return json({ error: '域名格式无效。' }, 400)
  if (typeof body?.isActive !== 'boolean') return json({ error: '缺少域名状态。' }, 400)
  if (await activeDomainCleanup(env, name)) return json({ error: '该域名正在清理，请等待任务完成。' }, 409)

  const result = await env.DB.prepare(
    `UPDATE domains
        SET is_active = ?, updated_at = unixepoch()
      WHERE name = ?`,
  ).bind(Number(body.isActive), name).run()
  if (!result.meta.changes) return json({ error: '域名不存在。' }, 404)
  await audit(env, user.id, body.isActive ? 'domain.enable' : 'domain.disable', name, ip)
  const updated = await domainRow(env, name)
  return json({ domain: updated && domainJson(updated) })
}

export async function deleteDomain(
  env: Env,
  user: SessionUser,
  encodedName: string,
  ip: string,
  mode: string | null = null,
): Promise<Response> {
  if (!isAdministrator(user)) return json({ error: '只有管理员可以删除域名。' }, 403)
  const name = pathDomain(encodedName)
  if (!validDomainName(name)) return json({ error: '域名格式无效。' }, 400)
  if (mode !== null && mode !== 'configuration') return json({ error: '域名删除模式无效。' }, 400)
  const existing = await domainRow(env, name)
  if (!existing) return json({ error: '域名不存在。' }, 404)
  if (mode !== 'configuration' && existing.mailbox_count > 0) {
    return json({ error: '该域名仍有关联邮箱，请先删除这些邮箱。' }, 409)
  }

  if (await activeDomainCleanup(env, name)) return json({ error: '该域名正在清理，请等待任务完成。' }, 409)
  const allowed = `(? = 'configuration' OR NOT EXISTS (
    SELECT 1 FROM mailboxes WHERE LOWER(SUBSTR(address, INSTR(address, '@') + 1)) = ?
  ))`
  let results: D1Result[]
  try { results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM temporary_invites WHERE domain_name = ? AND ${allowed}`,
    ).bind(name, mode || 'empty', name),
    env.DB.prepare(
      `DELETE FROM domains WHERE name = ? AND ${allowed}`,
    ).bind(name, mode || 'empty', name),
    env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
       SELECT ?, 'domain.delete', ?, ?, ? WHERE ${allowed}`,
    ).bind(user.id, name, ip, JSON.stringify({ mode: mode || 'empty', retainedMailboxes: existing.mailbox_count }), mode || 'empty', name),
  ]) } catch (error) {
    if (error instanceof Error && error.message.includes('domain_cleanup_in_progress')) return json({ error: '该域名正在清理，请等待任务完成。' }, 409)
    throw error
  }
  if (!results[1].meta.changes) return json({ error: '域名或关联邮箱已变化，请刷新后重试。' }, 409)
  return json({ ok: true })
}

export async function activeDomainCleanup(env: Env, name: string): Promise<boolean> {
  const job = await env.DB.prepare(
    `SELECT id FROM domain_cleanup_jobs WHERE domain_name = ? AND status NOT IN ('preview', 'completed') LIMIT 1`,
  ).bind(name).first()
  return Boolean(job)
}
