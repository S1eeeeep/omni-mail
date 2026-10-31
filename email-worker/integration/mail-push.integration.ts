import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser, MailPushQueueJob } from '../src/app/types'
import { configureMailPush, mailPushStatus } from '../src/features/mail-push/push-api'
import { consumeMailPush, enqueueMailPush } from '../src/features/mail-push/push-delivery'
import { digest, pushSnapshot } from '../src/features/mail-push/push-snapshot'
import { parseMessage, receiveEmail } from '../src/app/handlers/mail'

const user = { id: 'push-owner', role: 'user' } as SessionUser
const mailbox = 'push-owner@example.com'
const id = '12556f6a-15f0-4d91-af71-67ec23d7ce47'
const secret = 'a'.repeat(43)
const environment = () => ({ ...env, MAIL_PUSH_QUEUE: { send: vi.fn() } }) as unknown as Env
function configuration(overrides = {}) {
  return new Request('https://mail.example.com/api/integrations/mail-push', { method: 'PUT', body: JSON.stringify({
    id, secret, callback_url: 'https://pickup.example.com/api/integrations/omnimail/events', mailboxes: [mailbox], ...overrides,
  }) })
}
function queue() {
  const ack = vi.fn(), retry = vi.fn()
  return { batch: { messages: [{ body: { subscriptionId: id, mailbox }, ack, retry }] } as unknown as MessageBatch<MailPushQueueJob>, ack, retry }
}
async function runDelivery(e = environment()) {
  await env.DB.prepare('UPDATE mail_push_routes SET lease_until=0 WHERE subscription_id=?').bind(id).run()
  const q = queue(); await consumeMailPush(q.batch, e); return q
}
async function message(messageId: string, ready = false) {
  await env.DB.prepare(`INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,recipients_json,subject,received_at,push_headers_json)
    VALUES(?,?,'incoming',?,'inbox','sender@example.net','["alias@icloud.com"]','Verification code',unixepoch(),?)`)
    .bind(messageId, mailbox, ready ? 'ready' : 'processing', JSON.stringify({ 'x-icloud-hme': [`p=alias@icloud.com; f=${mailbox}`] })).run()
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS) })
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id).run()
  await env.DB.prepare(`INSERT INTO users(id,email,display_name,password_hash) VALUES(?,?,'Push','test')`).bind(user.id, mailbox).run()
  await env.DB.prepare('INSERT INTO mailboxes(address,user_id,is_active) VALUES(?,?,1)').bind(mailbox, user.id).run()
})
afterEach(() => vi.unstubAllGlobals())

describe('durable mail push', () => {
  it('rejects unowned mailboxes and unsafe destinations without registering subscriptions', async () => {
    expect((await configureMailPush(env, user, configuration({ mailboxes: ['another@example.com'] }))).status).toBe(403)
    expect((await configureMailPush(env, user, configuration({ callback_url: 'http://127.0.0.1/api/integrations/omnimail/events' }))).status).toBe(400)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM mail_push_subscriptions').first()).toEqual({ n: 0 })
  })

  it('exposes actual queue and progress status without credentials or content', async () => {
    await configureMailPush(env, user, configuration())
    const response = await mailPushStatus(environment(), user)
    const raw = await response.text()
    const status = JSON.parse(raw)
    expect(status.queue_configured).toBe(true)
    expect(status.routes).toHaveLength(1)
    expect(status.routes[0]).toMatchObject({ initialized: 0, pending_events: 0, last_error_code: '' })
    expect(raw).not.toContain(secret)
    expect((await (await mailPushStatus(environment(), { ...user, id: 'another' })).json<{ routes: unknown[] }>()).routes).toHaveLength(0)
  })

  it('queues newly registered routes once and persists enqueue admission', async () => {
    await configureMailPush(env, user, configuration())
    const e = environment()
    await enqueueMailPush(e)
    await enqueueMailPush(e)
    expect(e.MAIL_PUSH_QUEUE!.send).toHaveBeenCalledOnce()
    expect(e.MAIL_PUSH_QUEUE!.send).toHaveBeenCalledWith({ subscriptionId: id, mailbox })
    const status = await (await mailPushStatus(e, user)).json<{ routes: { enqueued_at: number }[] }>()
    expect(status.routes[0].enqueued_at).toBeGreaterThan(0)
  })

  it('atomically records real receipt and parsed body, then signs metadata and independent body deliveries', async () => {
    await configureMailPush(env, user, configuration())
    const e = environment()
    // Isolate the delivery test from backfill; realtime writes remain enabled.
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    const raw = `From: sender@example.net\r\nTo: alias@icloud.com\r\nX-ICLOUD-HME: p=alias@icloud.com; f=${mailbox}\r\nSubject: Verification code\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour verification code is 002468`
    const input = { to: mailbox, from: 'sender@example.net', raw: new Response(raw).body,
      rawSize: raw.length, headers: new Headers({ To: 'alias@icloud.com', 'X-ICLOUD-HME': `p=alias@icloud.com; f=${mailbox}` }), setReject: vi.fn() }
    await env.DB.prepare("INSERT OR IGNORE INTO domains(name,is_active) VALUES('example.com',1)").run()
    await receiveEmail(input as unknown as ForwardableEmailMessage, { ...e, MAIL_QUEUE: { send: vi.fn() } } as unknown as Env)
    const received = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_address=?').bind(mailbox).first<{ id: string }>()
    await parseMessage({ messageId: received!.id }, e)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM mail_push_outbox').first()).toEqual({ n: 2 })
    const deliveries: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${headers.get('X-OmniMail-Timestamp')}\n${headers.get('X-OmniMail-Delivery')}\n${init.body}`))
      expect(headers.get('X-OmniMail-Signature')).toBe(Array.from(new Uint8Array(expected), (v) => v.toString(16).padStart(2, '0')).join(''))
      const body = JSON.parse(String(init.body)); deliveries.push(body)
      return Response.json({ status: 'accepted' })
    }))
    await runDelivery(e)
    const first = deliveries[0] as { events: { state: string; metadata_only?: boolean; text: string }[] }
    expect(first.events.find((v) => v.state === 'ready')).toMatchObject({ metadata_only: true, text: '' })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='pending'").first()).toEqual({ n: 1 })
    await runDelivery(e)
    const next = deliveries[1] as { events: { text: string; text_hash: string; received_at: number; headers: unknown }[] }
    expect(next.events[0].text).toContain('002468')
    expect(next.events[0].text_hash).toBe(await digest(next.events[0].text))
    expect(JSON.stringify(next.events[0].headers)).toContain('x-icloud-hme')
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='sent'").first()).toEqual({ n: 2 })
  })

  it('preserves snapshots after mail deletion, retries lost acknowledgements with the same event identity, and never drops failed delivery', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    await message('durable-message', true)
    await (await pushSnapshot(env, 'durable-message', 'ready', 'Verification code 001122')).run()
    await env.DB.prepare("DELETE FROM messages WHERE id='durable-message'").run()
    const recorded = await env.DB.prepare('SELECT event_id,payload_json FROM mail_push_outbox').first<{ event_id: string; payload_json: string }>()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection lost') }))
    await runDelivery()
    expect(await env.DB.prepare('SELECT status,attempts FROM mail_push_outbox').first()).toEqual({ status: 'pending', attempts: 1 })
    await env.DB.prepare('UPDATE mail_push_outbox SET next_attempt_at=0').run()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.events[0].id).toBe(recorded!.event_id)
      return Response.json({ status: 'accepted' })
    })
    vi.stubGlobal('fetch', fetcher)
    await runDelivery(); await runDelivery()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await env.DB.prepare('SELECT status FROM mail_push_outbox').first()).toEqual({ status: 'sent' })
  })

  it('replays the recent window once and does not consume sequence numbers on idempotent setup or repeated events', async () => {
    await message('backfill-message', true)
    const raw = `From: sender@example.net\r\nTo: alias@icloud.com\r\n\r\nVerification code 003344`
    await env.MAIL_BUCKET.put('push-test/raw', raw)
    await env.MAIL_BUCKET.put('push-test/body', JSON.stringify({ text: 'Verification code 003344', html: '' }))
    await env.DB.prepare("UPDATE messages SET raw_key='push-test/raw',body_key='push-test/body',push_headers_json='{}' WHERE id='backfill-message'").run()
    await configureMailPush(env, user, configuration())
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'accepted' })))
    await runDelivery(); await runDelivery()
    const before = await env.DB.prepare('SELECT next_sequence,initialized FROM mail_push_routes').first()
    expect(before).toEqual({ next_sequence: 1, initialized: 1 })
    await configureMailPush(env, user, configuration())
    await (await pushSnapshot(env, 'backfill-message', 'ready', 'Verification code 003344')).run()
    expect(await env.DB.prepare('SELECT next_sequence,initialized FROM mail_push_routes').first()).toEqual(before)
  })
})
