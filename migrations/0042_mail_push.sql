-- Applied explicitly by the deployment migration command, never startup DDL.
ALTER TABLE messages ADD COLUMN push_headers_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE mail_push_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 callback_url TEXT NOT NULL,
 secret_cipher TEXT NOT NULL,
 secret_hash TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE UNIQUE INDEX mail_push_active_owner ON mail_push_subscriptions(user_id) WHERE enabled=1;
CREATE TABLE mail_push_routes (
 subscription_id TEXT NOT NULL REFERENCES mail_push_subscriptions(id) ON DELETE CASCADE,
 mailbox_address TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1,
 next_sequence INTEGER NOT NULL DEFAULT 0,
 initialized INTEGER NOT NULL DEFAULT 0,
 backfill_since INTEGER NOT NULL DEFAULT(unixepoch()-86400),
 backfill_created INTEGER NOT NULL DEFAULT 0,
 backfill_id TEXT NOT NULL DEFAULT '',
 enqueued_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT NOT NULL DEFAULT '',
 last_sent_at INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(subscription_id,mailbox_address)
);
CREATE TABLE mail_push_outbox (
 event_id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))),
 subscription_id TEXT NOT NULL,
 mailbox_address TEXT NOT NULL,
 sequence INTEGER NOT NULL DEFAULT 0,
 message_id TEXT NOT NULL,
 event_kind TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 announced INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 sent_at INTEGER,
 UNIQUE(subscription_id,mailbox_address,message_id,event_kind),
 FOREIGN KEY(subscription_id,mailbox_address) REFERENCES mail_push_routes(subscription_id,mailbox_address) ON DELETE CASCADE
);
CREATE INDEX mail_push_due ON mail_push_outbox(subscription_id,mailbox_address,status,announced,sequence,next_attempt_at);
CREATE TRIGGER mail_push_assign_sequence AFTER INSERT ON mail_push_outbox BEGIN
 UPDATE mail_push_routes SET next_sequence=next_sequence+1
 WHERE subscription_id=NEW.subscription_id AND mailbox_address=NEW.mailbox_address;
 UPDATE mail_push_outbox SET sequence=(SELECT next_sequence FROM mail_push_routes WHERE subscription_id=NEW.subscription_id AND mailbox_address=NEW.mailbox_address)
 WHERE event_id=NEW.event_id;
END;
