-- PoC 1 minimal schema — ported semantics from runtime/src/db/chat-cursors.ts
-- (single-SQL state transitions; see docs/cloud/serverless-design.md §6)

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  recovery_marker BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, id);

-- Per-session turn state machine. Every transition is a single UPDATE so
-- Postgres guarantees crash-safety with no extra application logic.
CREATE TABLE IF NOT EXISTS session_cursors (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  -- id of the last fully-processed user message
  cursor_message_id BIGINT,
  -- inflight_*: set when a turn begins; survive a crashed replica and drive recovery
  inflight_prev_cursor BIGINT,
  inflight_message_id BIGINT,
  inflight_started_at TIMESTAMPTZ,
  -- failed_*: set when a turn errors
  failed_message_id BIGINT,
  failed_at TIMESTAMPTZ,
  failed_error TEXT,
  -- deferred follow-up queue (jsonb array of {content} objects)
  queued_followups JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- Optional usage log for the KV-cache measurement (real-provider runs only)
CREATE TABLE IF NOT EXISTS turn_usage (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  input_tokens INT,
  cached_tokens INT,
  output_tokens INT,
  db_roundtrips INT,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
