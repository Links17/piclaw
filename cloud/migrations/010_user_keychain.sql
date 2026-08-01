-- Per-user keychain secrets (cloud feature parity).

CREATE TABLE IF NOT EXISTS user_keychain (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'secret' CHECK (type IN ('token', 'password', 'basic', 'secret')),
  secret_encrypted TEXT NOT NULL,
  username TEXT,
  user_note TEXT,
  agent_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

CREATE INDEX IF NOT EXISTS user_keychain_user_idx ON user_keychain (user_id, name);

ALTER TABLE user_keychain ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY user_keychain_dev_all ON user_keychain FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY user_keychain_user_scope ON user_keychain FOR ALL
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
