CREATE TABLE domain_cleanup_jobs (
  id TEXT PRIMARY KEY,
  domain_name TEXT NOT NULL COLLATE NOCASE,
  mode TEXT NOT NULL CHECK (mode IN ('selected', 'all_and_remove')),
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'pending', 'running', 'waiting_for_objects', 'failed', 'completed')),
  previous_active INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_domain_cleanup_active ON domain_cleanup_jobs(domain_name)
  WHERE status NOT IN ('preview', 'completed');

CREATE INDEX idx_domain_cleanup_recovery ON domain_cleanup_jobs(status, updated_at);

CREATE TABLE domain_cleanup_items (
  job_id TEXT NOT NULL REFERENCES domain_cleanup_jobs(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  user_id TEXT NOT NULL,
  previous_active INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  objects_captured INTEGER NOT NULL DEFAULT 0 CHECK (objects_captured IN (0, 1)),
  PRIMARY KEY (job_id, address)
);

CREATE TABLE domain_cleanup_objects (
  job_id TEXT NOT NULL REFERENCES domain_cleanup_jobs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  PRIMARY KEY (job_id, object_key)
);

ALTER TABLE mailboxes ADD COLUMN cleanup_job_id TEXT;

CREATE TRIGGER trg_cleanup_user_delete BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE user_id = OLD.id AND cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

-- 预览与提交间的归属、主邮箱或目标范围变化必须在事务内拒绝。
CREATE TRIGGER trg_domain_cleanup_admission BEFORE UPDATE OF status ON domain_cleanup_jobs
WHEN OLD.status = 'preview' AND NEW.status = 'pending'
BEGIN
  SELECT CASE WHEN NEW.expires_at <= unixepoch()
    OR NOT EXISTS (SELECT 1 FROM domains WHERE name = NEW.domain_name)
    OR NOT EXISTS (SELECT 1 FROM domain_cleanup_items WHERE job_id = NEW.id)
    OR EXISTS (
      SELECT 1 FROM domain_cleanup_items i LEFT JOIN mailboxes m ON m.address = i.address
      WHERE i.job_id = NEW.id AND (m.address IS NULL OR m.user_id != i.user_id
        OR m.is_primary = 1 OR m.is_hidden = 1 OR m.cleanup_job_id IS NOT NULL)
    )
    OR (NEW.mode = 'all_and_remove' AND (
      SELECT COUNT(*) FROM mailboxes WHERE LOWER(SUBSTR(address, INSTR(address, '@') + 1)) = NEW.domain_name
    ) != (SELECT COUNT(*) FROM domain_cleanup_items WHERE job_id = NEW.id))
  THEN RAISE(ABORT, 'domain_cleanup_conflict') END;
END;

-- 所有既有写入口共享数据库保护，不能依赖先查询再修改的权限判断。
CREATE TRIGGER trg_mailbox_cleanup_frozen BEFORE UPDATE ON mailboxes
WHEN OLD.cleanup_job_id IS NOT NULL AND (
  NEW.user_id != OLD.user_id OR NEW.address != OLD.address OR NEW.is_primary != 0
  OR NEW.is_active != 0 OR NEW.is_hidden != 1 OR NEW.cleanup_job_id IS NOT OLD.cleanup_job_id
)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_domain_cleanup_mailbox_insert BEFORE INSERT ON mailboxes
WHEN EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE domain_name = LOWER(SUBSTR(NEW.address, INSTR(NEW.address, '@') + 1))
  AND mode = 'all_and_remove' AND status NOT IN ('preview', 'completed'))
BEGIN
  SELECT RAISE(ABORT, 'domain_cleanup_in_progress');
END;

CREATE TRIGGER trg_domain_cleanup_config_update BEFORE UPDATE ON domains
WHEN EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE domain_name = OLD.name AND status NOT IN ('preview', 'completed'))
BEGIN
  SELECT RAISE(ABORT, 'domain_cleanup_in_progress');
END;

CREATE TRIGGER trg_domain_cleanup_config_delete BEFORE DELETE ON domains
WHEN EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE domain_name = OLD.name AND status NOT IN ('preview', 'completed'))
BEGIN
  SELECT RAISE(ABORT, 'domain_cleanup_in_progress');
END;

CREATE TRIGGER trg_domain_cleanup_config_insert BEFORE INSERT ON domains
WHEN EXISTS (SELECT 1 FROM domain_cleanup_jobs WHERE domain_name = NEW.name AND status NOT IN ('preview', 'completed'))
BEGIN
  SELECT RAISE(ABORT, 'domain_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_message_insert BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE address = NEW.mailbox_address AND cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_message_update BEFORE UPDATE OF mailbox_address, raw_key, body_key, status, attachment_count ON messages
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE address = NEW.mailbox_address AND cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_attachment_insert BEFORE INSERT ON attachments
WHEN EXISTS (SELECT 1 FROM messages m JOIN mailboxes mb ON mb.address = m.mailbox_address
  WHERE m.id = NEW.message_id AND mb.cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_translation_insert BEFORE INSERT ON message_translations
WHEN EXISTS (SELECT 1 FROM messages m JOIN mailboxes mb ON mb.address = m.mailbox_address
  WHERE m.id = NEW.message_id AND mb.cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_draft_insert BEFORE INSERT ON mail_drafts
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE address = NEW.mailbox_address AND cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_draft_update BEFORE UPDATE ON mail_drafts
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE address = NEW.mailbox_address AND cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

CREATE TRIGGER trg_cleanup_draft_attachment_insert BEFORE INSERT ON mail_draft_attachments
WHEN EXISTS (SELECT 1 FROM mail_drafts d JOIN mailboxes mb ON mb.address = d.mailbox_address
  WHERE d.id = NEW.draft_id AND mb.cleanup_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'mailbox_cleanup_in_progress');
END;

-- 记录本任务的对象待办；对象补偿完成后即使邮箱已删除仍能核对真实进度。
CREATE TRIGGER trg_domain_cleanup_objects AFTER INSERT ON pending_object_deletions
BEGIN
  INSERT OR IGNORE INTO domain_cleanup_objects (job_id, object_key)
  SELECT mb.cleanup_job_id, NEW.object_key FROM mailboxes mb
  WHERE mb.cleanup_job_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM messages m WHERE m.mailbox_address = mb.address AND (m.raw_key = NEW.object_key OR m.body_key = NEW.object_key))
    OR EXISTS (SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.mailbox_address = mb.address AND a.r2_key = NEW.object_key)
    OR EXISTS (SELECT 1 FROM message_translations t JOIN messages m ON m.id = t.message_id WHERE m.mailbox_address = mb.address AND t.r2_key = NEW.object_key)
    OR EXISTS (SELECT 1 FROM mail_draft_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.mailbox_address = mb.address AND a.r2_key = NEW.object_key)
  );
END;
