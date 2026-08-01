-- Replace Phase 1 development policies with explicit per-user scope.
DROP POLICY IF EXISTS sessions_dev_all ON sessions;
DROP POLICY IF EXISTS messages_dev_all ON messages;
DROP POLICY IF EXISTS session_cursors_dev_all ON session_cursors;
DROP POLICY IF EXISTS token_usage_dev_all ON token_usage;
DROP POLICY IF EXISTS scheduled_tasks_dev_all ON scheduled_tasks;
DROP POLICY IF EXISTS subagent_runs_dev_all ON subagent_runs;
DROP POLICY IF EXISTS api_keys_dev_all ON api_keys;
DROP POLICY IF EXISTS user_daily_usage_dev_all ON user_daily_usage;

DROP POLICY IF EXISTS sessions_user_scope ON sessions;
CREATE POLICY sessions_user_scope ON sessions FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS messages_user_scope ON messages;
CREATE POLICY messages_user_scope ON messages FOR ALL
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

DROP POLICY IF EXISTS session_cursors_user_scope ON session_cursors;
CREATE POLICY session_cursors_user_scope ON session_cursors FOR ALL
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

DROP POLICY IF EXISTS token_usage_user_scope ON token_usage;
CREATE POLICY token_usage_user_scope ON token_usage FOR ALL
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

DROP POLICY IF EXISTS scheduled_tasks_user_scope ON scheduled_tasks;
CREATE POLICY scheduled_tasks_user_scope ON scheduled_tasks FOR ALL
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

DROP POLICY IF EXISTS subagent_runs_user_scope ON subagent_runs;
CREATE POLICY subagent_runs_user_scope ON subagent_runs FOR ALL
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

DROP POLICY IF EXISTS api_keys_user_scope ON api_keys;
CREATE POLICY api_keys_user_scope ON api_keys FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_daily_usage_user_scope ON user_daily_usage;
CREATE POLICY user_daily_usage_user_scope ON user_daily_usage FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
