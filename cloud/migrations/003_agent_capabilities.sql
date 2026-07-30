-- P2 agent capabilities: question, plan mode, todos, subagent extensions

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'execute';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS todos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mcp_servers JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS plan_text TEXT;

ALTER TABLE subagent_runs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subagent_runs ADD COLUMN IF NOT EXISTS max_turns INT;
ALTER TABLE subagent_runs ADD COLUMN IF NOT EXISTS background BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subagent_runs ADD COLUMN IF NOT EXISTS tool_count INT NOT NULL DEFAULT 0;
ALTER TABLE subagent_runs ADD COLUMN IF NOT EXISTS resume_parent_id TEXT;

ALTER TABLE subagent_runs DROP CONSTRAINT IF EXISTS subagent_runs_status_check;
ALTER TABLE subagent_runs ADD CONSTRAINT subagent_runs_status_check
  CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled', 'stopped'));

CREATE TABLE IF NOT EXISTS subagent_messages (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  content_blocks JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subagent_messages_run_idx ON subagent_messages (run_id, id);

DROP TABLE IF EXISTS session_skills;

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('system', 'user')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'installed',
  source_path TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'system' AND user_id IS NULL)
    OR (scope = 'user' AND user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS skills_scope_user_name_idx
  ON skills (scope, COALESCE(user_id, ''), name);

CREATE INDEX IF NOT EXISTS skills_user_idx ON skills (user_id, scope) WHERE scope = 'user';

ALTER TABLE subagent_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY subagent_messages_dev_all ON subagent_messages FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY skills_dev_all ON skills FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY skills_user_scope ON skills FOR ALL
    USING (
      scope = 'system'
      OR NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR user_id = current_setting('app.user_id', true)
    )
    WITH CHECK (
      scope = 'user'
      AND (
        NULLIF(current_setting('app.user_id', true), '') IS NULL
        OR user_id = current_setting('app.user_id', true)
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
