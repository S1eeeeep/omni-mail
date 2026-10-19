-- 实际收件地址包含未分配邮件的 delivered_to；不把频繁变化的已读、星标加入新索引。
CREATE INDEX IF NOT EXISTS idx_messages_recipient_folder_sort
  ON messages(COALESCE(delivered_to, mailbox_address), folder, sort_at DESC, id DESC, direction, mailbox_address);

-- 空操作不递增同步版本；地址或方向真正变化时，也必须使列表和统计缓存失效。
DROP TRIGGER IF EXISTS trg_messages_mail_state_update;
CREATE TRIGGER trg_messages_mail_state_update
AFTER UPDATE OF status, folder, sender_name, sender_address, subject, preview,
  received_at, sent_at, attachment_count, is_read, is_starred, processing_error,
  delivery_status, mailbox_address, delivered_to, direction
ON messages
WHEN OLD.status IS NOT NEW.status OR OLD.folder IS NOT NEW.folder
  OR OLD.sender_name IS NOT NEW.sender_name OR OLD.sender_address IS NOT NEW.sender_address
  OR OLD.subject IS NOT NEW.subject OR OLD.preview IS NOT NEW.preview
  OR OLD.received_at IS NOT NEW.received_at OR OLD.sent_at IS NOT NEW.sent_at
  OR OLD.attachment_count IS NOT NEW.attachment_count OR OLD.is_read IS NOT NEW.is_read
  OR OLD.is_starred IS NOT NEW.is_starred OR OLD.processing_error IS NOT NEW.processing_error
  OR OLD.delivery_status IS NOT NEW.delivery_status OR OLD.mailbox_address IS NOT NEW.mailbox_address
  OR OLD.delivered_to IS NOT NEW.delivered_to OR OLD.direction IS NOT NEW.direction
BEGIN
  INSERT INTO mail_state_versions (user_id, version, updated_at)
  SELECT DISTINCT mb.user_id, 1, unixepoch() FROM mailboxes mb
   WHERE mb.address IN (OLD.mailbox_address, NEW.mailbox_address)
  ON CONFLICT(user_id) DO UPDATE SET
    version = mail_state_versions.version + 1, updated_at = excluded.updated_at;
END;

-- 邮箱归属或可见性改变时立即失效，避免在权限收紧后复用旧统计。
CREATE TRIGGER IF NOT EXISTS trg_mailboxes_mail_state_visibility
AFTER UPDATE OF user_id, is_hidden, address ON mailboxes
WHEN OLD.user_id IS NOT NEW.user_id OR OLD.is_hidden IS NOT NEW.is_hidden OR OLD.address IS NOT NEW.address
BEGIN
  INSERT INTO mail_state_versions (user_id, version, updated_at)
  SELECT id, 1, unixepoch() FROM users WHERE id IN (OLD.user_id, NEW.user_id)
  ON CONFLICT(user_id) DO UPDATE SET
    version = mail_state_versions.version + 1, updated_at = excluded.updated_at;
END;
