BEGIN;

-- Lecturas de inicio y filtros operativos: evitan exploraciones completas al
-- cargar el panel, las solicitudes y la semana publicada.
CREATE INDEX IF NOT EXISTS planning_weeks_status_start_idx
ON planning_weeks (status, start_date DESC);
CREATE INDEX IF NOT EXISTS planning_days_off_week_date_idx
ON planning_days_off (planning_week_id, date);
CREATE INDEX IF NOT EXISTS planning_days_off_employee_date_idx
ON planning_days_off (employee_id, date);
CREATE INDEX IF NOT EXISTS planning_assignments_week_employee_date_idx
ON planning_assignments (planning_week_id, employee_id, assignment_date);
CREATE INDEX IF NOT EXISTS requests_partner_status_idx
ON requests (partner_employee_id, status, created_at DESC) WHERE partner_employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_visible_idx
ON notifications (recipient_user_id, created_at DESC);

-- La fecha de cada registro operativo debe pertenecer a su semana. Las
-- validaciones viven también en Python para entregar mensajes claros; estos
-- triggers protegen los datos ante scripts o futuras integraciones.
CREATE OR REPLACE FUNCTION ensure_planning_day_off_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  week_start DATE;
  week_end DATE;
BEGIN
  SELECT start_date, end_date INTO week_start, week_end
  FROM planning_weeks WHERE id = NEW.planning_week_id;
  IF week_start IS NULL OR NEW.date < week_start OR NEW.date > week_end THEN
    RAISE EXCEPTION 'El franco debe pertenecer a la semana de planificación';
  END IF;
  IF EXISTS (
    SELECT 1 FROM planning_assignments
    WHERE planning_week_id = NEW.planning_week_id
      AND employee_id = NEW.employee_id
      AND assignment_date = NEW.date
  ) THEN
    RAISE EXCEPTION 'No se puede cargar un franco sobre una asignación existente';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_planning_exception_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  position_week TEXT;
  position_date DATE;
BEGIN
  IF NEW.position_id IS NOT NULL THEN
    SELECT planning_week_id, date INTO position_week, position_date
    FROM planning_positions WHERE id = NEW.position_id;
    IF position_week IS NULL OR position_week <> NEW.planning_week_id OR position_date <> NEW.date THEN
      RAISE EXCEPTION 'La excepción debe corresponder a un puesto y fecha de su semana';
    END IF;
  END IF;
  IF NEW.affected_employee_id IS NOT NULL AND NEW.affected_employee_id = NEW.cover_employee_id THEN
    RAISE EXCEPTION 'La persona afectada y la cobertura deben ser distintas';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS planning_days_off_integrity ON planning_days_off;
CREATE TRIGGER planning_days_off_integrity
BEFORE INSERT OR UPDATE OF planning_week_id, employee_id, date ON planning_days_off
FOR EACH ROW EXECUTE FUNCTION ensure_planning_day_off_integrity();

DROP TRIGGER IF EXISTS planning_exceptions_integrity ON planning_exceptions;
CREATE TRIGGER planning_exceptions_integrity
BEFORE INSERT OR UPDATE OF planning_week_id, position_id, date, affected_employee_id, cover_employee_id ON planning_exceptions
FOR EACH ROW EXECUTE FUNCTION ensure_planning_exception_integrity();

COMMIT;
