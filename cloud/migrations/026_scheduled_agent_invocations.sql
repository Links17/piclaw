-- A scheduled task is a trigger plus a durable invocation template.

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS invocation JSONB;

UPDATE scheduled_tasks
SET invocation = jsonb_build_object(
  'version', 1,
  'agentType', 'general-purpose',
  'executionBackend', 'sandbox',
  'prompt', prompt,
  'description', 'scheduled:' || id
)
WHERE task_kind = 'agent' AND invocation IS NULL;

DO $$ BEGIN
  ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_invocation_object_check
    CHECK (invocation IS NULL OR jsonb_typeof(invocation) = 'object') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE scheduled_tasks VALIDATE CONSTRAINT scheduled_tasks_invocation_object_check;
