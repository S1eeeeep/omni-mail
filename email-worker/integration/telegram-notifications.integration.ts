import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env, SessionUser } from '../src/app/types'
import { createTelegramPairing, getTelegramStatus, handleTelegramWebhook, registerTelegramBot, updateTelegramSettings } from '../src/features/telegram/telegram-api'
import { consumeNotificationQueue, enqueuePendingNotifications } from '../src/features/telegram/telegram-delivery'
import { messageStatement as gmail } from '../src/features/gmail/gmail-sync'
import { messageStatement as qq } from '../src/features/qq-mail/qq-mail-sync'
import { messageStatement as naver } from '../src/features/naver-mail/naver-mail-sync'
import { messageStatement as yandex } from '../src/features/yandex-mail/yandex-mail-sync'
import { messageStatement as microsoft } from '../src/features/microsoft/microsoft-sync'
import { messageStatement as external } from '../src/features/external-mail/external-mail-sync'

const now = Math.floor(Date.now() / 1000)
const owner = { id: 'telegram-owner', role: 'user' } as SessionUser
const sourceNames = ['gmail', 'qq', 'naver', 'yandex', 'microsoft', 'icloud', 'linuxdo'] as const
const metadata = {
  imapUid: 1, uid: 1, gmailMessageId: 'tg-remote-1', gmailThreadId: 'tg-thread-1',
  internetMessageId: '<tg@example.com>', messageIdHeader: '<tg@example.com>',
  senderName: 'Sender', senderAddress: 'sender@example.com', recipients: ['tg@example.com'], cc: [],
  subject: 'Secret subject', preview: '', internalDate: now, receivedAt: now, sentAt: null,
  sizeBytes: 100, flags: ['\\Recent'], labels: ['INBOX'], isRead: false,
  isStarred: false, hasAttachments: false,
}

function statement(source: typeof sourceNames[number], uid: number, validity = 1) {
  const message = {
    ...metadata, imapUid: uid, uid,
    gmailMessageId: `tg-remote-${uid}-${validity}`,
    messageIdHeader: `<tg-${uid}-${validity}@example.com>`,
  }
  if (source === 'gmail') return gmail(env, source, validity, message, now + uid)
  if (source === 'qq') return qq(env, source, validity, message, now + uid)
  if (source === 'naver') return naver(env, source, validity, message, now + uid)
  if (source === 'yandex') return yandex(env, source, validity, message, now + uid)
  if (source === 'microsoft') return microsoft(env, source, 'INBOX', validity, message, now + uid)
  return external(env, source, source, validity, message, now + uid)
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare(
    `INSERT INTO users(id,email,display_name,password_hash) VALUES
      ('telegram-owner','tg@example.com','Telegram','test'),
      ('telegram-pair-owner','tg-pair@example.com','Pair','test')`,
  ).run()
  const accounts = [
    "INSERT INTO gmail_imap_accounts(id,user_id,name,email,app_password_cipher,created_at,updated_at) VALUES('gmail','telegram-owner','Gmail','tg@gmail.com','test',1,1)",
    "INSERT INTO qq_mail_accounts(id,user_id,name,email,authorization_code_cipher,created_at,updated_at) VALUES('qq','telegram-owner','QQ','tg@qq.com','test',1,1)",
    "INSERT INTO naver_mail_accounts(id,user_id,name,email,naver_id,app_password_cipher,created_at,updated_at) VALUES('naver','telegram-owner','NAVER','tg@naver.com','tg','test',1,1)",
    "INSERT INTO yandex_mail_accounts(id,user_id,name,email,yandex_login,app_password_cipher,created_at,updated_at) VALUES('yandex','telegram-owner','Yandex','tg@yandex.com','tg','test',1,1)",
    "INSERT INTO microsoft_imap_accounts(id,user_id,name,provided_email,normalized_email,auth_mode,client_id,refresh_token_cipher,created_at,updated_at) VALUES('microsoft','telegram-owner','Microsoft','tg@outlook.com','tg@outlook.com','oauth2','test','test',1,1)",
    "INSERT INTO icloud_accounts(id,user_id,name,created_at,updated_at) VALUES('icloud','telegram-owner','iCloud',1,1)",
    "INSERT INTO linux_do_mail_accounts(id,user_id,username,password_cipher,created_at,updated_at) VALUES('linuxdo','telegram-owner','tg@linux.do','test',1,1)",
  ]
  await env.DB.batch(accounts.map((sql) => env.DB.prepare(sql)))
  await env.DB.prepare("UPDATE icloud_accounts SET app_password_cipher='test' WHERE id='icloud'").run()
  await env.DB.prepare(
    "INSERT INTO microsoft_imap_folders(account_id,path,display_name,flags_json,last_listed_at) VALUES('microsoft','INBOX','INBOX','[]',1)",
  ).run()
  await env.DB.prepare(
    `INSERT INTO mailboxes(address,user_id,is_primary,is_active,created_at)
      VALUES('tg@example.com','telegram-owner',1,1,?)`,
  ).bind(now).run()
  await env.DB.prepare(
    `INSERT INTO notification_endpoints
     (id,user_id,chat_id,sources_json,enabled_at,created_at,updated_at)
     VALUES('tg-endpoint','telegram-owner','123456789',?, ?, ?, ?)`,
  ).bind(JSON.stringify(['omnimail', ...sourceNames]), now - 100, now - 100, now - 100).run()
  await env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES
     ('telegram_bot_username','omnimail_test_bot',?),
     ('telegram_site_origin','https://mail.example.com',?)`,
  ).bind(now, now).run()
})

afterEach(() => vi.unstubAllGlobals())

describe('Telegram notification outbox', () => {
  it.each(sourceNames)('%s only enqueues newly indexed mail after the first sync', async (source) => {
    await statement(source, 1).run()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE source=?')
      .bind(source).first()).toEqual({ n: 0 })
    await env.DB.prepare(`UPDATE ${source === 'linuxdo' ? 'linux_do_mail' : source === 'icloud' ? 'icloud' : source === 'microsoft' ? 'microsoft_imap' : source === 'qq' ? 'qq_mail' : source === 'naver' ? 'naver_mail' : source === 'yandex' ? 'yandex_mail' : 'gmail_imap'}_accounts SET last_synced_at=?${source === 'microsoft' ? '' : ',uid_validity=1'} WHERE id=?`)
      .bind(now, source).run()
    if (source === 'microsoft') await env.DB.prepare(
      "UPDATE microsoft_imap_folders SET uid_validity=1 WHERE account_id='microsoft'",
    ).run()
    await statement(source, 2).run()
    await statement(source, 2).run()
    if (source === 'microsoft') await env.DB.prepare(
      "UPDATE microsoft_imap_folders SET last_uid=10 WHERE account_id='microsoft'",
    ).run()
    else await env.DB.prepare(`UPDATE ${source === 'linuxdo' ? 'linux_do_mail' : source === 'icloud' ? 'icloud' : source === 'qq' ? 'qq_mail' : source === 'naver' ? 'naver_mail' : source === 'yandex' ? 'yandex_mail' : 'gmail_imap'}_accounts SET last_seen_uid=10 WHERE id=?`)
      .bind(source).run()
    await statement(source, 9).run()
    await statement(source, 3, 2).run()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE source=?')
      .bind(source).first()).toEqual({ n: 1 })
    const outbox = await env.DB.prepare(
      'SELECT id FROM notification_outbox WHERE source=? LIMIT 1',
    ).bind(source).first<{ id: string }>()
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetcher)
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    const batch = { messages: [{ body: { id: outbox!.id }, ack: () => undefined,
      retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await env.DB.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .bind(outbox!.id).first()).toEqual({ status: 'sent' })
  })

  it('only records a ready inbound message, then sends a private content-free alert once', async () => {
    await env.MAIL_BUCKET.put('bodies/tg-main.json', JSON.stringify({ text: 'Private body', html: '' }))
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,subject,body_key,created_at,updated_at)
       VALUES('tg-main','tg@example.com','incoming','processing','inbox','sender@example.com','Secret subject','bodies/tg-main.json',?,?)`,
    ).bind(now, now).run()
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE source='omnimail'")
      .first()).toEqual({ n: 0 })
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id='tg-main'").run()
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id='tg-main'").run()
    const outbox = await env.DB.prepare(
      "SELECT id FROM notification_outbox WHERE source='omnimail' AND message_id='tg-main'",
    ).first<{ id: string }>()
    expect(outbox?.id).toMatch(/^[a-f0-9]{32}$/)
    const jobs: Array<{ id: string }> = []
    const request = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', request)
    const environment = {
      ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      NOTIFICATION_QUEUE: { send: async (job: { id: string }) => { jobs.push(job) } },
    } as unknown as Env
    expect(await enqueuePendingNotifications(environment)).toBeGreaterThan(0)
    expect(jobs.some((job) => job.id === outbox?.id)).toBe(true)
    let acknowledged = 0
    const batch = { messages: [{ body: { id: outbox!.id }, ack: () => { acknowledged += 1 }, retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    await consumeNotificationQueue(batch, environment)
    expect(request).toHaveBeenCalledOnce()
    expect(acknowledged).toBe(2)
    const sent = JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { text: string }
    expect(sent.text).toContain('https://mail.example.com/mail/inbox?')
    expect(sent.text).not.toContain('Secret subject')
    expect(sent.text).not.toContain('Private body')
    expect(await env.DB.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .bind(outbox!.id).first()).toEqual({ status: 'sent' })
  })

  it.each([
    { id: 'tg-body-short', text: '完整正文和验证码 123456', method: 'sendMessage' },
    { id: 'tg-body-long', text: '长正文'.repeat(1500), method: 'sendDocument' },
    { id: 'tg-body-overlimit', text: 'X'.repeat(1_000_001), method: 'sendMessage' },
  ])('forwards opted-in OmniMail body with $method for $id', async ({ id, text, method }) => {
    await env.DB.prepare("UPDATE notification_endpoints SET include_body=1 WHERE id='tg-endpoint'").run()
    const bodyKey = `bodies/${id}.json`
    await env.MAIL_BUCKET.put(bodyKey, JSON.stringify({ text, html: '' }))
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,body_key,created_at,updated_at)
       VALUES(?,'tg@example.com','incoming','processing','inbox','sender@example.com',?,?,?)`,
    ).bind(id, bodyKey, now, now).run()
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id=?").bind(id).run()
    const outbox = await env.DB.prepare('SELECT id FROM notification_outbox WHERE message_id=?')
      .bind(id).first<{ id: string }>()
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetcher)
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    const batch = { messages: [{ body: { id: outbox!.id }, ack: () => undefined,
      retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`/${method}`)
    if (method === 'sendDocument') {
      const form = init.body as FormData
      expect(await (form.get('document') as File).text()).toBe(text)
      expect(form.get('caption')).toContain('/mail/inbox?')
    } else {
      const payload = JSON.parse(init.body as string) as { text: string }
      expect(payload.text).toContain(method === 'sendMessage' && id === 'tg-body-overlimit'
        ? '正文无法转发' : text)
      if (id === 'tg-body-overlimit') expect(payload.text).not.toContain(text.slice(0, 100))
    }
    expect(await env.DB.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .bind(outbox!.id).first()).toEqual({ status: 'sent' })
  })

  it.each([
    { id: 'tg-rich-html', rejectRich: false },
    { id: 'tg-rich-fallback', rejectRich: true },
  ])('renders safe rich HTML and falls back on rejection for $id', async ({ id, rejectRich }) => {
    await env.DB.prepare("UPDATE notification_endpoints SET include_body=1,body_format='rich' WHERE id='tg-endpoint'").run()
    const bodyKey = `bodies/${id}.json`
    await env.MAIL_BUCKET.put(bodyKey, JSON.stringify({
      text: rejectRich ? '纯文本后备' : '',
      html: '<h2>订单通知</h2><p><b>已完成</b> <a href="https://example.com/order">查看</a></p><script>bad()</script>',
    }))
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,body_key,created_at,updated_at)
       VALUES(?,'tg@example.com','incoming','processing','inbox','sender@example.com',?,?,?)`,
    ).bind(id, bodyKey, now, now).run()
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id=?").bind(id).run()
    const outbox = await env.DB.prepare('SELECT id FROM notification_outbox WHERE message_id=?')
      .bind(id).first<{ id: string }>()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      rejectRich && String(input).includes('/sendRichMessage')
        ? Response.json({ ok: false, error_code: 400 }, { status: 400 })
        : Response.json({ ok: true, result: { message_id: 1 } })
    ))
    vi.stubGlobal('fetch', fetcher)
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    const batch = { messages: [{ body: { id: outbox!.id }, ack: () => undefined,
      retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(fetcher).toHaveBeenCalledTimes(rejectRich ? 2 : 1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/sendRichMessage')
    const payload = JSON.parse(init.body as string) as {
      rich_message: { html: string; skip_entity_detection: boolean }
    }
    expect(payload.rich_message.skip_entity_detection).toBe(true)
    expect(payload).not.toHaveProperty('skip_entity_detection')
    expect(payload.rich_message.html).toContain('<h2>订单通知</h2>')
    expect(payload.rich_message.html).toContain('<a href="https://example.com/order">查看</a>')
    expect(payload.rich_message.html).not.toContain('bad()')
    if (rejectRich) {
      const fallback = fetcher.mock.calls[1] as unknown as [string, RequestInit]
      expect(fallback[0]).toContain('/sendMessage')
      expect(JSON.parse(fallback[1].body as string).text).toContain('纯文本后备')
    }
    expect(await env.DB.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .bind(outbox!.id).first()).toEqual({ status: 'sent' })
    await env.DB.prepare("UPDATE notification_endpoints SET body_format='text' WHERE id='tg-endpoint'").run()
  })

  it('keeps external mail metadata-only even when body forwarding is enabled', async () => {
    await env.DB.prepare("UPDATE notification_endpoints SET include_body=1 WHERE id='tg-endpoint'").run()
    await statement('gmail', 22).run()
    const outbox = await env.DB.prepare(
      "SELECT id FROM notification_outbox WHERE source='gmail' AND status='pending' ORDER BY created_at DESC LIMIT 1",
    ).first<{ id: string }>()
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetcher)
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    const batch = { messages: [{ body: { id: outbox!.id }, ack: () => undefined,
      retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/sendMessage')
    const payload = JSON.parse(init.body as string) as { text: string }
    expect(payload.text).not.toContain('正文')
  })

  it('skips an unread alert when the user reads the message before delivery', async () => {
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,created_at,updated_at)
       VALUES('tg-read','tg@example.com','incoming','processing','inbox','sender@example.com',?,?)`,
    ).bind(now, now).run()
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id='tg-read'").run()
    await env.DB.prepare("UPDATE messages SET is_read=1 WHERE id='tg-read'").run()
    const outbox = await env.DB.prepare(
      "SELECT id FROM notification_outbox WHERE message_id='tg-read'",
    ).first<{ id: string }>()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    const batch = { messages: [{ body: { id: outbox!.id }, ack: () => undefined,
      retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await env.DB.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .bind(outbox!.id).first()).toEqual({ status: 'skipped' })
  })

  it('pairs a private chat once and rejects a wrong webhook secret', async () => {
    const confirmation = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', confirmation)
    const environment = {
      ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_WEBHOOK_SECRET: 'abcdefghijklmnop1234567890',
    } as Env
    const user = { id: 'telegram-pair-owner', role: 'user' } as SessionUser
    const pairing = await (await createTelegramPairing(environment, user)).json() as { url: string }
    const code = new URL(pairing.url).searchParams.get('start')
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const payload = { update_id: 1, message: { text: `/start ${code}`, chat: { id: 987654321, type: 'private' }, from: { is_bot: false } } }
    const request = (secret: string) => new Request('https://mail.example.com/api/webhooks/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(payload),
    })
    expect((await handleTelegramWebhook(environment, request('wrong'))).status).toBe(403)
    expect((await handleTelegramWebhook(environment, request(environment.TELEGRAM_WEBHOOK_SECRET!))).status).toBe(200)
    expect((await handleTelegramWebhook(environment, request(environment.TELEGRAM_WEBHOOK_SECRET!))).status).toBe(200)
    expect(confirmation).toHaveBeenCalledOnce()
    const status = await (await getTelegramStatus(environment, user)).json() as { connected: boolean }
    expect(status.connected).toBe(true)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_endpoints WHERE user_id='telegram-pair-owner'")
      .first()).toEqual({ n: 1 })
  })

  it('validates settings and updates only the current user endpoint', async () => {
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_WEBHOOK_SECRET: 'abcdefghijklmnop1234567890' } as Env
    const pairedBefore = await env.DB.prepare(
      "SELECT sources_json FROM notification_endpoints WHERE user_id='telegram-pair-owner'",
    ).first()
    const request = (sources: string[], includeBody: unknown = true, bodyFormat: unknown = 'rich') => new Request('https://mail.example.com/api/notification-channels/telegram', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, sources, detailLevel: 'basic', includeBody, bodyFormat, quietEnabled: true,
        quietStart: '22:00', quietEnd: '07:00', timezone: 'Asia/Singapore' }),
    })
    expect((await updateTelegramSettings(environment, owner, request(['attacker']))).status).toBe(400)
    expect((await updateTelegramSettings(environment, owner, request(['gmail'], 'yes'))).status).toBe(400)
    expect((await updateTelegramSettings(environment, owner, request(['gmail'], true, 'html'))).status).toBe(400)
    const updated = await updateTelegramSettings(environment, owner, request(['gmail']))
    expect(updated.status).toBe(200)
    expect((await updated.json() as { bodyFormat: string }).bodyFormat).toBe('rich')
    expect(await env.DB.prepare("SELECT sources_json,include_body,body_format FROM notification_endpoints WHERE user_id='telegram-owner'")
      .first()).toEqual({ sources_json: '["gmail"]', include_body: 1, body_format: 'rich' })
    expect(await env.DB.prepare("SELECT sources_json FROM notification_endpoints WHERE user_id='telegram-pair-owner'")
      .first()).toEqual(pairedBefore)
  })

  it('retries Telegram rate limits without leaking the subject', async () => {
    await env.DB.prepare("UPDATE notification_endpoints SET sources_json=?,quiet_enabled=0 WHERE id='tg-endpoint'")
      .bind(JSON.stringify(['omnimail', ...sourceNames])).run()
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,subject,created_at,updated_at)
       VALUES('tg-limited','tg@example.com','incoming','processing','inbox','sender@example.com','Private',?,?)`,
    ).bind(now, now).run()
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id='tg-limited'").run()
    const outbox = await env.DB.prepare(
      "SELECT id FROM notification_outbox WHERE message_id='tg-limited'",
    ).first<{ id: string }>()
    expect(outbox?.id).toBeTruthy()
    const response = new Response(JSON.stringify({ ok: false, parameters: { retry_after: 17 } }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })
    const fetcher = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetcher)
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    let retries = 0
    const batch = { messages: [{ body: { id: outbox!.id },
      ack: () => undefined, retry: () => { retries += 1 } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(retries).toBe(0)
    const payload = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { text: string }
    expect(payload.text).not.toContain('Private')
    const record = await env.DB.prepare(
      'SELECT status,last_error_code,next_attempt_at FROM notification_outbox WHERE id=?',
    ).bind(outbox!.id).first<{ status: string; last_error_code: string; next_attempt_at: number }>()
    expect(record).toMatchObject({ status: 'pending', last_error_code: 'telegram_rate_limited' })
    expect(record!.next_attempt_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('pauses a private chat when Telegram rejects further messages', async () => {
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_address,direction,status,folder,sender_address,created_at,updated_at)
       VALUES('tg-blocked','tg@example.com','incoming','processing','inbox','sender@example.com',?,?)`,
    ).bind(now, now).run()
    await env.DB.prepare("UPDATE messages SET status='ready' WHERE id='tg-blocked'").run()
    const row = await env.DB.prepare(
      "SELECT id FROM notification_outbox WHERE message_id='tg-blocked'",
    ).first<{ id: string }>()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error_code: 403 }), { status: 403 },
    )))
    const environment = { ...env, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz' } as Env
    const batch = { messages: [{ body: { id: row!.id }, ack: () => undefined,
      retry: () => { throw new Error('unexpected retry') } }] } as unknown as MessageBatch<{ id: string }>
    await consumeNotificationQueue(batch, environment)
    expect(await env.DB.prepare("SELECT status,enabled FROM notification_endpoints WHERE id='tg-endpoint'")
      .first()).toEqual({ status: 'blocked', enabled: 0 })
    expect(await env.DB.prepare('SELECT status,last_error_code FROM notification_outbox WHERE id=?')
      .bind(row!.id).first()).toEqual({ status: 'failed', last_error_code: 'telegram_forbidden' })
  })

  it('limits Bot setup to the super administrator and suspends old chats on Bot change', async () => {
    const environment = { ...env,
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_WEBHOOK_SECRET: 'abcdefghijklmnop1234567890',
    } as Env
    const request = new Request('https://mail.example.com/api/admin/notification-channels/telegram/webhook', {
      method: 'POST',
    })
    expect((await registerTelegramBot(environment, owner, request, 'cookie')).status).toBe(403)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { id: 42, is_bot: true, username: 'omnimail_test_bot' } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { id: 43, is_bot: true, username: 'omnimail_new_bot' } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
    vi.stubGlobal('fetch', fetcher)
    const admin = { ...owner, role: 'super_admin' } as SessionUser
    expect((await registerTelegramBot(environment, admin, request, 'cookie')).status).toBe(200)
    expect((await registerTelegramBot(environment, admin, request, 'cookie')).status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key='telegram_bot_id'")
      .first()).toEqual({ value: '43' })
    expect(await env.DB.prepare(
      "SELECT enabled,status,last_error_code FROM notification_endpoints WHERE user_id='telegram-pair-owner'",
    ).first()).toEqual({ enabled: 0, status: 'blocked', last_error_code: 'bot_changed' })
  })
})
