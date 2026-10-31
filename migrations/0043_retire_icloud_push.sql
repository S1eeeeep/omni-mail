-- The icloud-mail owner migrated this exact receiver to the local mailbox.
-- Retire only that integration. Preserve every mail/outbox/error record and
-- all other users' configured receivers; no destructive queue cleanup.
UPDATE mail_push_subscriptions SET enabled=0,updated_at=unixepoch()
WHERE callback_url='https://icloud.dasaogang.eu.cc/api/integrations/omnimail/events';
UPDATE mail_push_routes SET enabled=0
WHERE subscription_id IN(SELECT id FROM mail_push_subscriptions
 WHERE callback_url='https://icloud.dasaogang.eu.cc/api/integrations/omnimail/events');
