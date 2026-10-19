export const TELEGRAM_MIGRATION = '0038_telegram_notifications.sql'

export const TELEGRAM_RECOVERY = {
  name: TELEGRAM_MIGRATION,
  statements: [
    `CREATE TABLE IF NOT EXISTS notification_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
  detail_level TEXT NOT NULL DEFAULT 'basic' CHECK (detail_level IN ('basic', 'sender', 'subject')),
  quiet_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_enabled IN (0, 1)),
  quiet_start TEXT NOT NULL DEFAULT '22:00',
  quiet_end TEXT NOT NULL DEFAULT '07:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled_at INTEGER NOT NULL,
  last_test_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS telegram_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
)`,
    `CREATE INDEX IF NOT EXISTS idx_telegram_pairing_expiry ON telegram_pairing_codes(expires_at)`,
    `CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES notification_endpoints(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('omnimail','icloud','linuxdo','gmail','microsoft','qq','naver','yandex')),
  account_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  enqueued_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '',
  UNIQUE(endpoint_id, source, account_id, message_id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, next_attempt_at, enqueued_at, lease_until, id)`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_omnimail_ready
AFTER UPDATE OF status ON messages
WHEN OLD.status IS NOT 'ready' AND NEW.status = 'ready'
  AND NEW.direction = 'incoming' AND NEW.folder = 'inbox' AND NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'omnimail', '', NEW.id, unixepoch(), unixepoch()
  FROM mailboxes mb JOIN notification_endpoints e ON e.user_id = mb.user_id
  WHERE mb.address = NEW.mailbox_address AND e.enabled = 1 AND e.status = 'active'
    AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'omnimail');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_icloud_insert
AFTER INSERT ON icloud_imap_messages
WHEN NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'icloud', NEW.account_id, CAST(NEW.imap_uid AS TEXT), unixepoch(), unixepoch()
  FROM icloud_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL AND a.app_password_cipher <> ''
    AND a.uid_validity = NEW.uid_validity AND NEW.imap_uid > a.last_seen_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'icloud');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_linuxdo_insert
AFTER INSERT ON linux_do_mail_messages
WHEN NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'linuxdo', NEW.account_id, CAST(NEW.imap_uid AS TEXT), unixepoch(), unixepoch()
  FROM linux_do_mail_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL
    AND a.uid_validity = NEW.uid_validity AND NEW.imap_uid > a.last_seen_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'linuxdo');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_gmail_insert
AFTER INSERT ON gmail_imap_messages
WHEN NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'gmail', NEW.account_id, CAST(NEW.id AS TEXT), unixepoch(), unixepoch()
  FROM gmail_imap_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL
    AND a.uid_validity = NEW.uid_validity AND NEW.imap_uid > a.last_seen_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'gmail');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_qq_insert
AFTER INSERT ON qq_mail_messages
WHEN NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'qq', NEW.account_id, CAST(NEW.id AS TEXT), unixepoch(), unixepoch()
  FROM qq_mail_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL
    AND a.uid_validity = NEW.uid_validity AND NEW.imap_uid > a.last_seen_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'qq');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_naver_insert
AFTER INSERT ON naver_mail_messages
WHEN NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'naver', NEW.account_id, CAST(NEW.id AS TEXT), unixepoch(), unixepoch()
  FROM naver_mail_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL
    AND a.uid_validity = NEW.uid_validity AND NEW.imap_uid > a.last_seen_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'naver');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_yandex_insert
AFTER INSERT ON yandex_mail_messages
WHEN NEW.is_read = 0
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'yandex', NEW.account_id, CAST(NEW.id AS TEXT), unixepoch(), unixepoch()
  FROM yandex_mail_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL
    AND a.uid_validity = NEW.uid_validity AND NEW.imap_uid > a.last_seen_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'yandex');
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_telegram_microsoft_insert
AFTER INSERT ON microsoft_imap_messages
WHEN NEW.is_read = 0 AND NEW.folder_path = 'INBOX' COLLATE NOCASE
BEGIN
  INSERT OR IGNORE INTO notification_outbox
    (id, endpoint_id, source, account_id, message_id, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), e.id, 'microsoft', NEW.account_id, NEW.id, unixepoch(), unixepoch()
  FROM microsoft_imap_accounts a JOIN notification_endpoints e ON e.user_id = a.user_id
  JOIN microsoft_imap_folders f ON f.account_id = NEW.account_id AND f.path = NEW.folder_path
  WHERE a.id = NEW.account_id AND a.last_synced_at IS NOT NULL
    AND f.uid_validity = NEW.uid_validity AND NEW.imap_uid > f.last_uid
    AND e.enabled = 1 AND e.status = 'active' AND NEW.created_at >= e.enabled_at
    AND EXISTS (SELECT 1 FROM json_each(e.sources_json) WHERE value = 'microsoft');
END`,
  ],
} as const
