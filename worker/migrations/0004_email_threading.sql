-- Keep real RFC Message-IDs for email threading; old message IDs were not retained.
ALTER TABLE messages ADD COLUMN email_message_id TEXT;
ALTER TABLE messages ADD COLUMN email_references TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN email_recorded_at INTEGER;
CREATE INDEX messages_email_thread ON messages(conversation_id, email_recorded_at)
WHERE email_message_id IS NOT NULL;
