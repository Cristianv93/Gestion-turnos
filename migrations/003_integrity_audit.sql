BEGIN;

CREATE INDEX IF NOT EXISTS sessions_active_expiry_idx
ON sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS planning_assignments_week_date_idx
ON planning_assignments (planning_week_id, assignment_date);
CREATE INDEX IF NOT EXISTS requests_status_created_idx
ON requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS planning_exceptions_request_idx
ON planning_exceptions (source_request_id) WHERE source_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_assignment_compatibility()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  employee_sector TEXT;
  employee_shift TEXT;
  position_sector TEXT;
  position_shift TEXT;
BEGIN
  SELECT sector_id, shift_id INTO employee_sector, employee_shift FROM employees WHERE id = NEW.employee_id AND status = 'active' AND participates_in_operation = TRUE;
  SELECT sector_id, shift_id INTO position_sector, position_shift FROM planning_positions WHERE id = NEW.position_id;
  IF employee_sector IS NULL OR position_sector IS NULL THEN RAISE EXCEPTION 'Empleado o puesto operativo inválido'; END IF;
  IF employee_sector <> position_sector THEN RAISE EXCEPTION 'El empleado no pertenece al sector del puesto'; END IF;
  IF employee_shift IS NOT NULL AND position_shift IS NOT NULL AND employee_shift <> position_shift THEN RAISE EXCEPTION 'El empleado no pertenece al turno del puesto'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_updated_at ON employees;
CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS planning_weeks_updated_at ON planning_weeks;
CREATE TRIGGER planning_weeks_updated_at BEFORE UPDATE ON planning_weeks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS planning_assignments_updated_at ON planning_assignments;
CREATE TRIGGER planning_assignments_updated_at BEFORE UPDATE ON planning_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS planning_exceptions_updated_at ON planning_exceptions;
CREATE TRIGGER planning_exceptions_updated_at BEFORE UPDATE ON planning_exceptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS requests_updated_at ON requests;
CREATE TRIGGER requests_updated_at BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS assignment_compatibility ON planning_assignments;
CREATE TRIGGER assignment_compatibility BEFORE INSERT OR UPDATE OF employee_id, position_id ON planning_assignments FOR EACH ROW EXECUTE FUNCTION ensure_assignment_compatibility();

COMMIT;
