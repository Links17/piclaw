-- Tighten token usage ownership and make RLS mandatory for application roles.

DROP POLICY IF EXISTS token_usage_user_scope ON token_usage;
CREATE POLICY token_usage_user_scope ON token_usage FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE session_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE token_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE subagent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE user_daily_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE session_compactions FORCE ROW LEVEL SECURITY;
ALTER TABLE session_compaction_backoffs FORCE ROW LEVEL SECURITY;
