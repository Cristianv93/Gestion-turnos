BEGIN;

-- El restablecimiento administrativo nunca almacena contraseñas temporales: solo
-- conserva el estado necesario para obligar su renovación al próximo acceso.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS password_reset_at TIMESTAMPTZ;

UPDATE users
SET password_changed_at = COALESCE(password_changed_at, updated_at, created_at, now())
WHERE password_changed_at IS NULL;

CREATE INDEX IF NOT EXISTS users_password_change_required_idx
ON users (id) WHERE active = TRUE AND must_change_password = TRUE;

COMMIT;
