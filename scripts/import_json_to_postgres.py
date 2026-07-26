"""Importa data/uzumaki-db.json en PostgreSQL.

Uso:
  DATABASE_URL='[URL_DE_POSTGRES]' python scripts/import_json_to_postgres.py

Ejecutar antes:
  psql "$DATABASE_URL" -f migrations/001_initial_schema.sql

La operación es transaccional y usa ON CONFLICT para poder repetirla.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb


ROOT = Path(__file__).resolve().parents[1]
JSON_PATH = ROOT / "data" / "uzumaki-db.json"


def load_env():
    """Permite ejecutar la importación local sin exportar secretos al shell."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def now():
    return datetime.now(timezone.utc)


def iso_or_now(value):
    if not value or value == "Ahora":
        return now()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return now()


def jsonb(value):
    return Jsonb(value if value is not None else {})


def main():
    load_env()
    database_url = os.environ.get("DATABASE_URL") or os.environ.get("DATABASE_PUBLIC_URL")
    if not database_url:
        raise SystemExit("Falta DATABASE_URL")
    payload = json.loads(JSON_PATH.read_text(encoding="utf-8"))

    catalogs = payload.get("catalogs", {})
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            # Catálogos del JSON.
            for item in catalogs.get("sectores", {}).values():
                cur.execute("""
                    INSERT INTO sectors (id, name, metadata) VALUES (%s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata
                """, (item["id"], item["nombre"], jsonb(item)))
            for item in catalogs.get("turnos", {}).values():
                cur.execute("""
                    INSERT INTO shifts (id, name, start_time, end_time, metadata)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
                      start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
                      metadata = EXCLUDED.metadata
                """, (item["id"], item["nombre"], item.get("horaInicio"), item.get("horaFin"), jsonb(item)))
            for item in catalogs.get("pisos", {}).values():
                cur.execute("""
                    INSERT INTO floors (id, number, metadata) VALUES (%s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, metadata = EXCLUDED.metadata
                """, (item["id"], item["numero"], jsonb(item)))
            for item in catalogs.get("rolesSistema", {}).values():
                cur.execute("""
                    INSERT INTO system_roles (id, name, metadata) VALUES (%s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata
                """, (item["id"], item["nombre"], jsonb(item)))
            for item in catalogs.get("rolesOperativos", {}).values():
                sector_id = item.get("sectorId")
                if not sector_id and item.get("sector"):
                    sector_id = {"Cocina": "sec-cocina", "Pisos": "sec-pisos"}.get(item["sector"])
                allowed_sectors = item.get("sectores", [])
                if not allowed_sectors and item.get("sector"):
                    allowed_sectors = [item["sector"]]
                cur.execute("""
                    INSERT INTO company_roles (id, name, sector_id, allowed_sectors, metadata)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
                      sector_id = EXCLUDED.sector_id, allowed_sectors = EXCLUDED.allowed_sectors,
                      metadata = EXCLUDED.metadata
                """, (item["id"], item["nombre"], sector_id, jsonb(allowed_sectors), jsonb(item)))

            # Los puestos operativos hoy están definidos en planningWeeks.js.
            templates = [
                ("kitchen-cook-morning-1", "sec-cocina", "turno-manana", "Cocina Mañana · Puesto 1", 1, None, True),
                ("kitchen-cook-morning-2", "sec-cocina", "turno-manana", "Cocina Mañana · Puesto 2", 2, None, True),
                ("kitchen-assistant-morning", "sec-cocina", "turno-manana", "Cocina Mañana · Puesto 3", 3, None, True),
                ("kitchen-extra-morning", "sec-cocina", "turno-manana", "Cocina Mañana · Apoyo", 4, None, True),
                ("kitchen-cook-afternoon", "sec-cocina", "turno-tarde", "Cocina Tarde · Puesto 1", 1, None, True),
                ("kitchen-assistant-afternoon", "sec-cocina", "turno-tarde", "Cocina Tarde · Puesto 2", 2, None, True),
                ("kitchen-extra-afternoon", "sec-cocina", "turno-tarde", "Cocina Tarde · Puesto 3", 3, None, True),
                ("floor-1-morning", "sec-pisos", "turno-manana", "Piso 1 Mañana", None, "piso-1", False),
                ("floor-2-morning", "sec-pisos", "turno-manana", "Piso 2 Mañana", None, "piso-2", False),
                ("floor-3-morning", "sec-pisos", "turno-manana", "Piso 3 Mañana", None, "piso-3", False),
                ("floor-1-afternoon", "sec-pisos", "turno-tarde", "Piso 1 Tarde", None, "piso-1", False),
                ("floor-2-afternoon", "sec-pisos", "turno-tarde", "Piso 2 Tarde", None, "piso-2", False),
                ("floor-3-afternoon", "sec-pisos", "turno-tarde", "Piso 3 Tarde", None, "piso-3", False),
            ]
            for row in templates:
                cur.execute("""
                    INSERT INTO position_templates
                      (id, sector_id, shift_id, label, slot, floor_id, optional)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label,
                      sector_id = EXCLUDED.sector_id, shift_id = EXCLUDED.shift_id,
                      slot = EXCLUDED.slot, floor_id = EXCLUDED.floor_id,
                      optional = EXCLUDED.optional
                """, row)

            # Empleados y ciclos F1/F2.
            for employee in payload.get("employees", []):
                legacy = dict(employee)
                cycle = legacy.pop("francoCycle", None)
                legacy.pop("francos", None)
                cur.execute("""
                    INSERT INTO employees
                      (id, name, initials, company_role_id, sector_id, shift_id, floor_id,
                       phone, status, participates_in_operation, habitual_position_template_id, legacy_data)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, initials = EXCLUDED.initials,
                      company_role_id = EXCLUDED.company_role_id, sector_id = EXCLUDED.sector_id,
                      shift_id = EXCLUDED.shift_id, floor_id = EXCLUDED.floor_id, phone = EXCLUDED.phone,
                      status = EXCLUDED.status, participates_in_operation = EXCLUDED.participates_in_operation,
                      habitual_position_template_id = EXCLUDED.habitual_position_template_id,
                      legacy_data = EXCLUDED.legacy_data, updated_at = now()
                """, (employee["id"], employee["name"], employee.get("initials"), employee.get("roleId"),
                      employee.get("sectorId"), employee.get("turnoId"),
                      f"piso-{employee['piso']}" if employee.get("piso") else None,
                      employee.get("phone", ""), employee.get("status", "active"),
                      employee.get("participaEnOperacion", True), employee.get("habitualPositionTemplateId"), jsonb(legacy)))
                if cycle:
                    cur.execute("""
                        INSERT INTO employee_franco_cycles
                          (employee_id, anchor_date, anchor_type, cycle_length_days)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (employee_id) DO UPDATE SET anchor_date = EXCLUDED.anchor_date,
                          anchor_type = EXCLUDED.anchor_type, cycle_length_days = EXCLUDED.cycle_length_days,
                          updated_at = now()
                    """, (employee["id"], cycle["anchorDate"], cycle["anchorType"], cycle.get("cycleLengthDays", 15)))

            # Usuarios. Los hashes PBKDF2 existentes son compatibles con el backend actual.
            role_ids = {"admin": "sys-admin", "manager": "sys-encargada", "supervisor": "sys-supervisora", "staff": "sys-personal"}
            for user in payload.get("users", []):
                cur.execute("""
                    INSERT INTO users (id, username, name, system_role, employee_id, password_hash)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, name = EXCLUDED.name,
                      system_role = EXCLUDED.system_role, employee_id = EXCLUDED.employee_id,
                      password_hash = EXCLUDED.password_hash, updated_at = now()
                """, (user["id"], user["username"].lower(), user["name"], role_ids.get(user.get("role"), "sys-personal"),
                      user.get("employeeId"), user.get("passwordHash", "")))

            # Se elige weeklySchedules como histórico; planningWeek es la copia activa del mismo documento.
            weeks = {week["id"]: week for week in payload.get("weeklySchedules", [])}
            active_week = payload.get("planningWeek")
            if active_week:
                weeks[active_week["id"]] = {**weeks.get(active_week["id"], {}), **active_week}
            for week in weeks.values():
                published_by = (week.get("publishedBy") or {}).get("id")
                paused_by = (week.get("pausedBy") or {}).get("id")
                cur.execute("""
                    INSERT INTO planning_weeks
                      (id, name, start_date, end_date, status, version, published_by, published_at,
                       paused_by, paused_at, last_proposal_at, last_proposal_mode, last_coverage_gaps, legacy_data)
                    VALUES (%s, %s, %s, %s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, start_date = EXCLUDED.start_date,
                      end_date = EXCLUDED.end_date, status = EXCLUDED.status, published_by = EXCLUDED.published_by,
                      published_at = EXCLUDED.published_at, paused_by = EXCLUDED.paused_by,
                      paused_at = EXCLUDED.paused_at, last_proposal_at = EXCLUDED.last_proposal_at,
                      last_proposal_mode = EXCLUDED.last_proposal_mode, last_coverage_gaps = EXCLUDED.last_coverage_gaps,
                      legacy_data = EXCLUDED.legacy_data, updated_at = now()
                """, (week["id"], week["name"], week["startDate"], week["endDate"], week.get("status", "draft"),
                      published_by, iso_or_now(week.get("publishedAt")) if week.get("publishedAt") else None,
                      paused_by, iso_or_now(week.get("pausedAt")) if week.get("pausedAt") else None,
                      iso_or_now(week.get("lastProposalAt")) if week.get("lastProposalAt") else None,
                      week.get("lastProposalMode"), jsonb(week.get("lastCoverageGaps", [])), jsonb(week)))
                for position in week.get("operationalPositions", []):
                    cur.execute("""
                        INSERT INTO planning_positions
                          (id, planning_week_id, template_id, date, day_index, sector_id, shift_id,
                           floor_id, slot, label, optional, metadata)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, optional = EXCLUDED.optional,
                          metadata = EXCLUDED.metadata
                    """, (position["id"], week["id"], position["templateId"], position["date"], position["dayIndex"],
                          "sec-cocina" if position.get("sector") == "Cocina" else "sec-pisos" if position.get("sector") == "Pisos" else None,
                          "turno-manana" if position.get("shift") == "Mañana" else "turno-tarde" if position.get("shift") == "Tarde" else None,
                          f"piso-{position['floor']}" if position.get("floor") else None, position.get("slot"),
                          position.get("label", ""), position.get("optional", False), jsonb(position)))
                for assignment in week.get("assignments", []):
                    position = next((p for p in week.get("operationalPositions", []) if p["id"] == assignment.get("positionId")), {})
                    metadata = {**assignment, "assignment_date": position.get("date")}
                    cur.execute("""
                    INSERT INTO planning_assignments
                          (id, planning_week_id, position_id, employee_id, assignment_date, assignment_type, generated,
                           generation_reason, covered_employee_id, metadata)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET position_id = EXCLUDED.position_id,
                          employee_id = EXCLUDED.employee_id, assignment_date = EXCLUDED.assignment_date,
                          assignment_type = EXCLUDED.assignment_type,
                          generated = EXCLUDED.generated, generation_reason = EXCLUDED.generation_reason,
                          covered_employee_id = EXCLUDED.covered_employee_id, metadata = EXCLUDED.metadata,
                          updated_at = now()
                    """, (assignment["id"], week["id"], assignment["positionId"], assignment["employeeId"], position.get("date"),
                          assignment.get("assignmentType", "regular"), assignment.get("generated", False),
                          assignment.get("generationReason"), assignment.get("coveredEmployeeId"), jsonb(metadata)))
                for day_off in week.get("daysOff", []):
                    cur.execute("""
                        INSERT INTO planning_days_off (id, planning_week_id, employee_id, date, sector_id, type)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, type = EXCLUDED.type,
                          sector_id = EXCLUDED.sector_id
                    """, (day_off["id"], week["id"], day_off["employeeId"], day_off["date"],
                          "sec-cocina" if day_off.get("sector") == "Cocina" else "sec-pisos" if day_off.get("sector") == "Pisos" else None,
                          day_off.get("tipo", "F1")))
                for exception in week.get("exceptions", []):
                    cur.execute("""
                        INSERT INTO planning_exceptions
                          (id, planning_week_id, position_id, date, shift_id, sector_id,
                           affected_employee_id, cover_employee_id, type, status, note, metadata)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
                          affected_employee_id = EXCLUDED.affected_employee_id,
                          cover_employee_id = EXCLUDED.cover_employee_id, metadata = EXCLUDED.metadata,
                          updated_at = now()
                    """, (exception["id"], week["id"], exception.get("positionId"), exception["date"],
                          "turno-manana" if exception.get("shift") == "Mañana" else "turno-tarde" if exception.get("shift") == "Tarde" else None,
                          "sec-cocina" if exception.get("sector") == "Cocina" else "sec-pisos" if exception.get("sector") == "Pisos" else None,
                          exception.get("affectedEmployeeId") or None, exception.get("coverEmployeeId") or None,
                          exception.get("type", "exception"), exception.get("status", "active"), exception.get("note", ""), jsonb(exception)))

            # Solicitudes y trazabilidad. Se preserva scheduleImpact para que el
            # backend pueda aplicar reglas sin depender de campos de UI.
            for request in payload.get("requests", []):
                impact = request.get("scheduleImpact") or {}
                target = impact.get("target") or {}
                cur.execute("""
                    INSERT INTO requests (id, employee_id, type, status, partner_employee_id, partner_status,
                      note, target_date, start_date, end_date, schedule_impact, planning_application,
                      revoked_at, revocation_reason, created_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, partner_status=EXCLUDED.partner_status,
                      note=EXCLUDED.note, schedule_impact=EXCLUDED.schedule_impact,
                      planning_application=EXCLUDED.planning_application, updated_at=now()
                """, (request["id"], request["employeeId"], request.get("type", "absence"), request.get("status", "pendingManager"),
                      request.get("partnerEmployeeId") or None, request.get("partnerStatus") or None, request.get("note", ""),
                      request.get("targetDate") or target.get("date"), request.get("startDate") or target.get("startDate"),
                      request.get("endDate") or target.get("endDate"), jsonb(impact), jsonb(request.get("planningApplication")) if request.get("planningApplication") else None,
                      iso_or_now(request.get("revokedAt")) if request.get("revokedAt") else None, request.get("revocationReason"), iso_or_now(request.get("createdAt") or request.get("date"))))

            for notification in payload.get("notifications", []):
                cur.execute("""
                    INSERT INTO notifications (id, title, text, type, read_at, created_at, metadata)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, text=EXCLUDED.text,
                      type=EXCLUDED.type, read_at=EXCLUDED.read_at, metadata=EXCLUDED.metadata
                """, (notification["id"], notification.get("title", "Notificación"), notification.get("text", ""), notification.get("type", "general"),
                      now() if notification.get("read") else None, iso_or_now(notification.get("createdAt") or notification.get("time")), jsonb(notification)))

            for audit in payload.get("auditLogs", []):
                cur.execute("""
                    INSERT INTO audit_logs (id, action, entity_id, result, metadata, created_at)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET result=EXCLUDED.result, metadata=EXCLUDED.metadata
                """, (audit["id"], audit.get("action", "legacy_action"), audit.get("entity"), audit.get("result"), jsonb(audit), iso_or_now(audit.get("createdAt") or audit.get("time"))))

            # Datos de referencia/legado que no participan de la operación normal.
            if payload.get("referenceSchedule"):
                cur.execute("""
                    INSERT INTO app_snapshots (key, payload) VALUES ('reference_schedule', %s)
                    ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
                """, (jsonb(payload["referenceSchedule"]),))
            cur.execute("""
                INSERT INTO app_snapshots (key, payload) VALUES ('migration_metadata', %s)
                ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
            """, (jsonb({"source": "uzumaki-db.json", "stateRevision": payload.get("stateRevision"), "importedAt": now().isoformat()}),))
        conn.commit()
    print("Importación completada")


if __name__ == "__main__":
    main()
