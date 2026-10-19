ALTER TABLE notification_endpoints
ADD COLUMN include_body INTEGER NOT NULL DEFAULT 0 CHECK (include_body IN (0, 1));
