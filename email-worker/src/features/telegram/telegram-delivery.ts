import type { Env, StoredBody } from '../../app/types'
import { D1QuotaError } from '../../platform/d1/quota-guard'
import { MESSAGE_SELECTS } from '../notifications/mail-notification-api'
import {
  TelegramApiError, sendTelegramMessage, sendTelegramRichMessage, sendTelegramTextDocument,
} from './telegram-client'
import { notificationRoute, quietNow, telegramSetting, telegramSource } from './telegram-common'
import { renderTelegramRichMessage } from './telegram-rich-html'

interface DeliveryRow {
  id: string
  endpoint_id: string
  source: string
  account_id: string
  message_id: string
  attempts: number
  user_id: string
  chat_id: string
  enabled: number
  endpoint_status: string
  sources_json: string
  detail_level: string
  include_body: number
  body_format: string
  quiet_enabled: number
  quiet_start: string
  quiet_end: string
  timezone: string
}

interface MailRow {
  sender_name: string
  sender_address: string
  subject: string
  is_read: number
}

const MAX_ENQUEUE = 20
const ENQUEUE_COOLDOWN = 120
const SEND_LEASE = 120
const MAX_STORED_BODY_BYTES = 5_000_000
const MAX_TEXT_BODY_BYTES = 1_000_000

export async function enqueuePendingNotifications(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!env.NOTIFICATION_QUEUE) return 0
  const { results } = await env.DB.prepare(
    `SELECT id FROM notification_outbox
      WHERE status='pending' AND next_attempt_at<=? AND lease_until<=?
        AND (enqueued_at IS NULL OR enqueued_at<=?)
      ORDER BY next_attempt_at,id LIMIT ?`,
  ).bind(now, now, now - ENQUEUE_COOLDOWN, MAX_ENQUEUE).all<{ id: string }>()
  let queued = 0
  for (const row of results) {
    const claim = await env.DB.prepare(
      `UPDATE notification_outbox SET enqueued_at=?
       WHERE id=? AND status='pending' AND next_attempt_at<=? AND lease_until<=?
         AND (enqueued_at IS NULL OR enqueued_at<=?)`,
    ).bind(now, row.id, now, now, now - ENQUEUE_COOLDOWN).run()
    if (!claim.meta.changes) continue
    try {
      await env.NOTIFICATION_QUEUE.send({ id: row.id })
      queued += 1
    } catch {
      await env.DB.prepare('UPDATE notification_outbox SET enqueued_at=NULL WHERE id=? AND status=\'pending\'')
        .bind(row.id).run()
    }
  }
  return queued
}

async function finish(db: D1Database, id: string, status: 'sent' | 'skipped' | 'failed', now: number, code = '') {
  await db.prepare(
    `UPDATE notification_outbox SET status=?, sent_at=?, lease_until=0, last_error_code=? WHERE id=?`,
  ).bind(status, now, code, id).run()
}

function safeLine(value: string, limit: number): string {
  return value.replace(/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, limit)
}

function messageText(row: DeliveryRow, mail: MailRow, origin: string): string {
  const source = row.source === 'omnimail' ? 'OmniMail' : row.source.toUpperCase()
  const lines = [`${source} 收到新邮件`]
  if (row.detail_level === 'sender' || row.detail_level === 'subject') {
    lines.push(`发件人：${safeLine(mail.sender_name || mail.sender_address || '未知发件人', 100)}`)
  }
  if (row.detail_level === 'subject') lines.push(`主题：${safeLine(mail.subject || '无主题', 160)}`)
  const link = new URL(notificationRoute(row.source as keyof typeof MESSAGE_SELECTS,
    row.account_id, row.message_id), origin)
  lines.push(link.toString())
  return lines.join('\n')
}

async function mailForDelivery(env: Env, row: DeliveryRow): Promise<MailRow | null> {
  if (!telegramSource(row.source)) return null
  return env.DB.prepare(
    `SELECT sender_name,sender_address,subject,is_read FROM (${MESSAGE_SELECTS[row.source]})
      WHERE account_id=? AND message_id=? LIMIT 1`,
  ).bind(row.user_id, row.account_id, row.message_id).first<MailRow>()
}

async function mainMailboxBody(env: Env, row: DeliveryRow): Promise<StoredBody | null> {
  const message = await env.DB.prepare(
    `SELECT m.body_key FROM messages m JOIN mailboxes mb ON mb.address=m.mailbox_address
     WHERE mb.user_id=? AND mb.cleanup_job_id IS NULL AND m.id=? AND m.direction='incoming'
       AND m.folder='inbox' AND m.status='ready' LIMIT 1`,
  ).bind(row.user_id, row.message_id).first<{ body_key: string | null }>()
  if (!message?.body_key) return null
  try {
    // R2 中的 JSON 也可能含大量 HTML；先限制对象大小，避免通知消费占用过多内存。
    const object = await env.MAIL_BUCKET.get(message.body_key)
    if (!object || object.size > MAX_STORED_BODY_BYTES) return null
    const body: unknown = await object.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof (body as { text?: unknown }).text !== 'string') return null
    const text = (body as { text: string }).text
    const html = (body as { html?: unknown }).html
    return new TextEncoder().encode(text).byteLength <= MAX_TEXT_BODY_BYTES
      ? { text, html: typeof html === 'string' ? html : '' } : null
  } catch {
    // 正文读取失败时仍发送基础提醒，且不把正文或 R2 异常写进日志。
    return null
  }
}

async function sendPlainBody(token: string, chatId: string, header: string, body: string | null) {
  if (body === null) {
    await sendTelegramMessage(token, chatId, `${header}\n正文无法转发，请打开站内链接查看。`)
  } else if (!body.length) {
    await sendTelegramMessage(token, chatId, `${header}\n此邮件没有纯文本正文。`)
  } else if (`${header}\n\n${body}`.length <= 4096) {
    await sendTelegramMessage(token, chatId, `${header}\n\n${body}`)
  } else {
    await sendTelegramTextDocument(token, chatId, body, header)
  }
}

async function retryLater(env: Env, row: DeliveryRow, error: TelegramApiError, now: number): Promise<void> {
  if (!error.retryable || row.attempts >= 5) {
    await finish(env.DB, row.id, 'failed', now, error.code)
    await env.DB.prepare(
      'UPDATE notification_endpoints SET last_error_code=?,updated_at=? WHERE id=?',
    ).bind(error.code, now, row.endpoint_id).run()
    if (error.code === 'telegram_forbidden') {
      await env.DB.prepare(
        `UPDATE notification_endpoints SET enabled=0,status='blocked',last_error_code=?,updated_at=?
         WHERE id=?`,
      ).bind(error.code, now, row.endpoint_id).run()
    }
    return
  }
  const delay = error.retryAfter || Math.min(3600, 30 * 2 ** Math.max(0, row.attempts - 1))
  await env.DB.prepare(
    `UPDATE notification_outbox SET next_attempt_at=?,enqueued_at=NULL,lease_until=0,
      last_error_code=? WHERE id=?`,
  ).bind(now + delay, error.code, row.id).run()
}

async function deliver(env: Env, id: string, now: number): Promise<void> {
  const claimed = await env.DB.prepare(
    `UPDATE notification_outbox SET lease_until=?,attempts=attempts+1
     WHERE id=? AND status='pending' AND next_attempt_at<=? AND lease_until<=?`,
  ).bind(now + SEND_LEASE, id, now, now).run()
  if (!claimed.meta.changes) return
  const row = await env.DB.prepare(
    `SELECT o.id,o.endpoint_id,o.source,o.account_id,o.message_id,o.attempts,
      e.user_id,e.chat_id,e.enabled,e.status AS endpoint_status,e.sources_json,
      e.detail_level,e.include_body,e.body_format,e.quiet_enabled,e.quiet_start,e.quiet_end,e.timezone
     FROM notification_outbox o JOIN notification_endpoints e ON e.id=o.endpoint_id
     WHERE o.id=? LIMIT 1`,
  ).bind(id).first<DeliveryRow>()
  if (!row) return
  let sources: unknown
  try { sources = JSON.parse(row.sources_json) } catch { sources = null }
  if (!row.enabled || row.endpoint_status !== 'active'
    || !Array.isArray(sources) || !sources.includes(row.source)
    || !env.TELEGRAM_BOT_TOKEN || !telegramSource(row.source)) {
    await finish(env.DB, id, 'skipped', now)
    return
  }
  if (row.quiet_enabled && quietNow(row.quiet_start, row.quiet_end, row.timezone)) {
    await finish(env.DB, id, 'skipped', now)
    return
  }
  const mail = await mailForDelivery(env, row)
  if (!mail || mail.is_read) {
    await finish(env.DB, id, 'skipped', now)
    return
  }
  const origin = await telegramSetting(env.DB, 'telegram_site_origin')
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin)) {
    await finish(env.DB, id, 'failed', now, 'telegram_origin_missing')
    return
  }
  try {
    const header = messageText(row, mail, origin)
    if (row.source === 'omnimail' && row.include_body === 1) {
      const body = await mainMailboxBody(env, row)
      const rich = row.body_format === 'rich' && body?.html
        ? renderTelegramRichMessage(header, body.html) : null
      if (rich) {
        try {
          await sendTelegramRichMessage(env.TELEGRAM_BOT_TOKEN, row.chat_id, rich)
        } catch (error) {
          // Telegram 不接受某些合法邮件结构时保留提醒，回退到原有纯文本路径。
          if (!(error instanceof TelegramApiError) || error.code !== 'telegram_rejected') throw error
          await sendPlainBody(env.TELEGRAM_BOT_TOKEN, row.chat_id, header, body?.text ?? null)
        }
      } else {
        await sendPlainBody(env.TELEGRAM_BOT_TOKEN, row.chat_id, header, body?.text ?? null)
      }
    } else {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, row.chat_id, header)
    }
    await finish(env.DB, id, 'sent', now)
    await env.DB.prepare(
      "UPDATE notification_endpoints SET last_error_code='' WHERE id=? AND last_error_code!=''",
    ).bind(row.endpoint_id).run()
  } catch (error) {
    if (!(error instanceof TelegramApiError)) throw error
    await retryLater(env, row, error, now)
  }
}

export async function consumeNotificationQueue(
  batch: MessageBatch<{ id: string }>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const id = message.body?.id
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
      message.ack()
      continue
    }
    try {
      await deliver(env, id, Math.floor(Date.now() / 1000))
      message.ack()
    } catch (error) {
      if (error instanceof D1QuotaError) throw error
      message.retry({ delaySeconds: 30 })
    }
  }
}

export async function purgeOldNotifications(db: D1Database, now = Math.floor(Date.now() / 1000)) {
  await db.prepare(
    `DELETE FROM notification_outbox WHERE id IN (
      SELECT id FROM notification_outbox
      WHERE status IN ('sent','skipped','failed') AND created_at<? LIMIT 100
    )`,
  ).bind(now - 7 * 86400).run()
  await db.prepare(`DELETE FROM telegram_pairing_codes WHERE code_hash IN (
    SELECT code_hash FROM telegram_pairing_codes WHERE expires_at<? LIMIT 100
  )`)
    .bind(now).run()
}
