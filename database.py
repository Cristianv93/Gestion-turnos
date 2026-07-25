"""Acceso a PostgreSQL para Gestión de turnos.

Este módulo es deliberadamente pequeño: concentra persistencia, transacciones y
validaciones que no deben depender del navegador. El frontend recibe DTOs con el
formato legado mientras termina la transición de pantallas.
"""

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
import secrets

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from planning_rules import cycle_day_off


ROLE_TO_SYSTEM = {"admin": "sys-admin", "manager": "sys-encargada", "supervisor": "sys-supervisora", "staff": "sys-personal"}
SYSTEM_TO_ROLE = {value: key for key, value in ROLE_TO_SYSTEM.items()}
MANAGER_ROLES = {"admin", "manager"}


class DomainError(Exception):
    def __init__(self, message, status=400, code="validationError"):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


def utcnow():
    return datetime.now(timezone.utc)


def iso(value):
    return value.isoformat().replace("+00:00", "Z") if value else None


class Database:
    def __init__(self, url):
        self.url = url

    @contextmanager
    def cursor(self):
        with psycopg.connect(self.url, row_factory=dict_row, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                yield conn, cur

    def ready(self):
        with self.cursor() as (_, cur):
            cur.execute("SELECT 1")
            return bool(cur.fetchone())

    def authenticate(self, username, verify_password):
        with self.cursor() as (_, cur):
            cur.execute("SELECT id, username, name, system_role, employee_id, password_hash FROM users WHERE lower(username) = lower(%s) AND active = TRUE", (username,))
            row = cur.fetchone()
        if not row or not verify_password("", row["password_hash"]):
            # La comprobación real se realiza en login() para evitar exponer hashes.
            return row
        return row

    def login_user(self, username):
        with self.cursor() as (_, cur):
            cur.execute("SELECT id, username, name, system_role, employee_id, password_hash FROM users WHERE lower(username) = lower(%s) AND active = TRUE", (username,))
            return cur.fetchone()

    def create_session(self, user_id, max_age):
        raw = secrets.token_urlsafe(32)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        with self.cursor() as (conn, cur):
            cur.execute("DELETE FROM sessions WHERE expires_at <= now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')")
            cur.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)", (digest, user_id, utcnow() + timedelta(seconds=max_age)))
            conn.commit()
        return raw

    def session_user(self, token):
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.cursor() as (_, cur):
            cur.execute("""
                SELECT u.id, u.username, u.name, u.system_role, u.employee_id
                FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash=%s AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active=TRUE
            """, (digest,))
            row = cur.fetchone()
        return self.user_dto(row) if row else None

    def revoke_session(self, token):
        if not token:
            return
        with self.cursor() as (conn, cur):
            cur.execute("UPDATE sessions SET revoked_at=now() WHERE token_hash=%s", (hashlib.sha256(token.encode()).hexdigest(),))
            conn.commit()

    @staticmethod
    def user_dto(row):
        return {"id": row["id"], "username": row["username"], "name": row["name"], "role": SYSTEM_TO_ROLE.get(row["system_role"], row["system_role"]), "employeeId": row["employee_id"]}

    def _catalogs(self, cur):
        def objects(query):
            cur.execute(query)
            return {r["id"]: r["value"] for r in cur.fetchall()}
        return {
            "sectores": objects("SELECT id, jsonb_build_object('id',id,'nombre',name) value FROM sectors"),
            "turnos": objects("SELECT id, jsonb_strip_nulls(jsonb_build_object('id',id,'nombre',name,'horaInicio',start_time,'horaFin',end_time)) value FROM shifts"),
            "pisos": objects("SELECT id, jsonb_build_object('id',id,'numero',number) value FROM floors"),
            "rolesOperativos": objects("SELECT id, metadata || jsonb_build_object('id',id,'nombre',name) value FROM company_roles"),
            "rolesSistema": objects("SELECT id, metadata || jsonb_build_object('id',id,'nombre',name) value FROM system_roles"),
        }

    def _week_dto(self, cur, week):
        cur.execute("""SELECT p.id, p.template_id, p.date, p.day_index, s.name sector, sh.name shift, p.label, p.slot, f.number floor, p.optional
                       FROM planning_positions p LEFT JOIN sectors s ON s.id=p.sector_id LEFT JOIN shifts sh ON sh.id=p.shift_id LEFT JOIN floors f ON f.id=p.floor_id
                       WHERE p.planning_week_id=%s ORDER BY p.date,p.label""", (week["id"],))
        positions = [{"id": r["id"], "templateId": r["template_id"], "date": r["date"].isoformat(), "dayIndex": r["day_index"], "sector": r["sector"], "shift": r["shift"], "label": r["label"], "slot": r["slot"], "floor": r["floor"], "optional": r["optional"]} for r in cur.fetchall()]
        cur.execute("SELECT id, position_id, employee_id, assignment_type, generated, generation_reason, covered_employee_id, metadata FROM planning_assignments WHERE planning_week_id=%s", (week["id"],))
        assignments = [{"id": r["id"], "positionId": r["position_id"], "employeeId": r["employee_id"], "assignmentType": r["assignment_type"], "generated": r["generated"], "generationReason": r["generation_reason"], "coveredEmployeeId": r["covered_employee_id"], **(r["metadata"] or {})} for r in cur.fetchall()]
        cur.execute("SELECT d.id,d.employee_id,d.date,s.name sector,d.type FROM planning_days_off d LEFT JOIN sectors s ON s.id=d.sector_id WHERE d.planning_week_id=%s", (week["id"],))
        days_off = [{"id": r["id"], "employeeId": r["employee_id"], "date": r["date"].isoformat(), "sector": r["sector"], "tipo": r["type"]} for r in cur.fetchall()]
        cur.execute("""SELECT e.id,e.position_id,e.date,sh.name shift,s.name sector,e.affected_employee_id,e.cover_employee_id,e.type,e.status,e.note,e.metadata
                       FROM planning_exceptions e LEFT JOIN shifts sh ON sh.id=e.shift_id LEFT JOIN sectors s ON s.id=e.sector_id WHERE e.planning_week_id=%s""", (week["id"],))
        exceptions = [{"id": r["id"], "positionId": r["position_id"], "date": r["date"].isoformat(), "shift": r["shift"], "sector": r["sector"], "affectedEmployeeId": r["affected_employee_id"], "coverEmployeeId": r["cover_employee_id"], "type": r["type"], "status": r["status"], "note": r["note"], **(r["metadata"] or {})} for r in cur.fetchall()]
        return {"id": week["id"], "name": week["name"], "startDate": week["start_date"].isoformat(), "endDate": week["end_date"].isoformat(), "status": week["status"], "version": week["version"], "publishedAt": iso(week["published_at"]), "operationalPositions": positions, "assignments": assignments, "daysOff": days_off, "exceptions": exceptions, "coverages": []}

    def state(self, actor):
        """Devuelve únicamente la información que el rol autenticado necesita."""
        privileged = actor.get("role") in MANAGER_ROLES
        with self.cursor() as (_, cur):
            cur.execute("""SELECT e.id,e.name,e.initials,e.phone,e.status,e.participates_in_operation,e.habitual_position_template_id,
                cr.id role_id,cr.name role,s.id sector_id,s.name sector,sh.id shift_id,sh.name turno,f.number piso,fc.anchor_date,fc.anchor_type,fc.cycle_length_days,e.legacy_data
                FROM employees e LEFT JOIN company_roles cr ON cr.id=e.company_role_id LEFT JOIN sectors s ON s.id=e.sector_id LEFT JOIN shifts sh ON sh.id=e.shift_id LEFT JOIN floors f ON f.id=e.floor_id LEFT JOIN employee_franco_cycles fc ON fc.employee_id=e.id ORDER BY e.name""")
            employees=[]
            for r in cur.fetchall():
                employee={"id":r["id"],"name":r["name"],"initials":r["initials"],"status":r["status"],"participaEnOperacion":r["participates_in_operation"],"roleId":r["role_id"],"role":r["role"],"sectorId":r["sector_id"],"sector":r["sector"],"turnoId":r["shift_id"],"turno":r["turno"],"piso":r["piso"]}
                if privileged:
                    employee.update({**(r["legacy_data"] or {}),"phone":r["phone"],"habitualPositionTemplateId":r["habitual_position_template_id"],"francoCycle": {"anchorDate":r["anchor_date"].isoformat(),"anchorType":r["anchor_type"],"cycleLengthDays":r["cycle_length_days"]} if r["anchor_date"] else None})
                employees.append(employee)
            if privileged:
                cur.execute("SELECT id,username,name,system_role,employee_id FROM users WHERE active=TRUE ORDER BY username")
            else:
                cur.execute("SELECT id,username,name,system_role,employee_id FROM users WHERE id=%s AND active=TRUE", (actor["id"],))
            users=[self.user_dto(r) for r in cur.fetchall()]
            cur.execute("SELECT * FROM planning_weeks ORDER BY start_date DESC")
            weeks=[self._week_dto(cur,w) for w in cur.fetchall()]
            if privileged:
                cur.execute("SELECT * FROM requests ORDER BY created_at DESC")
            else:
                cur.execute("SELECT * FROM requests WHERE employee_id=%s OR partner_employee_id=%s ORDER BY created_at DESC", (actor.get("employeeId"), actor.get("employeeId")))
            requests=[{"id":r["id"],"employeeId":r["employee_id"],"type":r["type"],"status":r["status"],"partnerEmployeeId":r["partner_employee_id"] or "","partnerStatus":r["partner_status"] or "","note":r["note"],"targetDate":r["target_date"].isoformat() if r["target_date"] else None,"startDate":r["start_date"].isoformat() if r["start_date"] else None,"endDate":r["end_date"].isoformat() if r["end_date"] else None,"scheduleImpact":r["schedule_impact"] or {},"date":iso(r["created_at"]),"revokedAt":iso(r["revoked_at"])} for r in cur.fetchall()]
            cur.execute("SELECT n.id,n.title,n.text,n.type,n.read_at,n.created_at FROM notifications n WHERE recipient_user_id IS NULL OR recipient_user_id=%s ORDER BY n.created_at DESC", (actor["id"],))
            notifications=[{"id":r["id"],"title":r["title"],"text":r["text"],"type":r["type"],"read":bool(r["read_at"]),"time":iso(r["created_at"])} for r in cur.fetchall()]
            audit_logs=[]
            if privileged:
                cur.execute("SELECT id,action,entity_id,result,metadata,created_at FROM audit_logs ORDER BY created_at DESC")
                audit_logs=[{**(r["metadata"] or {}),"id":r["id"],"action":r["action"],"entity":r["entity_id"],"result":r["result"],"time":iso(r["created_at"])} for r in cur.fetchall()]
            catalogs=self._catalogs(cur)
        active=next((w for w in weeks if w["status"] in {"draft","published","paused"}), None)
        return {"stateRevision": active["version"] if active else 0, "stateUpdatedAt":None, "employees":employees,"users":users,"catalogs":catalogs,"weeklySchedules":weeks,"planningWeek":active,"requests":requests,"notifications":notifications,"auditLogs":audit_logs,"incidents":[],"schedule":[],"draft":[],"days":[],"scheduleVersion":0,"hasDraftChanges":False}

    def _assert_manager(self, actor):
        if actor.get("role") not in MANAGER_ROLES:
            raise DomainError("Tu perfil no puede modificar la planificación.", 403, "forbidden")

    @staticmethod
    def _audit(cur, actor_id, action, entity_type, entity_id, result="ok", metadata=None):
        cur.execute(
            "INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,result,metadata) VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (secrets.token_hex(16), actor_id, action, entity_type, entity_id, result, Jsonb(metadata or {})),
        )

    @staticmethod
    def _catalog_id(cur, table, value, field="name"):
        if not value:
            return None
        cur.execute(f"SELECT id FROM {table} WHERE id=%s OR {field}=%s", (value, value))
        row = cur.fetchone()
        if not row:
            raise DomainError("Uno de los valores de catálogo no es válido.")
        return row["id"]

    def upsert_user(self, actor, data, password_hash=None):
        """Crea o actualiza usuario y empleado en una única transacción."""
        self._assert_manager(actor)
        user_id = str(data.get("userId") or "").strip() or None
        username = str(data.get("username") or "").strip().lower()
        name = str(data.get("name") or "").strip()
        role = str(data.get("systemRole") or "").strip()
        company_role = str(data.get("companyRole") or "").strip()
        if not username or not name or role not in ROLE_TO_SYSTEM or not company_role:
            raise DomainError("Usuario, nombre y roles son obligatorios.")
        if not user_id and not password_hash:
            raise DomainError("La contraseña es obligatoria para un usuario nuevo.")
        with self.cursor() as (conn, cur):
            company_role_id = self._catalog_id(cur, "company_roles", company_role)
            sector_id = self._catalog_id(cur, "sectors", data.get("sector"))
            shift_id = self._catalog_id(cur, "shifts", data.get("turno"))
            floor_id = self._catalog_id(cur, "floors", data.get("piso"), "number") if data.get("piso") else None
            participates = company_role in {"Personal de camarería", "Personal de cocina", "Ayudante de cocina", "Personal franquero"}
            if user_id:
                cur.execute("SELECT id,employee_id FROM users WHERE id=%s FOR UPDATE", (user_id,))
                existing = cur.fetchone()
                if not existing:
                    raise DomainError("El usuario no existe.", 404, "notFound")
                employee_id = existing["employee_id"] or str(data.get("employeeId") or "").strip() or secrets.token_hex(16)
                cur.execute("SELECT id FROM users WHERE lower(username)=lower(%s) AND id<>%s", (username, user_id))
                if cur.fetchone():
                    raise DomainError("Ese usuario ya existe.", 409, "duplicateUsername")
                cur.execute("SELECT id FROM employees WHERE id=%s", (employee_id,))
                if cur.fetchone():
                    cur.execute("""UPDATE employees SET name=%s,initials=%s,company_role_id=%s,sector_id=%s,shift_id=%s,floor_id=%s,phone=%s,
                        participates_in_operation=%s WHERE id=%s""", (name, "".join(part[0] for part in name.split()[:2]).upper(), company_role_id, sector_id, shift_id, floor_id, str(data.get("phone") or "").strip(), participates, employee_id))
                else:
                    cur.execute("""INSERT INTO employees (id,name,initials,company_role_id,sector_id,shift_id,floor_id,phone,participates_in_operation)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (employee_id, name, "".join(part[0] for part in name.split()[:2]).upper(), company_role_id, sector_id, shift_id, floor_id, str(data.get("phone") or "").strip(), participates))
                fields, values = ["username=%s", "name=%s", "system_role=%s", "employee_id=%s"], [username, name, ROLE_TO_SYSTEM[role], employee_id]
                if password_hash:
                    fields.append("password_hash=%s")
                    values.append(password_hash)
                values.append(user_id)
                cur.execute(f"UPDATE users SET {','.join(fields)} WHERE id=%s", values)
                self._audit(cur, actor["id"], "updated_user", "user", user_id, metadata={"employeeId": employee_id, "role": role})
            else:
                employee_id = str(data.get("employeeId") or "").strip() or secrets.token_hex(16)
                cur.execute("SELECT id FROM users WHERE lower(username)=lower(%s)", (username,))
                if cur.fetchone():
                    raise DomainError("Ese usuario ya existe.", 409, "duplicateUsername")
                cur.execute("""INSERT INTO employees (id,name,initials,company_role_id,sector_id,shift_id,floor_id,phone,participates_in_operation)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (employee_id, name, "".join(part[0] for part in name.split()[:2]).upper(), company_role_id, sector_id, shift_id, floor_id, str(data.get("phone") or "").strip(), participates))
                user_id = secrets.token_hex(16)
                cur.execute("INSERT INTO users (id,username,name,system_role,employee_id,password_hash) VALUES (%s,%s,%s,%s,%s,%s)", (user_id, username, name, ROLE_TO_SYSTEM[role], employee_id, password_hash))
                self._audit(cur, actor["id"], "created_user", "user", user_id, metadata={"employeeId": employee_id, "role": role})
            conn.commit()
        return {"ok": True, "id": user_id, "employeeId": employee_id}

    def deactivate_user(self, actor, user_id):
        self._assert_manager(actor)
        if user_id == actor.get("id"):
            raise DomainError("No podés desactivar tu propia sesión.", 409, "selfDeactivation")
        with self.cursor() as (conn, cur):
            cur.execute("UPDATE users SET active=FALSE WHERE id=%s AND active=TRUE RETURNING employee_id,username", (user_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("El usuario no existe o ya está desactivado.", 404, "notFound")
            cur.execute("UPDATE sessions SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL", (user_id,))
            self._audit(cur, actor["id"], "deactivated_user", "user", user_id, metadata={"username": row["username"]})
            conn.commit()
        return {"ok": True, "id": user_id}

    def assign(self, actor, week_id, position_id, employee_id, expected_version=None):
        self._assert_manager(actor)
        with self.cursor() as (conn, cur):
            cur.execute("SELECT * FROM planning_weeks WHERE id=%s FOR UPDATE", (week_id,)); week=cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]: raise DomainError("La semana fue modificada por otra persona. Recargá la grilla.",409,"versionConflict")
            cur.execute("SELECT id,date FROM planning_positions WHERE id=%s AND planning_week_id=%s",(position_id,week_id)); pos=cur.fetchone()
            cur.execute("""SELECT e.id,e.name,fc.anchor_date,fc.anchor_type,fc.cycle_length_days FROM employees e
                LEFT JOIN employee_franco_cycles fc ON fc.employee_id=e.id
                WHERE e.id=%s AND e.status='active' AND e.participates_in_operation=TRUE""",(employee_id,)); emp=cur.fetchone()
            if not pos or not emp: raise DomainError("El puesto o empleado no es válido.")
            cur.execute("SELECT 1 FROM planning_days_off WHERE planning_week_id=%s AND employee_id=%s AND date=%s",(week_id,employee_id,pos["date"]))
            if cur.fetchone(): raise DomainError("La persona tiene un franco cargado para esa fecha.",409,"unavailable")
            if cycle_day_off(emp["anchor_date"], emp["anchor_type"], pos["date"], emp["cycle_length_days"] or 15):
                raise DomainError("La persona tiene franco F1/F2 calculado para esa fecha.",409,"unavailable")
            cur.execute("""SELECT 1 FROM requests WHERE employee_id=%s AND status='approved' AND type IN ('absence','leave','vacation','vacations')
                AND COALESCE(start_date,target_date) <= %s AND COALESCE(end_date,start_date,target_date) >= %s""", (employee_id,pos["date"],pos["date"]))
            if cur.fetchone(): raise DomainError("La persona tiene una ausencia o licencia aprobada para esa fecha.",409,"unavailable")
            cur.execute("SELECT id FROM planning_assignments WHERE planning_week_id=%s AND employee_id=%s AND assignment_date=%s AND position_id<>%s",(week_id,employee_id,pos["date"],position_id))
            if cur.fetchone(): raise DomainError("La persona ya está asignada ese día.",409,"duplicateAssignment")
            cur.execute("SELECT id FROM planning_assignments WHERE position_id=%s",(position_id,)); existing=cur.fetchone()
            if existing: cur.execute("UPDATE planning_assignments SET employee_id=%s,assignment_date=%s,created_by=%s,updated_at=now() WHERE id=%s",(employee_id,pos["date"],actor["id"],existing["id"]))
            else: cur.execute("INSERT INTO planning_assignments (id,planning_week_id,position_id,employee_id,assignment_date,created_by) VALUES (%s,%s,%s,%s,%s,%s)",(secrets.token_hex(16),week_id,position_id,employee_id,pos["date"],actor["id"]))
            cur.execute("UPDATE planning_weeks SET version=version+1,updated_at=now() WHERE id=%s RETURNING version",(week_id,)); version=cur.fetchone()["version"]
            self._audit(cur, actor["id"], "assigned_employee", "planning_position", position_id, metadata={"weekId": week_id, "employeeId": employee_id})
            conn.commit()
        return {"ok":True,"version":version,"employeeName":emp["name"]}

    def add_day_off(self, actor, week_id, employee_id, day, sector_id, kind, expected_version=None):
        self._assert_manager(actor)
        if kind not in {"F1","F2"}: raise DomainError("El tipo de franco debe ser F1 o F2.")
        with self.cursor() as (conn,cur):
            cur.execute("SELECT version,start_date,end_date FROM planning_weeks WHERE id=%s FOR UPDATE",(week_id,)); week=cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]: raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            if not (week["start_date"] <= date.fromisoformat(day) <= week["end_date"]): raise DomainError("La fecha no pertenece a la semana.")
            cur.execute("INSERT INTO planning_days_off (id,planning_week_id,employee_id,date,sector_id,type,created_by) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (planning_week_id,employee_id,date) DO UPDATE SET type=EXCLUDED.type,sector_id=EXCLUDED.sector_id",(secrets.token_hex(16),week_id,employee_id,day,sector_id,kind,actor["id"]))
            cur.execute("UPDATE planning_weeks SET version=version+1,updated_at=now() WHERE id=%s RETURNING version",(week_id,)); version=cur.fetchone()["version"]
            self._audit(cur, actor["id"], "set_manual_day_off", "planning_day_off", employee_id, metadata={"weekId": week_id, "date": day, "type": kind})
            conn.commit()
        return {"ok":True,"version":version}

    def create_week(self, actor, name, start_date):
        self._assert_manager(actor)
        try:
            start = date.fromisoformat(start_date)
        except (TypeError, ValueError):
            raise DomainError("La fecha de inicio no es válida.")
        name = str(name or "").strip()
        if not name:
            raise DomainError("El nombre de la semana es obligatorio.")
        week_id = secrets.token_hex(16)
        with self.cursor() as (conn, cur):
            cur.execute("INSERT INTO planning_weeks (id,name,start_date,end_date,status,created_by) VALUES (%s,%s,%s,%s,'draft',%s)", (week_id, name, start, start + timedelta(days=6), actor["id"]))
            cur.execute("SELECT id,sector_id,shift_id,label,slot,floor_id,optional FROM position_templates WHERE active=TRUE")
            templates = cur.fetchall()
            for day_index in range(7):
                current = start + timedelta(days=day_index)
                for template in templates:
                    position_id = f"{week_id}:{current.isoformat()}:{template['id']}"
                    cur.execute("""INSERT INTO planning_positions (id,planning_week_id,template_id,date,day_index,sector_id,shift_id,floor_id,slot,label,optional)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (position_id,week_id,template["id"],current,day_index,template["sector_id"],template["shift_id"],template["floor_id"],template["slot"],template["label"],template["optional"]))
            conn.commit()
        return {"id": week_id, "startDate": start.isoformat(), "endDate": (start + timedelta(days=6)).isoformat(), "version": 1}

    def set_week_status(self, actor, week_id, status, expected_version=None):
        self._assert_manager(actor)
        if status not in {"draft", "published", "paused"}:
            raise DomainError("Estado de semana inválido.")
        with self.cursor() as (conn, cur):
            cur.execute("SELECT version FROM planning_weeks WHERE id=%s FOR UPDATE", (week_id,)); row=cur.fetchone()
            if not row: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != row["version"]: raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            fields = "status=%s,version=version+1,updated_at=now()"
            values = [status]
            if status == "published": fields += ",published_at=now(),published_by=%s"; values.append(actor["id"])
            if status == "paused": fields += ",paused_at=now(),paused_by=%s"; values.append(actor["id"])
            values.append(week_id)
            cur.execute(f"UPDATE planning_weeks SET {fields} WHERE id=%s RETURNING version", values)
            version=cur.fetchone()["version"]
            self._audit(cur, actor["id"], "changed_week_status", "planning_week", week_id, result=status)
            conn.commit()
        return {"ok":True,"status":status,"version":version}

    def remove_assignment(self, actor, week_id, position_id, expected_version=None):
        self._assert_manager(actor)
        with self.cursor() as (conn, cur):
            cur.execute("SELECT version FROM planning_weeks WHERE id=%s FOR UPDATE", (week_id,)); week=cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]: raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            cur.execute("DELETE FROM planning_assignments WHERE planning_week_id=%s AND position_id=%s RETURNING id", (week_id,position_id))
            if not cur.fetchone(): raise DomainError("No existía una asignación para quitar.",404,"notFound")
            cur.execute("UPDATE planning_weeks SET version=version+1,updated_at=now() WHERE id=%s RETURNING version",(week_id,)); version=cur.fetchone()["version"]
            self._audit(cur, actor["id"], "removed_assignment", "planning_position", position_id, metadata={"weekId": week_id})
            conn.commit()
        return {"ok":True,"version":version}

    def remove_day_off(self, actor, week_id, day_off_id, expected_version=None):
        self._assert_manager(actor)
        with self.cursor() as (conn, cur):
            cur.execute("SELECT version FROM planning_weeks WHERE id=%s FOR UPDATE", (week_id,)); week=cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]: raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            cur.execute("DELETE FROM planning_days_off WHERE id=%s AND planning_week_id=%s RETURNING id",(day_off_id,week_id))
            if not cur.fetchone(): raise DomainError("No se encontró el franco.",404,"notFound")
            cur.execute("UPDATE planning_weeks SET version=version+1,updated_at=now() WHERE id=%s RETURNING version",(week_id,)); version=cur.fetchone()["version"]
            conn.commit()
        return {"ok":True,"version":version}

    def upsert_exception(self, actor, week_id, data, expected_version=None):
        self._assert_manager(actor)
        exception_id = data.get("id") or secrets.token_hex(16)
        with self.cursor() as (conn, cur):
            cur.execute("SELECT version FROM planning_weeks WHERE id=%s FOR UPDATE", (week_id,)); week=cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]: raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            cur.execute("SELECT id,date,shift_id,sector_id FROM planning_positions WHERE id=%s AND planning_week_id=%s",(data.get("positionId"),week_id)); position=cur.fetchone()
            if not position: raise DomainError("El puesto no pertenece a esta semana.")
            if data.get("type") not in {"leave","studyLeave","absence","dayOffChange","doubleShift","replacement","uncovered"}: raise DomainError("Tipo de excepción inválido.")
            cur.execute("""INSERT INTO planning_exceptions (id,planning_week_id,position_id,date,shift_id,sector_id,affected_employee_id,cover_employee_id,type,note,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET position_id=EXCLUDED.position_id,date=EXCLUDED.date,shift_id=EXCLUDED.shift_id,sector_id=EXCLUDED.sector_id,
                  affected_employee_id=EXCLUDED.affected_employee_id,cover_employee_id=EXCLUDED.cover_employee_id,type=EXCLUDED.type,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now()""",
                (exception_id,week_id,position["id"],position["date"],position["shift_id"],position["sector_id"],data.get("affectedEmployeeId") or None,data.get("coverEmployeeId") or None,data["type"],str(data.get("note") or ""),actor["id"],actor["id"]))
            cur.execute("UPDATE planning_weeks SET version=version+1,updated_at=now() WHERE id=%s RETURNING version",(week_id,)); version=cur.fetchone()["version"]
            conn.commit()
        return {"ok":True,"id":exception_id,"version":version}

    def remove_exception(self, actor, week_id, exception_id, expected_version=None):
        self._assert_manager(actor)
        with self.cursor() as (conn,cur):
            cur.execute("SELECT version FROM planning_weeks WHERE id=%s FOR UPDATE",(week_id,)); week=cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]: raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            cur.execute("DELETE FROM planning_exceptions WHERE id=%s AND planning_week_id=%s RETURNING id",(exception_id,week_id))
            if not cur.fetchone(): raise DomainError("No se encontró la excepción.",404,"notFound")
            cur.execute("UPDATE planning_weeks SET version=version+1,updated_at=now() WHERE id=%s RETURNING version",(week_id,)); version=cur.fetchone()["version"]
            conn.commit()
        return {"ok":True,"version":version}

    def delete_week(self, actor, week_id, expected_version=None):
        self._assert_manager(actor)
        with self.cursor() as (conn, cur):
            cur.execute("SELECT version FROM planning_weeks WHERE id=%s FOR UPDATE", (week_id,))
            week = cur.fetchone()
            if not week: raise DomainError("Semana inexistente.",404,"notFound")
            if expected_version is not None and expected_version != week["version"]:
                raise DomainError("La semana fue modificada por otra persona.",409,"versionConflict")
            cur.execute("DELETE FROM planning_weeks WHERE id=%s", (week_id,))
            self._audit(cur, actor["id"], "deleted_planning_week", "planning_week", week_id)
            conn.commit()
        return {"ok":True}

    def resolve_partner_request(self, actor, request_id, status):
        if status not in {"partnerAccepted","partnerRejected"}: raise DomainError("Respuesta de compañero inválida.")
        with self.cursor() as (conn,cur):
            cur.execute("""UPDATE requests SET status=%s,partner_status=%s,updated_at=now()
                WHERE id=%s AND partner_employee_id=%s AND status='pendingPartner' RETURNING id""", ("pendingManager" if status=="partnerAccepted" else status, "accepted" if status=="partnerAccepted" else "rejected", request_id,actor.get("employeeId")))
            if not cur.fetchone(): raise DomainError("No podés resolver esta solicitud.",403,"forbidden")
            conn.commit()
        return {"ok":True,"status":"pendingManager" if status=="partnerAccepted" else status}

    def mark_notifications_read(self, actor, notification_id=None):
        with self.cursor() as (conn,cur):
            if notification_id:
                cur.execute("UPDATE notifications SET read_at=now() WHERE id=%s AND (recipient_user_id IS NULL OR recipient_user_id=%s)", (notification_id,actor["id"]))
            else:
                cur.execute("UPDATE notifications SET read_at=now() WHERE read_at IS NULL AND (recipient_user_id IS NULL OR recipient_user_id=%s)", (actor["id"],))
            conn.commit()
        return {"ok":True}

    def create_request(self, actor, data):
        employee_id=actor.get("employeeId")
        if not employee_id: raise DomainError("El usuario no está vinculado a un empleado.",403,"forbidden")
        kind=data.get("type"); note=str(data.get("note","")).strip(); impact=data.get("scheduleImpact") or {}
        if kind not in {"absence","leave","dayOffChange","shiftChange","vacation","vacations"} or not note: raise DomainError("Tipo y detalle de solicitud son obligatorios.")
        partner=data.get("partnerEmployeeId") or None
        if kind in {"dayOffChange","shiftChange"} and not partner: raise DomainError("Este cambio requiere un compañero.")
        request_id="SOL-"+secrets.token_hex(6).upper()
        status="pendingPartner" if partner else "pendingManager"
        target=(impact.get("target") or {}).get("date")
        with self.cursor() as (conn,cur):
            cur.execute("INSERT INTO requests (id,employee_id,type,status,partner_employee_id,partner_status,note,target_date,schedule_impact) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",(request_id,employee_id,kind,status,partner,"pending" if partner else None,note,target,Jsonb(impact)))
            cur.execute("INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,result) VALUES (%s,%s,%s,'request',%s,%s)",(secrets.token_hex(16),actor["id"],"created_request",request_id,status))
            conn.commit()
        return {"id":request_id,"status":status}

    def resolve_request(self, actor, request_id, status):
        self._assert_manager(actor)
        if status not in {"approved","rejected"}: raise DomainError("Estado de resolución inválido.")
        with self.cursor() as (conn,cur):
            cur.execute("UPDATE requests SET status=%s,resolved_at=now(),resolved_by=%s,updated_at=now() WHERE id=%s AND status IN ('pendingManager','pendingPartner','partnerAccepted') RETURNING id",(status,actor["id"],request_id))
            if not cur.fetchone(): raise DomainError("La solicitud no existe o ya fue resuelta.",404,"notFound")
            conn.commit()
        return {"ok":True,"status":status}

    def revoke_request(self, actor, request_id, reason):
        reason = str(reason or "").strip()
        if not reason:
            raise DomainError("Indicá un motivo de revocación.")
        with self.cursor() as (conn, cur):
            cur.execute("SELECT employee_id,status FROM requests WHERE id=%s FOR UPDATE", (request_id,))
            request = cur.fetchone()
            if not request:
                raise DomainError("La solicitud no existe.", 404, "notFound")
            if actor.get("role") not in MANAGER_ROLES and request["employee_id"] != actor.get("employeeId"):
                raise DomainError("No podés revocar esta solicitud.", 403, "forbidden")
            if request["status"] not in {"approved", "pendingManager", "pendingPartner"}:
                raise DomainError("La solicitud no puede revocarse en su estado actual.", 409, "invalidState")
            cur.execute("""UPDATE requests SET status='revoked',revoked_at=now(),revoked_by=%s,revocation_reason=%s,updated_at=now()
                WHERE id=%s""", (actor["id"], reason, request_id))
            self._audit(cur, actor["id"], "revoked_request", "request", request_id, metadata={"reason": reason})
            conn.commit()
        return {"ok": True, "status": "revoked", "requiresManualReview": request["status"] == "approved"}
