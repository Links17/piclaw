-- Persistent Cloud autoresearch runs, scoped through their owning session.

CREATE TABLE IF NOT EXISTS autoresearch_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  execution_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  stop_requested_at TIMESTAMPTZ,
  summary TEXT,
  error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS autoresearch_runs_live_session_idx
  ON autoresearch_runs (session_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS autoresearch_runs_session_idx
  ON autoresearch_runs (session_id, started_at DESC);

ALTER TABLE autoresearch_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autoresearch_runs_user_scope ON autoresearch_runs;
CREATE POLICY autoresearch_runs_user_scope ON autoresearch_runs FOR ALL
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));
