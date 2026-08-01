-- Recoverable, operation-scoped LLM usage ledger.

ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS operation_id TEXT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS attempt INT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success';
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS subagent_run_id TEXT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS stage TEXT;

CREATE INDEX IF NOT EXISTS token_usage_operation_idx
  ON token_usage (session_id, operation_id, attempt);
CREATE INDEX IF NOT EXISTS token_usage_subagent_run_idx
  ON token_usage (subagent_run_id, attempt);

CREATE TABLE IF NOT EXISTS side_prompt_operations (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, operation_id)
);

CREATE INDEX IF NOT EXISTS side_prompt_operations_updated_idx
  ON side_prompt_operations (updated_at DESC);

ALTER TABLE side_prompt_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS side_prompt_operations_user_scope ON side_prompt_operations;
CREATE POLICY side_prompt_operations_user_scope ON side_prompt_operations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = side_prompt_operations.session_id
        AND s.user_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = side_prompt_operations.session_id
        AND s.user_id = current_setting('app.user_id', true)
    )
  );
