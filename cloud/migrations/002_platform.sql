-- PiClaw Cloud platform schema (P1 subagents + L1 auth/scheduler/quota)

-- ── subagent runs (PG source of truth) ───────────────────────────────

CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sandbox_id TEXT,
  agent_type TEXT NOT NULL DEFAULT 'coding',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled')),
  task TEXT NOT NULL,
  summary TEXT,
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subagent_runs_session_idx ON subagent_runs (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subagent_runs_status_idx ON subagent_runs (status) WHERE status IN ('queued', 'running');

-- ── API keys (Phase 2a — optional bearer auth) ───────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

-- ── session activity (scheduler) ─────────────────────────────────────

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_paused_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sessions_idle_idx ON sessions (last_active_at)
  WHERE sandbox_id IS NOT NULL AND sandbox_paused_at IS NULL;

-- ── daily token quota tracking ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- ── RLS for new tables ───────────────────────────────────────────────

ALTER TABLE subagent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_daily_usage ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY subagent_runs_dev_all ON subagent_runs FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY api_keys_dev_all ON api_keys FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY user_daily_usage_dev_all ON user_daily_usage FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- User-scoped policies (active when app.user_id is set on the connection)
DO $$ BEGIN
  CREATE POLICY sessions_user_scope ON sessions FOR ALL
    USING (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR user_id = current_setting('app.user_id', true)
    )
    WITH CHECK (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR user_id = current_setting('app.user_id', true)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY messages_user_scope ON messages FOR ALL
    USING (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR session_id IN (SELECT id FROM sessions WHERE user_id = current_setting('app.user_id', true))
    )
    WITH CHECK (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR session_id IN (SELECT id FROM sessions WHERE user_id = current_setting('app.user_id', true))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY subagent_runs_user_scope ON subagent_runs FOR ALL
    USING (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR session_id IN (SELECT id FROM sessions WHERE user_id = current_setting('app.user_id', true))
    )
    WITH CHECK (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      OR session_id IN (SELECT id FROM sessions WHERE user_id = current_setting('app.user_id', true))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
