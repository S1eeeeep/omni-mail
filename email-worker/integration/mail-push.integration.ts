import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser, MailPushQueueJob } from '../src/app/types'
import { configureMailPush, mailPushStatus, retryMailPush } from '../src/features/mail-push/push-api'
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

  it('requeues mail arriving while an otherwise empty delivery holds the lease', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    const e = environment()
    vi.stubGlobal('fetch', vi.fn(async () => {
      await message('arrived-during-heartbeat', true)
      await (await pushSnapshot(env, 'arrived-during-heartbeat', 'ready', 'Verification code 000123')).run()
      await enqueueMailPush(e)
      expect(e.MAIL_PUSH_QUEUE!.send).not.toHaveBeenCalled()
      return Response.json({ status: 'accepted' })
    }))
    const result = await runDelivery(e)
    expect(result.ack).toHaveBeenCalledOnce()
    expect(e.MAIL_PUSH_QUEUE!.send).toHaveBeenCalledOnce()
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='pending'").first()).toEqual({ n: 1 })
  })

  it('does not hot-loop or deliver a queued mailbox after its ownership changes', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    await message('owned-when-received', true)
    await (await pushSnapshot(env, 'owned-when-received', 'ready', 'Verification code 000123')).run()
    await env.DB.prepare("INSERT OR IGNORE INTO users(id,email,display_name,password_hash) VALUES('push-other-owner','push-other@example.com','Other','fixture')").run()
    await env.DB.prepare("UPDATE mailboxes SET user_id='push-other-owner' WHERE address=?").bind(mailbox).run()
    const e = environment(), fetcher = vi.fn(async () => Response.json({ status: 'accepted' }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const result = await runDelivery(e)
      await enqueueMailPush(e)
      expect(result.ack).toHaveBeenCalledOnce()
      expect(fetcher).not.toHaveBeenCalled()
      expect(e.MAIL_PUSH_QUEUE!.send).not.toHaveBeenCalled()
      expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='pending'").first()).toEqual({ n: 1 })
    } finally { await env.DB.prepare('UPDATE mailboxes SET user_id=? WHERE address=?').bind(user.id, mailbox).run() }
  })

  it('refreshes progress when a receipt commits between the route and outbox reads', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    await message('first-receipt', true)
    await (await pushSnapshot(env, 'first-receipt', 'ready', 'Verification code 000111')).run()
    let injected = false
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
        if (property === 'all') return async () => {
          if (!injected) {
            injected = true
            await message('racing-receipt', true)
            await (await pushSnapshot(env, 'racing-receipt', 'ready', 'Verification code 000222')).run()
          }
          return target.all()
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const e = environment()
    e.DB = new Proxy(env.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => sql.includes('SELECT event_id,sequence,payload_json') ? wrap(target.prepare(sql)) : target.prepare(sql)
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body))
      expect(batch.streams[0].high_water).toBe(2)
      expect(batch.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2])
      return Response.json({ status: 'accepted' })
    }))
    await runDelivery(e)
    expect(injected).toBe(true)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='pending'").first()).toEqual({ n: 0 })
  })

  it('keeps oversized bodies separate and every HTTP batch within the byte budget', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    const text = 'Verification code 001234 ' + 'x'.repeat(400 * 1024)
    for (let index = 0; index < 8; index++) {
      await message(`large-${index}`, true)
      await (await pushSnapshot(env, `large-${index}`, 'ready', text)).run()
    }
    const complete = new Set<string>()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new TextEncoder().encode(String(init.body)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024)
      const batch = JSON.parse(String(init.body))
      for (const event of batch.events) {
        if (event.metadata_only) expect(event.text).toBe('')
        else { expect(event.text).toBe(text); complete.add(event.id) }
      }
      return Response.json({ status: 'accepted' })
    })
    vi.stubGlobal('fetch', fetcher)
    const e = environment()
    await runDelivery(e)
    expect(complete.size).toBe(0)
    await runDelivery(e); await runDelivery(e)
    expect(complete.size).toBe(8)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='pending'").first()).toEqual({ n: 0 })
  }, 30_000)

  it('constructs delivery requests with actual workerd-supported fetch options', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    let requestError = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      try { new Request(url, init) } catch (error) { requestError = String(error); throw error }
      return Response.json({ status: 'accepted' })
    }))
    await runDelivery()
    expect(requestError).toBe('')
    expect(await env.DB.prepare('SELECT last_error_code FROM mail_push_routes').first()).toEqual({ last_error_code: '' })
  })

  it('does not follow redirects with the signed delivery and leaves the event retryable', async () => {
    await configureMailPush(env, user, configuration())
    await env.DB.prepare('UPDATE mail_push_routes SET initialized=1').run()
    await message('redirect-message', true)
    await (await pushSnapshot(env, 'redirect-message', 'ready', 'Verification code 001234')).run()
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const request = new Request(url, init)
      expect(request.redirect).toBe('manual')
      return new Response(null, { status: 302, headers: { Location: 'https://another.example.com/' } })
    })
    vi.stubGlobal('fetch', fetcher)
    await runDelivery()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await env.DB.prepare('SELECT status,last_error_code FROM mail_push_outbox').first()).toEqual({ status: 'pending', last_error_code: 'MAIL_PUSH_HTTP_302' })
  })

  it('atomically records receipt and parsed body, then signs one inline delivery for an ordinary OTP', async () => {
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
    const first = deliveries[0] as { events: { state: string; metadata_only?: boolean; text: string; text_hash: string; headers: unknown }[] }
    const ready = first.events.find((v) => v.state === 'ready')!
    expect(ready.metadata_only).not.toBe(true)
    expect(ready.text).toContain('002468')
    expect(ready.text_hash).toBe(await digest(ready.text))
    expect(JSON.stringify(ready.headers)).toContain('x-icloud-hme')
    expect(deliveries).toHaveLength(1)
    expect(e.MAIL_PUSH_QUEUE!.send).not.toHaveBeenCalled()
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE status='sent'").first()).toEqual({ n: 2 })
  })

  it.each([false, true])('dispatches parsing while backup is pending, retaining both outcomes (queue failure: %s)', async (queueFails) => {
    await env.DB.prepare("INSERT OR IGNORE INTO domains(name,is_active) VALUES('example.com',1)").run()
    const previous = await env.DB.prepare("SELECT value FROM settings WHERE key='backup_enabled'").first<{ value: string }>()
    await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('backup_enabled','1',unixepoch()) ON CONFLICT(key) DO UPDATE SET value='1'").run()
    let release!: () => void, entered!: () => void
    const backupGate = new Promise<void>((resolve) => { release = resolve })
    const backupStarted = new Promise<void>((resolve) => { entered = resolve })
    const queue = { send: vi.fn(async () => { if (queueFails) throw new Error('fixture queue unavailable') }) }
    const e = { ...environment(), MAIL_QUEUE: queue, BACKUP_BUCKET: {
      head: async () => null, put: async () => { entered(); await backupGate },
    } } as unknown as Env
    const raw = 'From: sender@example.net\r\nTo: push-owner@example.com\r\nSubject: Verification\r\n\r\nFixture'
    const input = { to: mailbox, from: 'sender@example.net', raw: new Response(raw).body,
      rawSize: raw.length, headers: new Headers({ To: mailbox }), setReject: vi.fn() }
    let finished = false, receiveError: unknown
    const receive = receiveEmail(input as unknown as ForwardableEmailMessage, e).then(() => { finished = true }, (error) => { finished = true; receiveError = error })
    try {
      await backupStarted
      expect(queue.send).toHaveBeenCalledOnce()
      expect(finished).toBe(false)
    } finally {
      release(); await receive
      if (previous) await env.DB.prepare("UPDATE settings SET value=? WHERE key='backup_enabled'").bind(previous.value).run()
      else await env.DB.prepare("DELETE FROM settings WHERE key='backup_enabled'").run()
    }
    expect(finished).toBe(true)
    expect(input.setReject).not.toHaveBeenCalled()
    if (queueFails) {
      expect(receiveError).toBeInstanceOf(Error)
      expect(await env.DB.prepare('SELECT status FROM messages WHERE mailbox_address=?').bind(mailbox).first()).toEqual({ status: 'failed' })
    } else expect(receiveError).toBeUndefined()
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
    await retryMailPush(env, user)
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.events[0].id).toBe(recorded!.event_id)
      return Response.json({ status: 'accepted' })
    })
    vi.stubGlobal('fetch', fetcher)
    await runDelivery()
    expect(fetcher).toHaveBeenCalledOnce()
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
