import type { Env, MailPushQueueJob } from '../../app/types'

async function publish(env: Env, job: MailPushQueueJob): Promise<void> {
  try { await env.MAIL_PUSH_QUEUE!.send(job) }
  catch (error) {
    await env.DB.prepare('UPDATE mail_push_routes SET enqueued_at=0 WHERE subscription_id=? AND mailbox_address=?')
      .bind(job.subscriptionId, job.mailbox).run()
    throw error
  }
}

// Called after the consumer releases its lease. A writer either sees the free
// lease and enqueues, or its committed event is found here; no minute-long gap.
export async function queueMailPushRoute(env: Env, job: MailPushQueueJob): Promise<void> {
  if (!env.MAIL_PUSH_QUEUE) return
  const claim = await env.DB.prepare(`UPDATE mail_push_routes SET enqueued_at=unixepoch()
    WHERE subscription_id=? AND mailbox_address=? AND enabled=1
    AND enqueued_at<unixepoch()-30 AND lease_until<unixepoch()
    AND subscription_id IN(SELECT s.id FROM mail_push_subscriptions s JOIN users u ON u.id=s.user_id
      JOIN mailboxes mb ON mb.user_id=s.user_id AND mb.address=mail_push_routes.mailbox_address
      WHERE s.enabled=1 AND u.status='active' AND u.deleted_at IS NULL)
    AND (initialized=0 OR EXISTS(SELECT 1 FROM mail_push_outbox e
      WHERE e.subscription_id=mail_push_routes.subscription_id AND e.mailbox_address=mail_push_routes.mailbox_address
      AND e.status='pending' AND e.next_attempt_at<=unixepoch()))`)
    .bind(job.subscriptionId, job.mailbox).run()
  if (claim.meta.changes) await publish(env, job)
}

export async function enqueueMailPush(env: Env): Promise<void> {
  if (!env.MAIL_PUSH_QUEUE) return
  const { results } = await env.DB.prepare(`SELECT r.subscription_id,r.mailbox_address FROM mail_push_routes r
    JOIN mail_push_subscriptions s ON s.id=r.subscription_id AND s.enabled=1
    JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL
    JOIN mailboxes mb ON mb.address=r.mailbox_address AND mb.user_id=s.user_id
    WHERE r.enabled=1 AND r.lease_until<unixepoch() AND r.enqueued_at<unixepoch()-30
    AND (r.initialized=0 OR r.last_sent_at<unixepoch()-60 OR EXISTS(SELECT 1 FROM mail_push_outbox e
      WHERE e.subscription_id=r.subscription_id AND e.mailbox_address=r.mailbox_address AND e.status='pending' AND e.next_attempt_at<=unixepoch()))
    ORDER BY r.last_sent_at,r.subscription_id,r.mailbox_address LIMIT 128`)
    .all<{ subscription_id: string; mailbox_address: string }>()
  for (const row of results) {
    const claim = await env.DB.prepare(`UPDATE mail_push_routes SET enqueued_at=unixepoch()
      WHERE subscription_id=? AND mailbox_address=? AND enqueued_at<unixepoch()-30 AND lease_until<unixepoch()`)
      .bind(row.subscription_id, row.mailbox_address).run()
    if (!claim.meta.changes) continue
    try { await publish(env, { subscriptionId: row.subscription_id, mailbox: row.mailbox_address }) }
    catch { /* Durable outbox remains eligible for the next arrival or cron. */ }
  }
}
