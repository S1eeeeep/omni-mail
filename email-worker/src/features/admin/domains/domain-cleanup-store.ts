import type { Env } from '../../../app/types'

export interface DomainCleanupRow {
  id: string; domain_name: string; mode: 'selected' | 'all_and_remove'; requested_by: string
  status: 'preview' | 'pending' | 'running' | 'waiting_for_objects' | 'failed' | 'completed'
  previous_active: number; attempt: number; error_code: string; summary_json: string; expires_at: number
}

export const validJobId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)

export async function cleanupJob(env: Env, id: string): Promise<DomainCleanupRow | null> {
  return env.DB.prepare('SELECT * FROM domain_cleanup_jobs WHERE id = ?').bind(id).first<DomainCleanupRow>()
}

export async function cleanupProgress(env: Env, job: DomainCleanupRow) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS completed
     FROM domain_cleanup_items WHERE job_id = ?`,
  ).bind(job.id).first<{ total: number; completed: number }>()
  const objects = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM domain_cleanup_objects o
     JOIN pending_object_deletions p ON p.object_key = o.object_key WHERE o.job_id = ?`,
  ).bind(job.id).first<{ count: number }>()
  return {
    id: job.id, domain: job.domain_name, mode: job.mode, status: job.status,
    error: job.error_code ? '清理未完成，请重试；已完成的数据不会恢复。' : '',
    summary: JSON.parse(job.summary_json), total: row?.total || 0, completed: row?.completed || 0,
    objectsPending: objects?.count || 0,
  }
}

export async function dispatchDomainCleanup(env: Env, job: DomainCleanupRow): Promise<void> {
  if (!env.CLEANUP_WORKFLOW) throw new Error('Cleanup workflow unavailable')
  const id = `domain-cleanup-${job.id}-${job.attempt}`
  try {
    await env.CLEANUP_WORKFLOW.create({ id, params: {
      startedAt: Math.floor(Date.now() / 1000), domainCleanup: { jobId: job.id, attempt: job.attempt },
    } })
  } catch (error) {
    // 创建成功但响应丢失时，核对确定的实例身份，不能创建第二份清理任务。
    let status: string
    try { status = (await (await env.CLEANUP_WORKFLOW.get(id)).status()).status } catch { throw error }
    if (['errored', 'terminated', 'complete'].includes(status)) {
      // 实例存在并不代表仍会接管待派发任务；终态失败必须允许新尝试恢复。
      await env.DB.prepare(
        `UPDATE domain_cleanup_jobs SET status = 'failed', error_code = 'dispatch_failed', updated_at = unixepoch()
         WHERE id = ? AND attempt = ? AND status = 'pending'`,
      ).bind(job.id, job.attempt).run()
      throw error
    }
  }
}

export async function recoverDomainCleanupDispatch(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM domain_cleanup_jobs WHERE status = 'pending' ORDER BY updated_at LIMIT 10`,
  ).all<DomainCleanupRow>()
  for (const job of results) {
    try { await dispatchDomainCleanup(env, job) } catch { /* 下次调度或页面重试继续派发。 */ }
  }
  await env.DB.prepare(`DELETE FROM domain_cleanup_jobs WHERE status = 'preview' AND expires_at < unixepoch()`).run()
}
