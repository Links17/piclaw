-- Unified LLM usage accounting and persistent session compaction.

ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS usage_key TEXT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS usage_source TEXT NOT NULL DEFAULT 'assistant';
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS reasoning_tokens INT NOT NULL DEFAULT 0;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS total_tokens INT NOT NULL DEFAULT 0;

UPDATE token_usage tu
SET user_id = s.user_id
FROM sessions s
WHERE tu.session_id = s.id AND tu.user_id IS NULL;

UPDATE token_usage
SET total_tokens = input_tokens + output_tokens + reasoning_tokens
WHERE total_tokens = 0;

DO $$ BEGIN
  ALTER TABLE token_usage ADD CONSTRAINT token_usage_source_check
    CHECK (usage_source IN ('assistant', 'side_prompt', 'subagent', 'compaction'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS token_usage_key_unique_idx
  ON token_usage (usage_key) WHERE usage_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS token_usage_session_source_idx
  ON token_usage (session_id, usage_source, created_at DESC);
CREATE INDEX IF NOT EXISTS token_usage_user_date_idx
  ON token_usage (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_compactions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  compacted_through_message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  tokens_before INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, compacted_through_message_id)
);

CREATE INDEX IF NOT EXISTS session_compactions_latest_idx
  ON session_compactions (session_id, compacted_through_message_id DESC);

CREATE TABLE IF NOT EXISTS session_compaction_backoffs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  failure_count INT NOT NULL DEFAULT 0,
  retry_after TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE session_compactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_compaction_backoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_compactions_user_scope ON session_compactions;
CREATE POLICY session_compactions_user_scope ON session_compactions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_compactions.session_id
        AND s.user_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_compactions.session_id
        AND s.user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS session_compaction_backoffs_user_scope ON session_compaction_backoffs;
CREATE POLICY session_compaction_backoffs_user_scope ON session_compaction_backoffs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_compaction_backoffs.session_id
        AND s.user_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_compaction_backoffs.session_id
        AND s.user_id = current_setting('app.user_id', true)
    )
  );
