import { cachedNotification, cacheNotification, notificationStamp, notificationVersionStatement } from './notification-cache'
import type { Env, SessionUser } from '../../app/types'

export const SOURCES = [
  'omnimail', 'icloud', 'linuxdo', 'gmail', 'microsoft', 'qq', 'naver', 'yandex',
] as const
export type NotificationSource = typeof SOURCES[number]

export const MESSAGE_SELECTS: Record<NotificationSource, string> = {
  omnimail: `SELECT 'omnimail' AS source, '' AS account_id, m.id AS message_id,
    m.sender_name, m.sender_address, m.subject, COALESCE(m.received_at, m.created_at) AS message_date,
    m.is_read
    FROM messages m JOIN mailboxes mb ON mb.address = m.mailbox_address
    WHERE mb.user_id = ? AND mb.cleanup_job_id IS NULL AND m.direction = 'incoming' AND m.folder = 'inbox' AND m.status = 'ready'`,
  icloud: `SELECT 'icloud' AS source, a.id AS account_id, CAST(m.imap_uid AS TEXT) AS message_id,
    m.sender_name, m.sender_address, m.subject, m.internal_date AS message_date, m.is_read
    FROM icloud_imap_messages m JOIN icloud_accounts a ON a.id = m.account_id
    WHERE a.user_id = ? AND a.app_password_cipher <> ''`,
  linuxdo: `SELECT 'linuxdo' AS source, a.id AS account_id, CAST(m.imap_uid AS TEXT) AS message_id,
    m.sender_name, m.sender_address, m.subject, m.internal_date AS message_date, m.is_read
    FROM linux_do_mail_messages m JOIN linux_do_mail_accounts a ON a.id = m.account_id
    WHERE a.user_id = ?`,
  gmail: `SELECT 'gmail' AS source, a.id AS account_id, m.id AS message_id,
    m.sender_name, m.sender_address, m.subject, m.internal_date AS message_date, m.is_read
    FROM gmail_imap_messages m JOIN gmail_imap_accounts a ON a.id = m.account_id
    WHERE a.user_id = ?`,
  microsoft: `SELECT 'microsoft' AS source, a.id AS account_id, m.id AS message_id,
    m.sender_name, m.sender_address, m.subject, m.received_at AS message_date, m.is_read
    FROM microsoft_imap_messages m JOIN microsoft_imap_accounts a ON a.id = m.account_id
    WHERE a.user_id = ? AND m.folder_path = 'INBOX' COLLATE NOCASE`,
  qq: `SELECT 'qq' AS source, a.id AS account_id, m.id AS message_id,
    m.sender_name, m.sender_address, m.subject, m.internal_date AS message_date, m.is_read
    FROM qq_mail_messages m JOIN qq_mail_accounts a ON a.id = m.account_id
    WHERE a.user_id = ?`,
  naver: `SELECT 'naver' AS source, a.id AS account_id, m.id AS message_id,
    m.sender_name, m.sender_address, m.subject, m.internal_date AS message_date, m.is_read
    FROM naver_mail_messages m JOIN naver_mail_accounts a ON a.id = m.account_id
    WHERE a.user_id = ?`,
  yandex: `SELECT 'yandex' AS source, a.id AS account_id, m.id AS message_id,
    m.sender_name, m.sender_address, m.subject, m.internal_date AS message_date, m.is_read
    FROM yandex_mail_messages m JOIN yandex_mail_accounts a ON a.id = m.account_id
    WHERE a.user_id = ?`,
}

const SOURCE_SELECTS: Record<Exclude<NotificationSource, 'omnimail'>, string> = {
  icloud: `SELECT DISTINCT 'icloud' AS source FROM icloud_accounts
    WHERE user_id = ? AND app_password_cipher <> ''`,
  linuxdo: `SELECT DISTINCT 'linuxdo' AS source FROM linux_do_mail_accounts WHERE user_id = ?`,
  gmail: `SELECT DISTINCT 'gmail' AS source FROM gmail_imap_accounts WHERE user_id = ?`,
  microsoft: `SELECT DISTINCT 'microsoft' AS source FROM microsoft_imap_accounts WHERE user_id = ?`,
  qq: `SELECT DISTINCT 'qq' AS source FROM qq_mail_accounts WHERE user_id = ?`,
  naver: `SELECT DISTINCT 'naver' AS source FROM naver_mail_accounts WHERE user_id = ?`,
  yandex: `SELECT DISTINCT 'yandex' AS source FROM yandex_mail_accounts WHERE user_id = ?`,
}

interface NotificationRow {
  source: NotificationSource
  account_id: string
  message_id: string
  sender_name: string
  sender_address: string
  subject: string
  message_date: number
  is_read: number
  unread_total?: number
}

function requestedSources(request: Request): NotificationSource[] {
  const value = new URL(request.url).searchParams.get('sources')
  if (!value?.trim()) return [...SOURCES]
  const requested = value
    .split(',').filter((value): value is NotificationSource => (
      SOURCES.includes(value as NotificationSource)
    ))
  return [...new Set(requested)]
}

export async function listMailNotifications(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  const selected = requestedSources(request)
  const limitValue = Number.parseInt(new URL(request.url).searchParams.get('limit') || '', 10)
  const limit = Number.isSafeInteger(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 50
  if (!selected.length) {
    return Response.json(
      { messages: [], sources: [], unread: 0 },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  const versionStatement = notificationVersionStatement(env.DB, user.id, selected)
  const initialVersions = await versionStatement.all<{ source: string; version: number }>()
  const cacheKey = JSON.stringify([user.id, user.role, [...selected].sort(), limit])
  const cached = cachedNotification(env.DB, cacheKey, notificationStamp(initialVersions.results))
  if (cached) return Response.json(cached, { headers: { 'Cache-Control': 'private, no-store' } })
  // 分来源查询避免 D1 复合 SELECT 项数上限；全部语句仍在同一批次中读取一致快照。
  const statements = selected.flatMap((source) => [
    env.DB.prepare(`${MESSAGE_SELECTS[source]} ORDER BY message_date DESC, message_id DESC, account_id LIMIT ?`).bind(user.id, limit),
    env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END),0) AS unread_total FROM (${MESSAGE_SELECTS[source]})`).bind(user.id),
    source === 'omnimail' ? env.DB.prepare("SELECT 'omnimail' AS source")
      : env.DB.prepare(`${SOURCE_SELECTS[source]} LIMIT 1`).bind(user.id),
  ])
  const batch = await env.DB.batch([...statements, versionStatement])
  const candidates: NotificationRow[] = []
  const sources: NotificationSource[] = []
  let unread = 0
  for (let index = 0; index < selected.length; index++) {
    candidates.push(...batch[index * 3].results as unknown as NotificationRow[])
    unread += Number((batch[index * 3 + 1].results[0] as { unread_total: number }).unread_total)
    if (batch[index * 3 + 2].results.length) sources.push(selected[index])
  }
  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
  const results = candidates.sort((left, right) => right.message_date - left.message_date
    || compareText(right.message_id, left.message_id) || compareText(left.source, right.source)
    || compareText(left.account_id, right.account_id)).slice(0, limit)
  const body = {
    messages: results.map((row) => ({
      source: row.source,
      accountId: row.account_id,
      messageId: row.message_id,
      senderName: row.sender_name,
      senderAddress: row.sender_address,
      subject: row.subject,
      date: row.message_date,
      isRead: Boolean(row.is_read),
    })),
    sources,
    unread,
  }
  cacheNotification(env.DB, cacheKey, notificationStamp(batch.at(-1)!.results as unknown as Array<{ source: string; version: number }>), body)
  return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
}
