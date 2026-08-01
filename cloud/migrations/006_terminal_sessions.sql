ALTER TABLE sessions ADD COLUMN IF NOT EXISTS terminal_pid INTEGER;
CREATE INDEX IF NOT EXISTS sessions_terminal_pid_idx
  ON sessions (terminal_pid)
  WHERE terminal_pid IS NOT NULL;
