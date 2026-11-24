-- Structured data shown with a message (a card, an attachment marker, an error
-- code), as JSON. The text in `content` stays complete on its own, for channels
-- that only show text.
ALTER TABLE messages ADD COLUMN meta TEXT;

-- A receipt that was read only in part and is waiting for the user to supply
-- the rest. One per user; replaced by the next receipt and removed when a draft
-- is created. Holds extracted fields only, never the image.
CREATE TABLE pending_receipts (
  user_id INTEGER PRIMARY KEY REFERENCES users (id),
  analysis TEXT NOT NULL, -- JSON
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
