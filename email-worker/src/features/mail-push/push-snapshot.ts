import type { Env } from '../../app/types'

export type PushState = 'processing' | 'ready' | 'failed'
const routingNames = ['x-icloud-hme', 'x-original-to', 'x-apple-original-to', 'to', 'cc']

export function routingHeaders(headers: Headers | { key: string; value: string }[]): string {
  const result: Record<string, string[]> = {}
  const entries = headers instanceof Headers
    ? routingNames.flatMap((name) => headers.has(name) ? [[name, headers.get(name)!]] : [])
    : headers.filter((h) => routingNames.includes(h.key.toLowerCase())).map((h) => [h.key.toLowerCase(), h.value])
  for (const [name, value] of entries) {
    const clean = value.replace(/\r?\n[\t ]+/g, ' ')
    if (/[\r\n\0]/.test(clean) || clean.length > 16384) throw new Error('MAIL_PUSH_INVALID_ROUTE_HEADERS')
    ;(result[name] ??= []).push(clean)
  }
  const serialized = JSON.stringify(result)
  if (serialized.length > 65536) throw new Error('MAIL_PUSH_INVALID_ROUTE_HEADERS')
  return serialized
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
}

// The immutable snapshot and the mail transition are committed in the same D1
// batch. Pending delivery no longer depends on a surviving mail/R2 object.
export async function pushSnapshot(
  env: Env, messageId: string, kind: PushState, text = '', headers = '', error = '',
): Promise<D1PreparedStatement> {
  const oversized = new TextEncoder().encode(JSON.stringify(text)).byteLength > 512 * 1024
  const state = oversized ? 'failed' : kind
  const content = oversized ? '' : text
  const textHash = kind === 'ready' && !oversized ? await digest(content) : ''
  return env.DB.prepare(`INSERT OR IGNORE INTO mail_push_outbox
    (subscription_id,mailbox_address,message_id,event_kind,payload_json)
    SELECT r.subscription_id,m.mailbox_address,m.id,?,json_object(
      'message_id',m.id,'mailbox',m.mailbox_address,'state',?,
      'received_at',m.created_at*1000,'message_date',COALESCE(m.received_at,m.created_at)*1000,
      'headers',json(CASE WHEN ?<>'' THEN ? ELSE m.push_headers_json END),
      'recipients',json(m.recipients_json),'sender',m.sender_address,
      'subject',m.subject,'text',?,'text_hash',?,'error_code',?)
    FROM messages m JOIN mail_push_routes r ON r.mailbox_address=m.mailbox_address AND r.enabled=1
    JOIN mail_push_subscriptions s ON s.id=r.subscription_id AND s.enabled=1
    JOIN mailboxes mb ON mb.address=m.mailbox_address AND mb.user_id=s.user_id
    WHERE m.id=? AND m.direction='incoming' AND m.folder='inbox'`)
    .bind(kind, state, headers, headers, content, textHash,
      oversized ? 'MAIL_PUSH_BODY_TOO_LARGE' : error, messageId)
}
