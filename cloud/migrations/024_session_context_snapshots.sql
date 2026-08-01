-- Durable context occupancy shared by every brain replica.
-- Ownership is enforced by application queries, matching migration 018.

CREATE TABLE IF NOT EXISTS session_context_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  used_tokens INT NOT NULL CHECK (used_tokens >= 0),
  context_window INT NOT NULL CHECK (context_window > 0),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  through_message_id BIGINT NOT NULL CHECK (through_message_id >= 0),
  latest_message_id BIGINT NOT NULL CHECK (latest_message_id >= through_message_id),
  compacted_through_message_id BIGINT NOT NULL DEFAULT 0
    CHECK (compacted_through_message_id >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE session_context_snapshots
  ADD COLUMN IF NOT EXISTS compacted_through_message_id BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS session_context_snapshots_user_idx
  ON session_context_snapshots (user_id, updated_at DESC);

ALTER TABLE session_context_snapshots DISABLE ROW LEVEL SECURITY;
