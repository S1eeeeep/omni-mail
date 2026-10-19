import type { Env } from '../../../app/types'
import { purgeMailboxDrafts } from '../../drafts/draft-api'
import { deleteStagedObjects } from '../../messages/message-storage'
import { CLEANUP_BATCH_SIZE, purgeMailboxMessagesBatch } from '../../../platform/scheduling/cleanup'
import { cleanupJob } from './domain-cleanup-store'

export async function runDomainCleanupBatch(env: Env, id: string, attempt: number): Promise<boolean> {
  const job = await cleanupJob(env, id)
  if (!job || job.attempt !== attempt || ['preview', 'failed', 'completed'].includes(job.status)) return true
  const item = await env.DB.prepare(
    `SELECT address, user_id, objects_captured FROM domain_cleanup_items WHERE job_id = ? AND status = 'pending' ORDER BY address LIMIT 1`,
  ).bind(id).first<{ address: string; user_id: string; objects_captured: number }>()
  if (item) {
    const owner = await env.DB.prepare(
      `SELECT 1 AS owned FROM mailboxes WHERE address = ? AND user_id = ? AND cleanup_job_id = ? AND is_hidden = 1 AND is_primary = 0`,
    ).bind(item.address, item.user_id, id).first()
    if (!owner) throw new Error('cleanup_target_changed')
    if (!item.objects_captured) await env.DB.batch([env.DB.prepare(
      `INSERT OR IGNORE INTO domain_cleanup_objects (job_id, object_key)
       SELECT ?, object_key FROM (
         SELECT raw_key AS object_key FROM messages WHERE mailbox_address = ?
         UNION SELECT body_key FROM messages WHERE mailbox_address = ?
         UNION SELECT a.r2_key FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.mailbox_address = ?
         UNION SELECT t.r2_key FROM message_translations t JOIN messages m ON m.id = t.message_id WHERE m.mailbox_address = ?
         UNION SELECT a.r2_key FROM mail_draft_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.mailbox_address = ?
       ) WHERE object_key IS NOT NULL`,
    ).bind(id, item.address, item.address, item.address, item.address, item.address),
      env.DB.prepare('UPDATE domain_cleanup_items SET objects_captured = 1 WHERE job_id = ? AND address = ?').bind(id, item.address),
    ])
    await env.DB.prepare(`UPDATE domain_cleanup_jobs SET status = 'running', updated_at = unixepoch() WHERE id = ? AND attempt = ?`).bind(id, attempt).run()
    const count = await purgeMailboxMessagesBatch(env, item.user_id, item.address)
    if (count >= CLEANUP_BATCH_SIZE) return false
    await purgeMailboxDrafts(env, item.user_id, item.address)
    // 配额和对象待办由既有删除服务处理；最后一笔数据库操作可安全重复执行。
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM mailboxes WHERE address = ? AND user_id = ? AND cleanup_job_id = ? AND is_primary = 0`).bind(item.address, item.user_id, id),
      env.DB.prepare(`UPDATE domain_cleanup_items SET status = 'completed' WHERE job_id = ? AND address = ?`).bind(id, item.address),
    ])
    return false
  }
  const { results: objects } = await env.DB.prepare(
    `SELECT o.object_key FROM domain_cleanup_objects o JOIN pending_object_deletions p ON p.object_key = o.object_key
     WHERE o.job_id = ? LIMIT 100`,
  ).bind(id).all<{ object_key: string }>()
  if (objects.length) {
    await env.DB.prepare(`UPDATE domain_cleanup_jobs SET status = 'waiting_for_objects', updated_at = unixepoch() WHERE id = ? AND attempt = ?`).bind(id, attempt).run()
    await deleteStagedObjects(env, objects.map((object) => object.object_key))
    const remaining = await env.DB.prepare(
      `SELECT 1 FROM pending_object_deletions WHERE object_key IN (SELECT value FROM json_each(?)) LIMIT 1`,
    ).bind(JSON.stringify(objects.map((object) => object.object_key))).first()
    if (remaining) throw new Error('cleanup_objects_pending')
    return false
  }
  if (job.mode === 'all_and_remove') {
    const remaining = await env.DB.prepare(
      `SELECT 1 FROM mailboxes WHERE LOWER(SUBSTR(address, INSTR(address, '@') + 1)) = ? LIMIT 1`,
    ).bind(job.domain_name).first()
    if (remaining) throw new Error('cleanup_domain_not_empty')
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE domain_cleanup_jobs SET status = 'completed', error_code = '', updated_at = unixepoch() WHERE id = ? AND attempt = ?`).bind(id, attempt),
    ...(job.mode === 'all_and_remove' ? [
      env.DB.prepare('DELETE FROM temporary_invites WHERE domain_name = ?').bind(job.domain_name),
      env.DB.prepare('DELETE FROM domains WHERE name = ?').bind(job.domain_name),
    ] : []),
    env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
       VALUES ((SELECT id FROM users WHERE id = ?), 'domain.cleanup_completed', ?, 'workflow', ?)`,
    ).bind(job.requested_by, job.domain_name, JSON.stringify({ jobId: id, mode: job.mode })),
  ])
  return true
}
