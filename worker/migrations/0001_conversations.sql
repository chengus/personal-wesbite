CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    reply_token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX conversations_expiry ON conversations(expires_at);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('visitor', 'lucent')),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX messages_pending ON messages(next_attempt) WHERE role = 'visitor' AND notified = 0;

CREATE TABLE daily_submissions (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL
);
