-- Extend scheduled_tasks + task run logs for cloud feature parity.

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS task_kind TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS notify_on_complete BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_result TEXT,
  ADD COLUMN IF NOT EXISTS summary TEXT;

CREATE TABLE IF NOT EXISTS task_run_logs (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS task_run_logs_task_id_idx ON task_run_logs (task_id, run_at DESC);

ALTER TABLE task_run_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY task_run_logs_dev_all ON task_run_logs FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
