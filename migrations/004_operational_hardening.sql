BEGIN;

CREATE INDEX IF NOT EXISTS users_active_username_idx
ON users (lower(username)) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS employees_active_operation_idx
ON employees (sector_id, shift_id) WHERE status = 'active' AND participates_in_operation = TRUE;
CREATE INDEX IF NOT EXISTS planning_weeks_active_idx
ON planning_weeks (start_date DESC) WHERE status IN ('draft', 'published', 'paused');

COMMIT;
