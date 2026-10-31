import type { Env, MailPushQueueJob } from '../../app/types'
import { decryptMailCredential } from '../../shared/security/mail-credentials'
import { backfillMailPush } from './push-backfill'
import { deliveryBatch, BODY_BATCH_SIZE, type PendingPush } from './push-batch'
import { queueMailPushRoute } from './push-queue'
export { enqueueMailPush } from './push-queue'

interface Route {
  subscription_id: string; mailbox_address: string; callback_url: string
  secret_cipher: string; user_id: string; next_sequence: number; initialized: number
}

async function send(env: Env, route: Route, events: Record<string, unknown>[], secret: string): Promise<Response> {
  const body = JSON.stringify({ version: 1, subscription_id: route.subscription_id, generated_at: Date.now(),
    streams: [{ mailbox: route.mailbox_address, high_water: route.next_sequence, initialized: Boolean(route.initialized) }], events })
  const delivery = crypto.randomUUID()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${delivery}\n${body}`))
  const signature = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
  return fetch(route.callback_url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: {
    'Content-Type': 'application/json', 'X-OmniMail-Subscription': route.subscription_id,
    'X-OmniMail-Timestamp': timestamp, 'X-OmniMail-Delivery': delivery, 'X-OmniMail-Signature': signature,
  } })
}

async function deliverRoute(env: Env, job: MailPushQueueJob): Promise<number> {
  const token = crypto.randomUUID()
  const acquired = await env.DB.prepare(`UPDATE mail_push_routes SET lease_token=?,lease_until=unixepoch()+110,enqueued_at=0
    WHERE subscription_id=? AND mailbox_address=? AND enabled=1 AND lease_until<unixepoch()`)
    .bind(token, job.subscriptionId, job.mailbox).run()
  if (!acquired.meta.changes) {
    const active = await env.DB.prepare(`SELECT 1 AS active FROM mail_push_routes r
      JOIN mail_push_subscriptions s ON s.id=r.subscription_id AND s.enabled=1
      WHERE r.subscription_id=? AND r.mailbox_address=? AND r.enabled=1`)
      .bind(job.subscriptionId, job.mailbox).first()
    return active ? 5 : 0
  }
  try {
    // Backfill is durable and page bounded. Its cursor cannot skip a message
    // inserted during subscription registration; realtime writes share outbox.
    const initialized = await backfillMailPush(env, job.subscriptionId, job.mailbox)
    const route = await env.DB.prepare(`SELECT r.subscription_id,r.mailbox_address,r.next_sequence,r.initialized,
      s.callback_url,s.secret_cipher,s.user_id FROM mail_push_routes r JOIN mail_push_subscriptions s ON s.id=r.subscription_id
      JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL
      JOIN mailboxes mb ON mb.address=r.mailbox_address AND mb.user_id=s.user_id
      WHERE r.subscription_id=? AND r.mailbox_address=? AND r.enabled=1 AND s.enabled=1`)
      .bind(job.subscriptionId, job.mailbox).first<Route>()
    if (!route) return 0
    const secret = await decryptMailCredential(env, 'ICLOUD_CREDENTIALS_KEY', route.secret_cipher,
      `${route.user_id}:${route.subscription_id}:mail-push`)
    const { results: announce } = await env.DB.prepare(`SELECT event_id,sequence,payload_json,announced,attempts FROM mail_push_outbox
      WHERE subscription_id=? AND mailbox_address=? AND status='pending' AND announced=0 AND next_attempt_at<=unixepoch()
      ORDER BY sequence LIMIT 128`).bind(job.subscriptionId, job.mailbox).all<PendingPush>()
    let candidates = announce
    const metadata = candidates.length > 0
    if (!metadata) candidates = (await env.DB.prepare(`SELECT event_id,sequence,payload_json,announced,attempts FROM mail_push_outbox
      WHERE subscription_id=? AND mailbox_address=? AND status='pending' AND announced=1 AND next_attempt_at<=unixepoch()
      ORDER BY sequence LIMIT ?`).bind(job.subscriptionId, job.mailbox, BODY_BATCH_SIZE).all<PendingPush>()).results
    const { rows, events } = deliveryBatch(candidates, metadata)
    // New receipts can commit between the first route read and the outbox
    // query. Never send an included sequence above its advertised watermark.
    const progress = await env.DB.prepare(`SELECT r.next_sequence,r.initialized FROM mail_push_routes r
      JOIN mail_push_subscriptions s ON s.id=r.subscription_id AND s.enabled=1
      JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL
      JOIN mailboxes mb ON mb.address=r.mailbox_address AND mb.user_id=s.user_id
      WHERE r.subscription_id=? AND r.mailbox_address=? AND r.enabled=1`)
      .bind(job.subscriptionId, job.mailbox).first<{ next_sequence: number; initialized: number }>()
    if (!progress) return 0
    route.next_sequence = progress.next_sequence
    route.initialized = progress.initialized
    let response: Response | null = null
    let error = ''
    try {
      response = await send(env, route, events, secret)
      if (!response.ok) error = `MAIL_PUSH_HTTP_${response.status}`
      else {
        const ack = await response.json<{ status?: string }>().catch(() => null)
        if (ack?.status !== 'accepted') error = 'MAIL_PUSH_INVALID_ACK'
      }
    } catch { error = 'MAIL_PUSH_NETWORK_ERROR' }
    if (error) {
      const attempt = Math.max(0, ...rows.map((r) => r.attempts)) + 1
      const retryHeader = Number(response?.headers.get('Retry-After') || 0)
      const delay = Math.max(Math.min(3600, 2 ** Math.min(attempt, 11)) + Math.floor(Math.random() * 5), Number.isFinite(retryHeader) ? Math.min(retryHeader, 3600) : 0)
      await env.DB.batch([
        env.DB.prepare(`UPDATE mail_push_outbox SET attempts=attempts+1,next_attempt_at=unixepoch()+?,
          last_error_code=?,status=CASE WHEN attempts>=19 THEN 'failed' ELSE 'pending' END
          WHERE event_id IN(SELECT value FROM json_each(?)) AND status='pending'`)
          .bind(delay, error, JSON.stringify(rows.map((r) => r.event_id))),
        env.DB.prepare('UPDATE mail_push_routes SET last_error_code=? WHERE subscription_id=? AND mailbox_address=?')
          .bind(error, job.subscriptionId, job.mailbox),
      ])
      return delay
    }
    const completed = rows.filter((_r, i) => !events[i].metadata_only).map((r) => r.event_id)
    await env.DB.batch([
      env.DB.prepare(`UPDATE mail_push_outbox SET announced=1,last_error_code=''
        WHERE event_id IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(rows.map((r) => r.event_id))),
      env.DB.prepare(`UPDATE mail_push_outbox SET status='sent',sent_at=unixepoch(),payload_json=json_remove(payload_json,'$.text')
        WHERE event_id IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(completed)),
      env.DB.prepare('UPDATE mail_push_routes SET last_sent_at=unixepoch(),last_error_code=\'\' WHERE subscription_id=? AND mailbox_address=?')
        .bind(job.subscriptionId, job.mailbox),
    ])
    if (rows.length || !initialized) return 1
    return 0
  } finally {
    await env.DB.prepare(`UPDATE mail_push_routes SET lease_until=0,lease_token='' WHERE subscription_id=? AND mailbox_address=? AND lease_token=?`)
      .bind(job.subscriptionId, job.mailbox, token).run()
  }
}

export async function consumeMailPush(batch: MessageBatch<MailPushQueueJob>, env: Env): Promise<void> {
  // A dedicated queue is capped at four consumers; each batch processes routes
  // sequentially and never fans out an unbounded set of HTTP requests.
  for (const message of batch.messages) {
    if (!message.body || typeof message.body.subscriptionId !== 'string' || typeof message.body.mailbox !== 'string') { message.ack(); continue }
    try {
      const delay = await deliverRoute(env, message.body)
      if (delay <= 1 && env.MAIL_PUSH_QUEUE) {
        // The lease has already been released. Close the arrival/empty-drain
        // race and avoid adding a final empty queue hop after a small email.
        await queueMailPushRoute(env, message.body)
        message.ack()
      } else if (delay) message.retry({ delaySeconds: delay }); else message.ack()
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      const code = detail.includes('D1_ERROR') ? 'MAIL_PUSH_D1_ERROR'
        : detail.includes('MAIL_PUSH_INVALID_ROUTE_HEADERS') ? 'MAIL_PUSH_INVALID_ROUTE_HEADERS'
          : detail.includes('credential') ? 'MAIL_PUSH_CREDENTIAL_ERROR' : 'MAIL_PUSH_DELIVERY_FAILED'
      await env.DB.prepare('UPDATE mail_push_routes SET last_error_code=? WHERE subscription_id=? AND mailbox_address=?')
        .bind(code, message.body.subscriptionId, message.body.mailbox).run()
      message.retry({ delaySeconds: 30 })
    }
  }
}
