-- Normalize schedule values produced before structured Agent scheduling.

UPDATE scheduled_tasks
SET timezone = 'UTC'
WHERE schedule_type = 'cron'
  AND (timezone IS NULL OR timezone ~* '^GMT[+-][0-9]{2}:?[0-9]{2}$');

UPDATE scheduled_tasks
SET invocation = invocation || jsonb_build_object('model', model)
WHERE task_kind = 'agent'
  AND invocation IS NOT NULL
  AND model IS NOT NULL
  AND NOT (invocation ? 'model');

UPDATE scheduled_tasks
SET schedule_value = regexp_replace(schedule_value, '^cron\s+', '', 'i')
WHERE schedule_type = 'cron' AND schedule_value ~* '^cron\s+';

UPDATE scheduled_tasks
SET schedule_value = (
  (regexp_match(schedule_value, '^every\s+([0-9]+)\s*([smhd])$', 'i'))[1]::bigint
  * CASE lower((regexp_match(schedule_value, '^every\s+([0-9]+)\s*([smhd])$', 'i'))[2])
      WHEN 's' THEN 1000
      WHEN 'm' THEN 60000
      WHEN 'h' THEN 3600000
      WHEN 'd' THEN 86400000
    END
)::text
WHERE schedule_type = 'interval'
  AND schedule_value ~* '^every\s+[0-9]+\s*[smhd]$';

UPDATE scheduled_tasks
SET status = 'paused',
    last_error = COALESCE(last_error, 'legacy schedule requires manual normalization')
WHERE status = 'active'
  AND (
    (schedule_type = 'interval' AND schedule_value !~ '^[0-9]+$')
    OR (schedule_type = 'cron' AND schedule_value ~* '^cron\s+')
  );
