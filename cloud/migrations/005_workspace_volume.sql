-- Session-scoped persistent workspace volume (Cube Volume mount at /workspace)

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_volume_id TEXT;

CREATE INDEX IF NOT EXISTS sessions_workspace_volume_idx
  ON sessions (workspace_volume_id)
  WHERE workspace_volume_id IS NOT NULL;
