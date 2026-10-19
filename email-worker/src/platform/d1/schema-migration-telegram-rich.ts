export const TELEGRAM_RICH_MIGRATION = '0040_telegram_rich_body.sql'

export const TELEGRAM_RICH_RECOVERY = {
  name: TELEGRAM_RICH_MIGRATION,
  statements: [
    `ALTER TABLE notification_endpoints
ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text' CHECK (body_format IN ('text', 'rich'))`,
  ],
} as const
