-- Persist the session message created for a scheduled task outcome.
-- This is the delivery idempotency key while the task claim remains fenced.

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS delivery_message_id BIGINT
    REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scheduled_tasks_delivery_message_idx
  ON scheduled_tasks (delivery_message_id)
  WHERE delivery_message_id IS NOT NULL;
