-- Cloud storage boundary:
-- - media bytes never live in PostgreSQL;
-- - sandbox workspaces are persisted only by CubeSandbox volumes.

CREATE TABLE IF NOT EXISTS cloud_migration_markers (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This repository is still in development, so legacy in-DB media is discarded
-- instead of being exported. New uploads are written to external local storage.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM cloud_migration_markers WHERE name = '014_volume_only_storage_data_cleanup') THEN
    DELETE FROM message_media;
    DELETE FROM media;
    INSERT INTO cloud_migration_markers (name) VALUES ('014_volume_only_storage_data_cleanup');
  END IF;
END $$;

ALTER TABLE media DROP COLUMN IF EXISTS data;
ALTER TABLE media DROP COLUMN IF EXISTS thumbnail;
ALTER TABLE media ALTER COLUMN object_key DROP DEFAULT;
ALTER TABLE media ALTER COLUMN object_key SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE media ADD CONSTRAINT media_object_key_nonempty CHECK (object_key <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE media ADD CONSTRAINT media_object_size_nonnegative CHECK (object_size IS NULL OR object_size >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP TABLE IF EXISTS session_artifacts;

DROP INDEX IF EXISTS sessions_user_active_idx;
ALTER TABLE sessions DROP COLUMN IF EXISTS archived_at;
