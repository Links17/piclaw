-- Scheduler task leases: permit recovery after a worker crashes mid-run.

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS scheduled_tasks_claim_recovery_idx
  ON scheduled_tasks (claim_expires_at)
  WHERE claim_token IS NOT NULL;
