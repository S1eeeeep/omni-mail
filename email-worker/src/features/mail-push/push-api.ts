import type { Env, SessionUser } from '../../app/types'
import { encryptMailCredential, mailCredentialsReady } from '../../shared/security/mail-credentials'
import { digest } from './push-snapshot'

function validCallback(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && (!url.port || url.port === '443') && url.pathname === '/api/integrations/omnimail/events'
      && url.hostname.includes('.') && !/^[\d.]+$/.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)
  } catch { return false }
}

export async function configureMailPush(env: Env, user: SessionUser, request: Request): Promise<Response> {
  if (Number(request.headers.get('Content-Length') || 0) > 256 * 1024) return new Response(null, { status: 413 })
  const body = await request.json<{ id: string; secret: string; callback_url: string; mailboxes: string[] }>().catch(() => null)
  if (!body || !/^[a-f0-9-]{36}$/.test(body.id) || !/^[A-Za-z0-9_-]{43}$/.test(body.secret)
    || !validCallback(body.callback_url) || !Array.isArray(body.mailboxes) || body.mailboxes.length > 1000
    || body.mailboxes.some((m) => typeof m !== 'string' || m.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(m))) {
    return Response.json({ error: 'MAIL_PUSH_INVALID_CONFIG' }, { status: 400 })
  }
  if (!mailCredentialsReady(env, 'ICLOUD_CREDENTIALS_KEY')) return Response.json({ error: 'MAIL_PUSH_KEY_UNAVAILABLE' }, { status: 503 })
  const mailboxes = [...new Set(body.mailboxes.map((m) => m.trim().toLowerCase()))].sort()
  const existing = await env.DB.prepare('SELECT user_id,secret_hash,callback_url FROM mail_push_subscriptions WHERE id=?')
    .bind(body.id).first<{ user_id: string; secret_hash: string; callback_url: string }>()
  if (existing && existing.user_id !== user.id) return new Response(null, { status: 403 })
  for (let offset = 0; offset < mailboxes.length; offset += 80) {
    const part = mailboxes.slice(offset, offset + 80)
    const found = await env.DB.prepare(`SELECT address FROM mailboxes WHERE user_id=? AND is_hidden=0 AND address IN (${part.map(() => '?').join(',')})`)
      .bind(user.id, ...part).all<{ address: string }>()
    if (found.results.length !== part.length) return Response.json({ error: 'MAIL_PUSH_MAILBOX_NOT_OWNED' }, { status: 403 })
  }
  const hash = await digest(body.secret)
  const cipher = await encryptMailCredential(env, 'ICLOUD_CREDENTIALS_KEY', body.secret, `${user.id}:${body.id}:mail-push`)
  const statements = [
    env.DB.prepare('UPDATE mail_push_subscriptions SET enabled=0,updated_at=unixepoch() WHERE user_id=? AND id<>?').bind(user.id, body.id),
    env.DB.prepare(`INSERT INTO mail_push_subscriptions(id,user_id,callback_url,secret_cipher,secret_hash)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=1,callback_url=excluded.callback_url,
      secret_cipher=CASE WHEN secret_hash<>excluded.secret_hash THEN excluded.secret_cipher ELSE secret_cipher END,
      secret_hash=excluded.secret_hash,updated_at=unixepoch() WHERE user_id=excluded.user_id`)
      .bind(body.id, user.id, body.callback_url, cipher, hash),
    env.DB.prepare(`UPDATE mail_push_routes SET enabled=0 WHERE subscription_id=? AND mailbox_address NOT IN (SELECT value FROM json_each(?))`)
      .bind(body.id, JSON.stringify(mailboxes)),
    env.DB.prepare(`INSERT INTO mail_push_routes(subscription_id,mailbox_address)
      SELECT ?,value FROM json_each(?) WHERE true
      ON CONFLICT(subscription_id,mailbox_address) DO UPDATE SET enabled=1`).bind(body.id, JSON.stringify(mailboxes)),
  ]
  if (!existing || existing.secret_hash !== hash || existing.callback_url !== body.callback_url) {
    statements.push(env.DB.prepare(`INSERT INTO audit_logs(user_id,action,target_id,ip,detail_json)
      VALUES(?,'mail_push.configure',?,'','{}')`).bind(user.id, body.id))
  }
  await env.DB.batch(statements)
  return Response.json({ status: 'configured', subscription_id: body.id, mailboxes: mailboxes.length })
}

export async function retryMailPush(env: Env, user: SessionUser): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE mail_push_outbox SET status='pending',attempts=0,next_attempt_at=0,last_error_code=''
      WHERE (status='failed' OR (status='pending' AND last_error_code<>''))
      AND subscription_id IN(SELECT id FROM mail_push_subscriptions WHERE user_id=? AND enabled=1)`).bind(user.id),
    env.DB.prepare(`UPDATE mail_push_routes SET enqueued_at=0 WHERE subscription_id IN(SELECT id FROM mail_push_subscriptions WHERE user_id=? AND enabled=1)`).bind(user.id),
    env.DB.prepare("INSERT INTO audit_logs(user_id,action,ip,detail_json) VALUES(?,'mail_push.retry','','{}')").bind(user.id),
  ])
  return Response.json({ status: 'queued' })
}

export async function mailPushStatus(env: Env, user: SessionUser): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT r.mailbox_address,r.initialized,r.next_sequence,r.enqueued_at,
    r.lease_until,r.last_sent_at,r.last_error_code,
    (SELECT count(*) FROM mail_push_outbox e WHERE e.subscription_id=r.subscription_id AND e.mailbox_address=r.mailbox_address AND e.status='pending') AS pending_events,
    (SELECT count(*) FROM mail_push_outbox e WHERE e.subscription_id=r.subscription_id AND e.mailbox_address=r.mailbox_address AND e.status='failed') AS failed_events
    FROM mail_push_routes r JOIN mail_push_subscriptions s ON s.id=r.subscription_id
    WHERE s.user_id=? AND s.enabled=1 AND r.enabled=1 ORDER BY r.mailbox_address`).bind(user.id).all()
  return Response.json({ queue_configured: Boolean(env.MAIL_PUSH_QUEUE), now: Math.floor(Date.now() / 1000), routes: results })
}
