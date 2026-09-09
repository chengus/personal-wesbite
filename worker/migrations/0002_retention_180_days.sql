-- Extend existing conversations that used the original 90-day retention.
-- Preserve any manually overridden expiration dates.
UPDATE conversations
SET expires_at = created_at + 15552000000
WHERE expires_at = created_at + 7776000000;
