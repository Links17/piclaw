-- Fence idle sandbox pause work across scheduler replicas.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS pause_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS pause_claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sessions_pause_claim_recovery_idx
  ON sessions (pause_claim_expires_at)
  WHERE pause_claim_token IS NOT NULL;
