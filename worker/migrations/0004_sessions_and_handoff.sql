-- A browser session is a key to an account, no longer an account of its own.
-- Several sessions can open the same account (a phone browser and a laptop,
-- both continuing from Telegram). Only a SHA-256 hash of the cookie is kept.
CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL -- ISO 8601, UTC
);
CREATE INDEX idx_web_sessions_user ON web_sessions (user_id);

-- Every existing guest cookie keeps working: its hash is already stored as the
-- guest user's external_id ("s:" + hex).
INSERT INTO web_sessions (token_hash, user_id, expires_at)
SELECT substr(external_id, 3), id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
FROM users
WHERE channel = 'web' AND external_id LIKE 's:%';

-- One-time tickets the Telegram bot issues so a browser can open that
-- Telegram account. A ticket is a long link token and a short typed code;
-- neither is stored, only a hash of each.
CREATE TABLE handoff_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  link_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the 256-bit link token
  code_hash TEXT NOT NULL UNIQUE, -- HMAC-SHA256 of the 8-character code, keyed with a server secret
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL, -- ISO 8601, UTC
  used_at TEXT,
  -- The session this ticket created. Lets redemption be one transaction: the
  -- session row is inserted only if this exact redemption marked the ticket used.
  session_hash TEXT
);
CREATE INDEX idx_handoff_tokens_user ON handoff_tokens (user_id);
