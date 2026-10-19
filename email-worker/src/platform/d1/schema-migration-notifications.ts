export const NOTIFICATION_MIGRATION = '0037_mail_notification_versions.sql'

export const NOTIFICATION_RECOVERY = {
  name: NOTIFICATION_MIGRATION,
  statements: [
    `CREATE TABLE IF NOT EXISTS mail_notification_versions (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, source))`,
    `CREATE TRIGGER IF NOT EXISTS trg_icloud_notification_insert AFTER INSERT ON icloud_imap_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'icloud', 1 FROM icloud_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=icloud_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_icloud_notification_delete AFTER DELETE ON icloud_imap_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'icloud', 1 FROM icloud_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=icloud_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_icloud_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, internal_date, imap_uid ON icloud_imap_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.internal_date IS NOT NEW.internal_date OR OLD.imap_uid IS NOT NEW.imap_uid
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'icloud', 1 FROM icloud_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=icloud_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_icloud_notification_account_insert AFTER INSERT ON icloud_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'icloud', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_icloud_notification_account_delete BEFORE DELETE ON icloud_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'icloud', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_icloud_notification_account_update AFTER UPDATE OF user_id, app_password_cipher ON icloud_accounts
WHEN OLD.user_id IS NOT NEW.user_id OR OLD.app_password_cipher IS NOT NEW.app_password_cipher
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'icloud', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_linuxdo_notification_insert AFTER INSERT ON linux_do_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'linuxdo', 1 FROM linux_do_mail_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=linux_do_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_linuxdo_notification_delete AFTER DELETE ON linux_do_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'linuxdo', 1 FROM linux_do_mail_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=linux_do_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_linuxdo_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, internal_date, imap_uid ON linux_do_mail_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.internal_date IS NOT NEW.internal_date OR OLD.imap_uid IS NOT NEW.imap_uid
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'linuxdo', 1 FROM linux_do_mail_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=linux_do_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_linuxdo_notification_account_insert AFTER INSERT ON linux_do_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'linuxdo', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_linuxdo_notification_account_delete BEFORE DELETE ON linux_do_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'linuxdo', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_linuxdo_notification_account_update AFTER UPDATE OF user_id ON linux_do_mail_accounts
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'linuxdo', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_gmail_notification_insert AFTER INSERT ON gmail_imap_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'gmail', 1 FROM gmail_imap_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=gmail_imap_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_gmail_notification_delete AFTER DELETE ON gmail_imap_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'gmail', 1 FROM gmail_imap_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=gmail_imap_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_gmail_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, internal_date, id ON gmail_imap_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.internal_date IS NOT NEW.internal_date OR OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'gmail', 1 FROM gmail_imap_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=gmail_imap_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_gmail_notification_account_insert AFTER INSERT ON gmail_imap_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'gmail', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_gmail_notification_account_delete BEFORE DELETE ON gmail_imap_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'gmail', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_gmail_notification_account_update AFTER UPDATE OF user_id ON gmail_imap_accounts
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'gmail', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_microsoft_notification_insert AFTER INSERT ON microsoft_imap_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'microsoft', 1 FROM microsoft_imap_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=microsoft_imap_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_microsoft_notification_delete AFTER DELETE ON microsoft_imap_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'microsoft', 1 FROM microsoft_imap_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=microsoft_imap_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_microsoft_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, received_at, id, folder_path ON microsoft_imap_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.received_at IS NOT NEW.received_at OR OLD.id IS NOT NEW.id OR OLD.folder_path IS NOT NEW.folder_path
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'microsoft', 1 FROM microsoft_imap_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=microsoft_imap_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_microsoft_notification_account_insert AFTER INSERT ON microsoft_imap_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'microsoft', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_microsoft_notification_account_delete BEFORE DELETE ON microsoft_imap_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'microsoft', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_microsoft_notification_account_update AFTER UPDATE OF user_id ON microsoft_imap_accounts
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'microsoft', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_qq_notification_insert AFTER INSERT ON qq_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'qq', 1 FROM qq_mail_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=qq_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_qq_notification_delete AFTER DELETE ON qq_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'qq', 1 FROM qq_mail_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=qq_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_qq_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, internal_date, id ON qq_mail_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.internal_date IS NOT NEW.internal_date OR OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'qq', 1 FROM qq_mail_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=qq_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_qq_notification_account_insert AFTER INSERT ON qq_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'qq', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_qq_notification_account_delete BEFORE DELETE ON qq_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'qq', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_qq_notification_account_update AFTER UPDATE OF user_id ON qq_mail_accounts
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'qq', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_naver_notification_insert AFTER INSERT ON naver_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'naver', 1 FROM naver_mail_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=naver_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_naver_notification_delete AFTER DELETE ON naver_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'naver', 1 FROM naver_mail_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=naver_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_naver_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, internal_date, id ON naver_mail_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.internal_date IS NOT NEW.internal_date OR OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'naver', 1 FROM naver_mail_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=naver_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_naver_notification_account_insert AFTER INSERT ON naver_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'naver', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_naver_notification_account_delete BEFORE DELETE ON naver_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'naver', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_naver_notification_account_update AFTER UPDATE OF user_id ON naver_mail_accounts
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'naver', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_yandex_notification_insert AFTER INSERT ON yandex_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'yandex', 1 FROM yandex_mail_accounts WHERE id = NEW.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=yandex_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_yandex_notification_delete AFTER DELETE ON yandex_mail_messages BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT user_id, 'yandex', 1 FROM yandex_mail_accounts WHERE id = OLD.account_id AND EXISTS (SELECT 1 FROM users WHERE users.id=yandex_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_yandex_notification_update AFTER UPDATE OF account_id, sender_name, sender_address, subject, is_read, internal_date, id ON yandex_mail_messages
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address OR OLD.subject IS NOT NEW.subject OR OLD.is_read IS NOT NEW.is_read OR OLD.internal_date IS NOT NEW.internal_date OR OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT DISTINCT user_id, 'yandex', 1 FROM yandex_mail_accounts WHERE id IN (OLD.account_id,NEW.account_id) AND EXISTS (SELECT 1 FROM users WHERE users.id=yandex_mail_accounts.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_yandex_notification_account_insert AFTER INSERT ON yandex_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'yandex', 1 FROM users WHERE id=NEW.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_yandex_notification_account_delete BEFORE DELETE ON yandex_mail_accounts BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'yandex', 1 FROM users WHERE id=OLD.user_id ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
    `CREATE TRIGGER IF NOT EXISTS trg_yandex_notification_account_update AFTER UPDATE OF user_id ON yandex_mail_accounts
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  INSERT INTO mail_notification_versions (user_id,source,version) SELECT id, 'yandex', 1 FROM users WHERE id IN (OLD.user_id,NEW.user_id) ON CONFLICT(user_id,source) DO UPDATE SET version=version+1;
END`,
  ],
}
