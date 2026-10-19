import { MAIL_SOURCE_WEB_PATHS, OFFICIAL_MAIL_SOURCE_IDS, type OfficialMailSourceId } from '../../../../src/shared/mail/mailSourceContract'
import type { Env } from '../../app/types'

export const TELEGRAM_SOURCES = OFFICIAL_MAIL_SOURCE_IDS
export type TelegramSource = OfficialMailSourceId

const encoder = new TextEncoder()

export function telegramReady(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.NOTIFICATION_QUEUE)
}

export function telegramSource(value: string): value is TelegramSource {
  return TELEGRAM_SOURCES.some((source) => source === value)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function matchesWebhookSecret(expected: string, actual: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256Hex(expected), sha256Hex(actual)])
  let difference = expected.length === actual.length ? 0 : 1
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function notificationRoute(source: TelegramSource, accountId: string, messageId: string): string {
  const query = new URLSearchParams({ source, accountId, messageId })
  return `${MAIL_SOURCE_WEB_PATHS[source]}?${query}`
}

export function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export function quietNow(start: string, end: string, timezone: string, date = new Date()): boolean {
  if (start === end) return false
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const current = Number(parts.find((part) => part.type === 'hour')?.value) * 60
    + Number(parts.find((part) => part.type === 'minute')?.value)
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const from = minute(start)
  const to = minute(end)
  return from < to ? current >= from && current < to : current >= from || current < to
}

export async function telegramSetting(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
    .bind(key).first<{ value: string }>()
  return row?.value ?? ''
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return null
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const data = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)) as unknown
  } catch {
    return null
  }
}
