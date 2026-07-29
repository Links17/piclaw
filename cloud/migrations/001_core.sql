-- PiClaw Cloud MVP schema (Phase 1a)
-- Ported from docs/storage.md + cloud/poc/turn-loop/schema.sql

-- ── users (Phase 1: single placeholder user; Phase 2: OAuth) ────────

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO users (id, email, display_name)
VALUES ('default-user', 'local@piclaw.dev', 'Local User')
ON CONFLICT DO NOTHING;

-- ── sessions (maps to self-hosted chat_jid) ───────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  sandbox_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade path from PoC 1 schema (sessions without user_id)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE sessions SET user_id = 'default-user' WHERE user_id IS NULL;
DO $$ BEGIN
  ALTER TABLE sessions ALTER COLUMN user_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, updated_at DESC);

-- ── messages ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  content_blocks JSONB,
  recovery_marker BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, id);

-- ── session turn state machine (from runtime chat_cursors) ────────────

CREATE TABLE IF NOT EXISTS session_cursors (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  cursor_message_id BIGINT,
  inflight_prev_cursor BIGINT,
  inflight_message_id BIGINT,
  inflight_started_at TIMESTAMPTZ,
  failed_message_id BIGINT,
  failed_at TIMESTAMPTZ,
  failed_error TEXT,
  queued_followups JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- ── token usage (billing + KV-cache metrics) ────────────────────────

CREATE TABLE IF NOT EXISTS token_usage (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES messages(id),
  model TEXT,
  provider TEXT,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cache_read_tokens INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS token_usage_session_idx ON token_usage (session_id, created_at DESC);

-- ── scheduled tasks (scheduler worker, Phase 1 stub) ──────────────────

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  next_run TIMESTAMPTZ,
  last_run TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_tasks_next_run_idx ON scheduled_tasks (next_run)
  WHERE status = 'active' AND next_run IS NOT NULL;

-- ── RLS (enabled; policies tightened in Phase 2) ────────────────────

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;

-- Phase 1: permissive policy for local dev (replace in Phase 2)
DO $$ BEGIN
  CREATE POLICY sessions_dev_all ON sessions FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY messages_dev_all ON messages FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY session_cursors_dev_all ON session_cursors FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY token_usage_dev_all ON token_usage FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY scheduled_tasks_dev_all ON scheduled_tasks FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
