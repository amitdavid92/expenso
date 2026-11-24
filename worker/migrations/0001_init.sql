-- Expenso initial schema.
-- Identity is (channel, external_id): web and Telegram users are never linked.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web')),
  external_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (channel, external_id)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_messages_user ON messages (user_id, id);

-- status: draft -> submitted | cancelled. "submitted" means sent for review,
-- not approved for reimbursement. policy_result records the policy verdict.
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category TEXT NOT NULL,
  merchant TEXT NOT NULL,
  expense_date TEXT NOT NULL, -- YYYY-MM-DD
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'cancelled')),
  policy_result TEXT NOT NULL CHECK (policy_result IN ('within_policy', 'needs_review')),
  policy_notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TEXT
);
CREATE INDEX idx_expenses_user ON expenses (user_id, status, expense_date);

-- At most one active draft per user, enforced by the database.
CREATE UNIQUE INDEX idx_one_draft_per_user ON expenses (user_id) WHERE status = 'draft';

-- Daily counters protecting the free Gemini quota. scope is 'app' or 'user:<id>'.
CREATE TABLE usage_daily (
  day TEXT NOT NULL, -- YYYY-MM-DD in US Pacific time (when the Gemini quota resets)
  scope TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);

-- Telegram may redeliver an update; each update_id is processed once.
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY
);
