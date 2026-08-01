-- Lifecycle storage metadata. `014_volume_only_storage.sql` removes development
-- BYTEA columns and the temporary session_artifacts table.
ALTER TABLE media ADD COLUMN IF NOT EXISTS object_key TEXT NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN IF NOT EXISTS thumbnail_object_key TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS object_size BIGINT;

CREATE INDEX IF NOT EXISTS media_object_key_idx ON media (object_key)
  WHERE object_key <> '';

CREATE TABLE IF NOT EXISTS session_artifacts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/gzip',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

