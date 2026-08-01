-- Fail-closed recovery audit for tasks whose side effects may have started.
CREATE INDEX IF NOT EXISTS scheduled_tasks_manual_recovery_idx
  ON scheduled_tasks (status, execution_started_at)
  WHERE status = 'paused' AND execution_started_at IS NOT NULL;
