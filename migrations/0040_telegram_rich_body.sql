ALTER TABLE notification_endpoints
ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text' CHECK (body_format IN ('text', 'rich'));
