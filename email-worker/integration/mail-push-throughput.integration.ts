import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, afterEach, expect, it, vi } from 'vitest'
import type { Env, MailPushQueueJob, SessionUser } from '../src/app/types'
import { configureMailPush } from '../src/features/mail-push/push-api'
import { consumeMailPush } from '../src/features/mail-push/push-delivery'
import { digest, pushSnapshot } from '../src/features/mail-push/push-snapshot'

const user = { id: 'push-throughput-owner', role: 'user' } as SessionUser
const mailbox = 'throughput@example.com'
const subscription = '21956f6a-15f0-4d91-af71-67ec23d7ce47'
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash) VALUES(?,?,'Throughput','fixture')").bind(user.id, mailbox).run()
  await env.DB.prepare('INSERT INTO mailboxes(address,user_id,is_active) VALUES(?,?,1)').bind(mailbox, user.id).run()
  const result = await configureMailPush(env, user, new Request('https://mail.example.com/api/integrations/mail-push', { method: 'PUT', body: JSON.stringify({
    id: subscription, secret: 'b'.repeat(43), callback_url: 'https://pickup.example.com/api/integrations/omnimail/events', mailboxes: [mailbox],
  }) }))
  expect(result.status).toBe(200)
  await env.DB.prepare('UPDATE mail_push_routes SET initialized=1 WHERE subscription_id=?').bind(subscription).run()
  const inserts = Array.from({ length: 750 }, (_, index) => env.DB.prepare(`INSERT INTO messages
    (id,mailbox_address,direction,status,folder,sender_address,recipients_json,subject,received_at,push_headers_json)
    VALUES(?,?,'incoming','ready','inbox','sender@example.net',?,'Verification code',unixepoch(),?)`)
    .bind(`burst-${index}`, mailbox, JSON.stringify([`alias-${index}@icloud.com`]), JSON.stringify({ 'x-icloud-hme': [`p=alias-${index}@icloud.com; f=${mailbox}`] })))
  await env.DB.batch(inserts)
})
afterEach(() => vi.unstubAllGlobals())

async function runBurst(consume: typeof consumeMailPush) {
  await env.DB.prepare('DELETE FROM mail_push_outbox WHERE subscription_id=?').bind(subscription).run()
  await env.DB.prepare('UPDATE mail_push_routes SET next_sequence=0,enqueued_at=0,lease_until=0 WHERE subscription_id=?').bind(subscription).run()
  const snapshots: D1PreparedStatement[] = []
  for (let index = 0; index < 750; index++) snapshots.push(await pushSnapshot(env, `burst-${index}`, 'ready', `Verification code ${String(index).padStart(6, '0')}`))
  await env.DB.batch(snapshots)
  const jobs: MailPushQueueJob[] = [{ subscriptionId: subscription, mailbox }]
  let http = 0, batches = 0, ackStatements = 0
  const complete = new Set<string>()
  const encoder = new TextEncoder()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    new Request(url, init)
    http++
    expect(encoder.encode(String(init.body)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024)
    const body = JSON.parse(String(init.body))
    for (const event of body.events) {
      expect(event.sequence).toBeLessThanOrEqual(body.streams[0].high_water)
      if (event.metadata_only) continue
      const index = Number(event.message_id.slice('burst-'.length))
      expect(event.recipients).toEqual([`alias-${index}@icloud.com`])
      expect(event.text).toBe(`Verification code ${String(index).padStart(6, '0')}`)
      expect(event.text_hash).toBe(await digest(event.text))
      expect(complete.has(event.id)).toBe(false)
      complete.add(event.id)
    }
    return Response.json({ status: 'accepted' })
  }))
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === 'batch') return (statements: D1PreparedStatement[]) => { ackStatements += statements.length; return target.batch(statements) }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const environment = { ...env, DB: database, MAIL_PUSH_QUEUE: { send: vi.fn(async (job: MailPushQueueJob) => { jobs.push(job) }) } } as unknown as Env
  while (jobs.length) {
    expect(batches++).toBeLessThan(256)
    let acked = false
    const job = jobs.shift()!
    await consume({ messages: [{ body: job, ack: () => { acked = true }, retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<MailPushQueueJob>, environment)
    expect(acked).toBe(true)
  }
  expect(complete.size).toBe(750)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM mail_push_outbox WHERE subscription_id=? AND status='pending'").bind(subscription).first()).toEqual({ n: 0 })
  return { http, queueJobs: batches, ackStatements }
}

it('delivers 750 distinct OTP bodies with bounded transport and no final empty drain job', async () => {
  const optimized = await runBurst(consumeMailPush)
  // Regression budget measured with real D1 and a simulated transport; this is
  // independent of wall-clock network speed and preserves every recipient/hash.
  expect(optimized.http).toBeLessThan(75)
  expect(optimized.queueJobs).toBe(optimized.http)
  expect(optimized.ackStatements).toBeLessThan(200)
}, 60_000)
