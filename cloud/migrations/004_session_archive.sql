-- Session archive lifecycle (Web UI branch-prune compatibility)

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions (user_id, updated_at DESC)
  WHERE archived_at IS NULL;

-- Ensure session_cursors cascades on session purge (legacy PoC DBs may lack this).
ALTER TABLE session_cursors DROP CONSTRAINT IF EXISTS session_cursors_session_id_fkey;
ALTER TABLE session_cursors ADD CONSTRAINT session_cursors_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
