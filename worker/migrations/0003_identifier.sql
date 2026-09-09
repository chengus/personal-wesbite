-- Optional self-description; existing conversations remain anonymous.
ALTER TABLE conversations ADD COLUMN identifier TEXT NOT NULL DEFAULT '';
