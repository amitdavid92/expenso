-- One row per model request made in the last minute, for the application-wide
-- rolling rate limit (Gemini's free tier allows a fixed number of requests per
-- minute). Rows older than a minute are deleted as new ones arrive.
CREATE TABLE llm_request_log (
  id INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL -- Unix time in milliseconds
);
CREATE INDEX idx_llm_request_log_at ON llm_request_log (at_ms);
