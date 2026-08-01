-- Atomically mark a leased task as executing before any side effects.
ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS scheduled_tasks_execution_idx
  ON scheduled_tasks (execution_started_at)
  WHERE claim_token IS NOT NULL;
