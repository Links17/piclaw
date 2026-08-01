-- Fencing generations and database-assigned provider attempts.

ALTER TABLE token_reservations ADD COLUMN IF NOT EXISTS generation INT NOT NULL DEFAULT 1;
ALTER TABLE token_reservations ADD COLUMN IF NOT EXISTS owner_token TEXT;
UPDATE token_reservations SET owner_token = COALESCE(owner_token, id) WHERE owner_token IS NULL;
ALTER TABLE token_reservations ALTER COLUMN owner_token SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE token_reservations ADD CONSTRAINT token_reservations_generation_check
    CHECK (generation > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE token_reservations VALIDATE CONSTRAINT token_reservations_generation_check;

ALTER TABLE subagent_invocations ADD COLUMN IF NOT EXISTS generation INT NOT NULL DEFAULT 1;
ALTER TABLE subagent_invocations ADD COLUMN IF NOT EXISTS owner_token TEXT;
UPDATE subagent_invocations SET owner_token = COALESCE(owner_token, id) WHERE owner_token IS NULL;
ALTER TABLE subagent_invocations ALTER COLUMN owner_token SET NOT NULL;

CREATE TABLE IF NOT EXISTS token_attempt_counters (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  usage_source TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  last_attempt INT NOT NULL DEFAULT 0 CHECK (last_attempt >= 0),
  PRIMARY KEY (session_id, usage_source, operation_id, stage)
);

ALTER TABLE side_prompt_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE side_prompt_operations DISABLE ROW LEVEL SECURITY;
