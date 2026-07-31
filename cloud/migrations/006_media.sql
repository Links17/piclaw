-- Media blobs for chat attachments (cloud feature parity).

CREATE TABLE IF NOT EXISTS media (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default-user',
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  thumbnail BYTEA,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_user_created_idx ON media (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_media (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id BIGINT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, media_id)
);

CREATE INDEX IF NOT EXISTS message_media_message_id_idx ON message_media (message_id);

ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_media ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY media_dev_all ON media FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY message_media_dev_all ON message_media FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
