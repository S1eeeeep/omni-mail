import type { Env, SessionUser } from '../../../app/types'
import { parsePageRequest, pageResult } from '../../../shared/http/pagination'
import { pathDomain, validDomainName } from './domain-api'

export async function domainMailboxes(env: Env, user: SessionUser, encoded: string, request: Request): Promise<Response> {
  if (!['admin', 'super_admin'].includes(user.role)) return Response.json({ error: '只有管理员可以查看关联邮箱。' }, { status: 403 })
  const name = pathDomain(encoded)
  const page = parsePageRequest(request, 1, 50)
  if (!validDomainName(name) || !page || (page.cursor && typeof page.cursor.values[0] !== 'string')) {
    return Response.json({ error: '域名或分页参数无效。' }, { status: 400 })
  }
  const { results } = await env.DB.prepare(
    `SELECT m.address, m.user_id, u.email, u.display_name, m.is_primary, m.is_active, m.is_hidden,
            m.cleanup_job_id, COALESCE(d.is_active, 0) AS domain_active
     FROM mailboxes m JOIN users u ON u.id = m.user_id
     LEFT JOIN domains d ON d.name = ?
     WHERE LOWER(SUBSTR(m.address, INSTR(m.address, '@') + 1)) = ? AND m.address > ?
     ORDER BY m.address LIMIT ?`,
  ).bind(name, name, page.cursor?.values[0] || '', page.limit + 1).all<{
    address: string; user_id: string; email: string; display_name: string
    is_primary: number; is_active: number; is_hidden: number; cleanup_job_id: string | null; domain_active: number
  }>()
  const result = pageResult(results, page.limit, (row) => [row.address])
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(is_primary), 0) AS primaryCount,
       COALESCE(SUM(is_hidden), 0) AS cleaningCount FROM mailboxes
     WHERE LOWER(SUBSTR(address, INSTR(address, '@') + 1)) = ?`,
  ).bind(name).first()
  const job = await env.DB.prepare(
    `SELECT id, status FROM domain_cleanup_jobs WHERE domain_name = ? AND status NOT IN ('preview', 'completed') LIMIT 1`,
  ).bind(name).first()
  return Response.json({
    mailboxes: result.items.map((row) => ({
      address: row.address, userId: row.user_id, userEmail: row.email, displayName: row.display_name,
      isPrimary: Boolean(row.is_primary), isActive: Boolean(row.is_active),
      domainActive: Boolean(row.domain_active), isCleaning: Boolean(row.is_hidden),
    })),
    page: result.page, totals, activeJob: user.role === 'super_admin' ? job : null,
  })
}
