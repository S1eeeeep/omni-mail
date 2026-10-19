export const TELEGRAM_BODY_MIGRATION = '0039_telegram_message_body.sql'

export const TELEGRAM_BODY_RECOVERY = {
  name: TELEGRAM_BODY_MIGRATION,
  statements: [
    `ALTER TABLE notification_endpoints
ADD COLUMN include_body INTEGER NOT NULL DEFAULT 0 CHECK (include_body IN (0, 1))`,
  ],
} as const
