-- Session branch lineage for cloud web compatibility.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_message_id BIGINT
  REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS inherited_message_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS sessions_parent_idx
  ON sessions (parent_session_id, updated_at DESC)
  WHERE parent_session_id IS NOT NULL;
