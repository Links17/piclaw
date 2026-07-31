-- Session recording traces (cloud feature parity).

CREATE TABLE IF NOT EXISTS session_recordings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default-user',
  chat_jid TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'redacted' CHECK (mode IN ('metadata', 'redacted', 'full')),
  status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'stopped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  event_count INT NOT NULL DEFAULT 0,
  redaction JSONB
);

CREATE INDEX IF NOT EXISTS session_recordings_chat_idx ON session_recordings (chat_jid, started_at DESC);
CREATE INDEX IF NOT EXISTS session_recordings_status_idx ON session_recordings (status) WHERE status = 'recording';

CREATE TABLE IF NOT EXISTS session_recording_events (
  recording_id TEXT NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  t_ms INT NOT NULL,
  data JSONB,
  redactions JSONB,
  PRIMARY KEY (recording_id, seq)
);

CREATE INDEX IF NOT EXISTS session_recording_events_recording_idx
  ON session_recording_events (recording_id, seq);

ALTER TABLE session_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_recording_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY session_recordings_dev_all ON session_recordings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY session_recording_events_dev_all ON session_recording_events FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
