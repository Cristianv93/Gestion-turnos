-- Uzumaki / Gestión de turnos
-- PostgreSQL para Railway. Los IDs se mantienen como TEXT para no romper
-- referencias existentes como emp-..., user-... y week:date:template.

BEGIN;

CREATE TABLE IF NOT EXISTS sectors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    start_time TIME,
    end_time TIME,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS floors (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS company_roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sector_id TEXT REFERENCES sectors(id),
    allowed_sectors JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS system_roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS position_templates (
    id TEXT PRIMARY KEY,
    sector_id TEXT REFERENCES sectors(id),
    shift_id TEXT REFERENCES shifts(id),
    label TEXT NOT NULL,
    slot INTEGER,
    floor_id TEXT REFERENCES floors(id),
    optional BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    initials TEXT,
    company_role_id TEXT REFERENCES company_roles(id),
    sector_id TEXT REFERENCES sectors(id),
    shift_id TEXT REFERENCES shifts(id),
    floor_id TEXT REFERENCES floors(id),
    phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    participates_in_operation BOOLEAN NOT NULL DEFAULT TRUE,
    habitual_position_template_id TEXT REFERENCES position_templates(id),
    legacy_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employee_franco_cycles (
    employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    anchor_date DATE NOT NULL,
    anchor_type TEXT NOT NULL CHECK (anchor_type IN ('F1', 'F2')),
    cycle_length_days INTEGER NOT NULL DEFAULT 15 CHECK (cycle_length_days > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    system_role TEXT NOT NULL REFERENCES system_roles(id),
    employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS planning_weeks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    paused_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    paused_at TIMESTAMPTZ,
    last_proposal_at TIMESTAMPTZ,
    last_proposal_mode TEXT,
    last_coverage_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
    legacy_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date = start_date + 6)
);

CREATE TABLE IF NOT EXISTS planning_positions (
    id TEXT PRIMARY KEY,
    planning_week_id TEXT NOT NULL REFERENCES planning_weeks(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES position_templates(id),
    date DATE NOT NULL,
    day_index INTEGER NOT NULL CHECK (day_index BETWEEN 0 AND 6),
    sector_id TEXT REFERENCES sectors(id),
    shift_id TEXT REFERENCES shifts(id),
    floor_id TEXT REFERENCES floors(id),
    slot INTEGER,
    label TEXT NOT NULL,
    optional BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (planning_week_id, date, template_id)
);

CREATE TABLE IF NOT EXISTS planning_assignments (
    id TEXT PRIMARY KEY,
    planning_week_id TEXT NOT NULL REFERENCES planning_weeks(id) ON DELETE CASCADE,
    position_id TEXT NOT NULL UNIQUE REFERENCES planning_positions(id) ON DELETE CASCADE,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    assignment_date DATE NOT NULL,
    assignment_type TEXT NOT NULL DEFAULT 'regular',
    generated BOOLEAN NOT NULL DEFAULT FALSE,
    generation_reason TEXT,
    covered_employee_id TEXT REFERENCES employees(id),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Evita que una persona ocupe dos puestos el mismo día en la misma semana.
CREATE UNIQUE INDEX IF NOT EXISTS planning_one_assignment_per_employee_day
ON planning_assignments (planning_week_id, employee_id, assignment_date);

CREATE TABLE IF NOT EXISTS planning_days_off (
    id TEXT PRIMARY KEY,
    planning_week_id TEXT NOT NULL REFERENCES planning_weeks(id) ON DELETE CASCADE,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    date DATE NOT NULL,
    sector_id TEXT REFERENCES sectors(id),
    type TEXT NOT NULL CHECK (type IN ('F1', 'F2')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (planning_week_id, employee_id, date)
);

CREATE TABLE IF NOT EXISTS planning_exceptions (
    id TEXT PRIMARY KEY,
    planning_week_id TEXT NOT NULL REFERENCES planning_weeks(id) ON DELETE CASCADE,
    position_id TEXT REFERENCES planning_positions(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    shift_id TEXT REFERENCES shifts(id),
    sector_id TEXT REFERENCES sectors(id),
    affected_employee_id TEXT REFERENCES employees(id),
    cover_employee_id TEXT REFERENCES employees(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT NOT NULL DEFAULT '',
    source_request_id TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS planning_coverages (
    id TEXT PRIMARY KEY,
    planning_week_id TEXT NOT NULL REFERENCES planning_weeks(id) ON DELETE CASCADE,
    date DATE,
    position_id TEXT REFERENCES planning_positions(id) ON DELETE SET NULL,
    cover_employee_id TEXT REFERENCES employees(id),
    covered_employee_id TEXT REFERENCES employees(id),
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    partner_employee_id TEXT REFERENCES employees(id),
    partner_status TEXT,
    note TEXT NOT NULL DEFAULT '',
    target_date DATE,
    start_date DATE,
    end_date DATE,
    schedule_impact JSONB NOT NULL DEFAULT '{}'::jsonb,
    planning_application JSONB,
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS request_attachments (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT,
    size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    result TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
    planning_week_id TEXT REFERENCES planning_weeks(id) ON DELETE SET NULL,
    type TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_snapshots (
    key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planning_weeks_dates_idx ON planning_weeks (start_date, end_date);
CREATE INDEX IF NOT EXISTS planning_positions_week_date_idx ON planning_positions (planning_week_id, date);
CREATE INDEX IF NOT EXISTS planning_assignments_employee_idx ON planning_assignments (employee_id);
CREATE INDEX IF NOT EXISTS requests_employee_status_idx ON requests (employee_id, status);
CREATE INDEX IF NOT EXISTS notifications_recipient_read_idx ON notifications (recipient_user_id, read_at);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);

COMMIT;
