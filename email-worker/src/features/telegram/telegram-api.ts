import type { Env, SessionUser } from '../../app/types'
import { getTelegramBot, registerTelegramWebhook, sendTelegramMessage, TelegramApiError } from './telegram-client'
import {
  matchesWebhookSecret, newPairingCode, readLimitedJson, sha256Hex, telegramReady, telegramSetting,
  TELEGRAM_SOURCES, telegramSource, validTime, validTimezone,
} from './telegram-common'

interface EndpointRow {
  id: string
  chat_id: string
  enabled: number
  status: string
  sources_json: string
  detail_level: string
  include_body: number
  body_format: string
  quiet_enabled: number
  quiet_start: string
  quiet_end: string
  timezone: string
  last_error_code: string
  last_test_at: number
}

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

function endpoint(db: D1Database, userId: string): Promise<EndpointRow | null> {
  return db.prepare(
    `SELECT id,chat_id,enabled,status,sources_json,detail_level,include_body,body_format,quiet_enabled,
      quiet_start,quiet_end,timezone,last_error_code,last_test_at
     FROM notification_endpoints WHERE user_id=? LIMIT 1`,
  ).bind(userId).first<EndpointRow>()
}

function safeSources(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => (
      typeof item === 'string' && telegramSource(item)
    )) : []
  } catch { return [] }
}

export async function getTelegramStatus(env: Env, user: SessionUser): Promise<Response> {
  const [current, botUsername] = await Promise.all([
    endpoint(env.DB, user.id), telegramSetting(env.DB, 'telegram_bot_username'),
  ])
  return reply({
    configured: telegramReady(env) && Boolean(botUsername),
    botUsername: telegramReady(env) ? botUsername : '',
    connected: Boolean(current),
    enabled: Boolean(current?.enabled),
    status: current?.status ?? 'disconnected',
    sources: current ? safeSources(current.sources_json) : [...TELEGRAM_SOURCES],
    detailLevel: current?.detail_level ?? 'basic',
    includeBody: Boolean(current?.include_body),
    bodyFormat: current?.body_format ?? 'text',
    quietEnabled: Boolean(current?.quiet_enabled),
    quietStart: current?.quiet_start ?? '22:00',
    quietEnd: current?.quiet_end ?? '07:00',
    timezone: current?.timezone ?? 'UTC',
    lastErrorCode: current?.last_error_code ?? '',
  })
}

export async function registerTelegramBot(
  env: Env,
  user: SessionUser,
  request: Request,
  authKind: 'cookie' | 'bearer',
): Promise<Response> {
  if (user.role !== 'super_admin' || authKind !== 'cookie') return reply({ error: '没有配置通知的权限。' }, 403)
  if (!telegramReady(env)) return reply({ error: '请先配置 Telegram Bot Secret 与通知 Queue。' }, 409)
  const origin = new URL(request.url).origin
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin)) {
    return reply({ error: 'Webhook 需要可公开访问的 HTTPS 站点。' }, 400)
  }
  try {
    const bot = await getTelegramBot(env.TELEGRAM_BOT_TOKEN!)
    await registerTelegramWebhook(
      env.TELEGRAM_BOT_TOKEN!, `${origin}/api/webhooks/telegram`, env.TELEGRAM_WEBHOOK_SECRET!,
    )
    const previousBotId = await telegramSetting(env.DB, 'telegram_bot_id')
    const changedBot = Boolean(previousBotId && previousBotId !== String(bot.id))
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('telegram_bot_username',?,unixepoch())
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(bot.username),
      env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('telegram_bot_id',?,unixepoch())
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(String(bot.id)),
      env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('telegram_site_origin',?,unixepoch())
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(origin),
      ...(changedBot ? [
        env.DB.prepare(`UPDATE notification_endpoints SET enabled=0,status='blocked',
          last_error_code='bot_changed',updated_at=unixepoch()`),
        env.DB.prepare(`UPDATE notification_outbox SET status='skipped',last_error_code='bot_changed'
          WHERE status='pending'`),
      ] : []),
    ])
    return reply({ configured: true, botUsername: bot.username, origin })
  } catch (error) {
    const code = error instanceof TelegramApiError ? error.code : 'telegram_setup_failed'
    return reply({ error: 'Telegram Bot 验证或 Webhook 注册失败。', code }, 502)
  }
}

export async function createTelegramPairing(env: Env, user: SessionUser): Promise<Response> {
  if (!telegramReady(env)) return reply({ error: '实例尚未配置 Telegram Bot。' }, 409)
  const botUsername = await telegramSetting(env.DB, 'telegram_bot_username')
  if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
    return reply({ error: '管理员尚未注册 Telegram Webhook。' }, 409)
  }
  const now = Math.floor(Date.now() / 1000)
  const previous = await env.DB.prepare('SELECT created_at FROM telegram_pairing_codes WHERE user_id=?')
    .bind(user.id).first<{ created_at: number }>()
  if (previous && previous.created_at > now - 30) return reply({ error: '请稍后再生成连接链接。' }, 429)
  const code = newPairingCode()
  const hash = await sha256Hex(code)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM telegram_pairing_codes WHERE user_id=?').bind(user.id),
    env.DB.prepare(
      `INSERT INTO telegram_pairing_codes (code_hash,user_id,created_at,expires_at)
       VALUES (?,?,?,?)`,
    ).bind(hash, user.id, now, now + 600),
  ])
  return reply({ url: `https://t.me/${botUsername}?start=${code}`, expiresAt: now + 600 })
}

interface SettingsInput {
  enabled?: unknown
  sources?: unknown
  detailLevel?: unknown
  includeBody?: unknown
  bodyFormat?: unknown
  quietEnabled?: unknown
  quietStart?: unknown
  quietEnd?: unknown
  timezone?: unknown
}

export async function updateTelegramSettings(env: Env, user: SessionUser, request: Request): Promise<Response> {
  const input = await readLimitedJson(request, 4096) as SettingsInput | null
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.enabled !== 'boolean'
    || !Array.isArray(input.sources) || input.sources.length > TELEGRAM_SOURCES.length
    || input.sources.some((source) => typeof source !== 'string' || !telegramSource(source))
    || typeof input.detailLevel !== 'string'
    || !['basic', 'sender', 'subject'].includes(input.detailLevel)
    || (input.includeBody !== undefined && typeof input.includeBody !== 'boolean')
    || (input.bodyFormat !== undefined && (typeof input.bodyFormat !== 'string'
      || !['text', 'rich'].includes(input.bodyFormat)))
    || typeof input.quietEnabled !== 'boolean'
    || !validTime(input.quietStart) || !validTime(input.quietEnd)
    || !validTimezone(input.timezone)) return reply({ error: 'Telegram 通知设置格式不正确。' }, 400)
  const current = await endpoint(env.DB, user.id)
  if (!current) return reply({ error: '请先连接 Telegram。' }, 409)
  const now = Math.floor(Date.now() / 1000)
  const sources = [...new Set(input.sources as string[])]
  const enabling = !current.enabled && input.enabled
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE notification_endpoints SET enabled=?,status='active',sources_json=?,
        detail_level=?,include_body=?,body_format=?,quiet_enabled=?,quiet_start=?,quiet_end=?,timezone=?,
        enabled_at=CASE WHEN enabled=0 AND ?=1 THEN ? ELSE enabled_at END,
        last_error_code='',updated_at=? WHERE user_id=?`,
    ).bind(Number(input.enabled), JSON.stringify(sources), input.detailLevel,
      Number(input.includeBody ?? Boolean(current.include_body)),
      input.bodyFormat ?? current.body_format,
      Number(input.quietEnabled), input.quietStart, input.quietEnd, input.timezone,
      Number(enabling), now, now, user.id),
    env.DB.prepare(
      `UPDATE notification_outbox SET status='skipped',last_error_code='settings_changed'
       WHERE endpoint_id=? AND status='pending'`,
    ).bind(current.id),
  ])
  return getTelegramStatus(env, user)
}

export async function disconnectTelegram(env: Env, user: SessionUser): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM telegram_pairing_codes WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM notification_endpoints WHERE user_id=?').bind(user.id),
  ])
  return reply({ disconnected: true })
}

export async function testTelegram(env: Env, user: SessionUser): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) return reply({ error: '实例尚未配置 Telegram Bot。' }, 409)
  const current = await endpoint(env.DB, user.id)
  if (!current) return reply({ error: '请先连接 Telegram。' }, 409)
  const now = Math.floor(Date.now() / 1000)
  const claim = await env.DB.prepare(
    'UPDATE notification_endpoints SET last_test_at=? WHERE id=? AND last_test_at<=?',
  ).bind(now, current.id, now - 60).run()
  if (!claim.meta.changes) return reply({ error: '测试消息每分钟最多发送一次。' }, 429)
  try {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, current.chat_id, 'OmniMail Telegram 通知连接正常。')
    return reply({ sent: true })
  } catch (error) {
    const code = error instanceof TelegramApiError ? error.code : 'telegram_test_failed'
    return reply({ error: '测试消息发送失败。', code }, 502)
  }
}

interface WebhookUpdate {
  update_id?: unknown
  message?: {
    text?: unknown
    chat?: { id?: unknown; type?: unknown }
    from?: { is_bot?: unknown }
  }
}

export async function handleTelegramWebhook(env: Env, request: Request): Promise<Response> {
  if (!telegramReady(env)) return reply({ ok: false }, 503)
  if (!await matchesWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET!,
    request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '')) {
    return reply({ ok: false }, 403)
  }
  const update = await readLimitedJson(request, 16_384) as WebhookUpdate | null
  if (!update || typeof update !== 'object' || Array.isArray(update)
    || !Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) return reply({ ok: false }, 400)
  const chat = update.message?.chat
  const match = typeof update.message?.text === 'string'
    ? /^\/start(?:@[A-Za-z0-9_]{5,32})? ([A-Za-z0-9_-]{32})$/.exec(update.message.text)
    : null
  if (!match || chat?.type !== 'private' || !Number.isSafeInteger(chat.id) || Number(chat.id) <= 0
    || update.message?.from?.is_bot === true) return reply({ ok: true })
  const now = Math.floor(Date.now() / 1000)
  const hash = await sha256Hex(match[1])
  const row = await env.DB.prepare(
    `SELECT user_id FROM telegram_pairing_codes
     WHERE code_hash=? AND consumed_at IS NULL AND expires_at>=? LIMIT 1`,
  ).bind(hash, now).first<{ user_id: string }>()
  if (!row) return reply({ ok: true })
  const chatId = String(chat.id)
  const other = await env.DB.prepare(
    'SELECT user_id FROM notification_endpoints WHERE chat_id=? AND user_id!=? LIMIT 1',
  ).bind(chatId, row.user_id).first()
  if (other) return reply({ ok: true })
  const consumed = await env.DB.prepare(
    `UPDATE telegram_pairing_codes SET consumed_at=?
     WHERE code_hash=? AND consumed_at IS NULL AND expires_at>=?`,
  ).bind(now, hash, now).run()
  if (!consumed.meta.changes) return reply({ ok: true })
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE notification_outbox SET status='skipped',last_error_code='reconnected'
       WHERE endpoint_id=(SELECT id FROM notification_endpoints WHERE user_id=?) AND status='pending'`,
    ).bind(row.user_id),
    env.DB.prepare(
      `INSERT INTO notification_endpoints
       (id,user_id,chat_id,enabled,status,sources_json,enabled_at,created_at,updated_at)
       VALUES (?,?,?,1,'active',?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,enabled=1,status='active',
         enabled_at=excluded.enabled_at,last_error_code='',updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(), row.user_id, chatId, JSON.stringify(TELEGRAM_SOURCES), now, now, now),
  ])
  try {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN!, chatId, '已连接 OmniMail。你可以在账号设置中选择通知来源。')
  } catch {
    // 配对已成功；Telegram 的确认消息失败不应导致 Webhook 重试或重复绑定。
  }
  return reply({ ok: true })
}
