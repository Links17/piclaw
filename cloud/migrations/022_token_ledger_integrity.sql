-- High-integrity token accounting: constraints, leases and reservations.

UPDATE token_usage SET attempt = 1 WHERE operation_id IS NOT NULL AND attempt IS NULL;
ALTER TABLE token_usage ALTER COLUMN status SET DEFAULT 'success';

DO $$ BEGIN
  ALTER TABLE token_usage ADD CONSTRAINT token_usage_status_check
    CHECK (status IN ('success', 'error', 'aborted', 'failed', 'timed_out', 'stopped')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE token_usage ADD CONSTRAINT token_usage_attempt_check
    CHECK (attempt IS NULL OR attempt > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE token_usage ADD CONSTRAINT token_usage_nonnegative_check
    CHECK (
      input_tokens >= 0 AND output_tokens >= 0 AND reasoning_tokens >= 0
      AND cache_read_tokens >= 0 AND cache_write_tokens >= 0 AND total_tokens >= 0
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE invalid_count BIGINT;
DECLARE duplicate_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_count FROM token_usage
  WHERE status NOT IN ('success', 'error', 'aborted', 'failed', 'timed_out', 'stopped')
    OR (attempt IS NOT NULL AND attempt <= 0)
    OR input_tokens < 0 OR output_tokens < 0 OR reasoning_tokens < 0
    OR cache_read_tokens < 0 OR cache_write_tokens < 0 OR total_tokens < 0;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'token_usage has % invalid status/attempt/token rows', invalid_count;
  END IF;
  SELECT COUNT(*) INTO duplicate_count FROM (
    SELECT session_id, usage_source, operation_id, attempt, COALESCE(stage, '')
    FROM token_usage
    WHERE operation_id IS NOT NULL AND attempt IS NOT NULL
    GROUP BY session_id, usage_source, operation_id, attempt, COALESCE(stage, '')
    HAVING COUNT(*) > 1
  ) duplicate_operations;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'token_usage has % duplicate operation attempts', duplicate_count;
  END IF;
END $$;

ALTER TABLE token_usage VALIDATE CONSTRAINT token_usage_status_check;
ALTER TABLE token_usage VALIDATE CONSTRAINT token_usage_attempt_check;
ALTER TABLE token_usage VALIDATE CONSTRAINT token_usage_nonnegative_check;

CREATE UNIQUE INDEX IF NOT EXISTS token_usage_operation_attempt_unique_idx
  ON token_usage (session_id, usage_source, operation_id, attempt, COALESCE(stage, ''))
  WHERE operation_id IS NOT NULL AND attempt IS NOT NULL;

DO $$
DECLARE existing_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
  INTO existing_definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema()
    AND t.relname = 'token_usage'
    AND c.conname = 'token_usage_subagent_run_id_fkey';

  IF existing_definition IS NULL THEN
    ALTER TABLE token_usage ADD CONSTRAINT token_usage_subagent_run_id_fkey
      FOREIGN KEY (subagent_run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE;
  ELSIF existing_definition NOT ILIKE '%REFERENCES subagent_runs(id) ON DELETE CASCADE%' THEN
    RAISE EXCEPTION
      'token_usage_subagent_run_id_fkey has unexpected definition: %',
      existing_definition;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subagent_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'stopped')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS subagent_one_active_invocation_idx
  ON subagent_invocations (run_id) WHERE status = 'running';

ALTER TABLE side_prompt_operations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE side_prompt_operations ADD COLUMN IF NOT EXISTS owner_token TEXT;
UPDATE side_prompt_operations
SET lease_expires_at = COALESCE(lease_expires_at, updated_at + interval '5 minutes')
WHERE lease_expires_at IS NULL;
ALTER TABLE side_prompt_operations ALTER COLUMN lease_expires_at SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE side_prompt_operations ADD CONSTRAINT side_prompt_operations_status_check
    CHECK (status IN ('running', 'completed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE side_prompt_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE side_prompt_operations DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS token_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  estimated_tokens INT NOT NULL CHECK (estimated_tokens >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'settled', 'released', 'expired')),
  actual_input_tokens INT NOT NULL DEFAULT 0 CHECK (actual_input_tokens >= 0),
  actual_output_tokens INT NOT NULL DEFAULT 0 CHECK (actual_output_tokens >= 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (user_id, operation_id)
);
CREATE INDEX IF NOT EXISTS token_reservations_active_idx
  ON token_reservations (user_id, lease_expires_at) WHERE status = 'active';
