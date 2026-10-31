import PostalMime from 'postal-mime'
import type { Env, StoredBody } from '../../app/types'
import { pushSnapshot, routingHeaders } from './push-snapshot'

export async function backfillMailPush(env: Env, subscription: string, mailbox: string): Promise<boolean> {
  const route = await env.DB.prepare(`SELECT initialized,backfill_since,backfill_created,backfill_id
    FROM mail_push_routes WHERE subscription_id=? AND mailbox_address=? AND enabled=1`)
    .bind(subscription, mailbox).first<{ initialized: number; backfill_since: number; backfill_created: number; backfill_id: string }>()
  if (!route || route.initialized) return true
  const { results } = await env.DB.prepare(`SELECT id,created_at,status,body_key,raw_key,push_headers_json
    FROM messages WHERE mailbox_address=? AND direction='incoming' AND folder='inbox' AND created_at>=?
      AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 20`)
    .bind(mailbox, route.backfill_since, route.backfill_created, route.backfill_created, route.backfill_id)
    .all<{ id: string; created_at: number; status: string; body_key: string; raw_key: string; push_headers_json: string }>()
  const statements: D1PreparedStatement[] = []
  for (const row of results) {
    let headers = row.push_headers_json
    let text = ''
    let error = ''
    let state: 'processing' | 'ready' | 'failed' = row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : 'processing'
    if (!headers || headers === '{}') {
      const raw = row.raw_key ? await env.MAIL_BUCKET.get(row.raw_key) : null
      if (raw) headers = routingHeaders((await PostalMime.parse(await raw.arrayBuffer())).headers)
      else if (state === 'ready') { state = 'failed'; error = 'MAIL_PUSH_BACKFILL_RAW_MISSING' }
    }
    if (state === 'ready') {
      const object = row.body_key ? await env.MAIL_BUCKET.get(row.body_key) : null
      if (object) text = (await object.json<StoredBody>()).text
      else { state = 'failed'; error = 'MAIL_PUSH_BACKFILL_BODY_MISSING' }
    }
    statements.push(await pushSnapshot(env, row.id, state, text, headers, error))
  }
  const last = results.at(-1)
  statements.push(env.DB.prepare(`UPDATE mail_push_routes SET backfill_created=?,backfill_id=?,initialized=?
    WHERE subscription_id=? AND mailbox_address=?`)
    .bind(last?.created_at ?? route.backfill_created, last?.id ?? route.backfill_id, results.length < 20 ? 1 : 0, subscription, mailbox))
  await env.DB.batch(statements)
  return results.length < 20
}
