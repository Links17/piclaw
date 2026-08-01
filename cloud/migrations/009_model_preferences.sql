-- Per-session model state and per-user general preferences (cloud feature parity).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_label TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thinking_level TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
