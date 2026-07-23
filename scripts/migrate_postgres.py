#!/usr/bin/env python3
"""Aplica los SQL de migrations/ una vez y registra cada versión en PostgreSQL."""
import os
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]


def load_env():
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main():
    load_env()
    url = os.environ.get("DATABASE_URL") or os.environ.get("DATABASE_PUBLIC_URL")
    if not url:
        raise SystemExit("Falta DATABASE_URL o DATABASE_PUBLIC_URL.")
    files = sorted((ROOT / "migrations").glob("[0-9][0-9][0-9]_*.sql"))
    # 002 es sólo diagnóstico y no debe registrarse como cambio de esquema.
    files = [path for path in files if "checks" not in path.name]
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        cur.execute("SELECT name FROM schema_migrations")
        done = {row[0] for row in cur.fetchall()}
        for path in files:
            if path.name in done:
                print(f"Ya aplicada: {path.name}")
                continue
            print(f"Aplicando: {path.name}")
            cur.execute(path.read_text(encoding="utf-8"))
            cur.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
        conn.commit()
    print("Migraciones completadas.")


if __name__ == "__main__":
    main()
