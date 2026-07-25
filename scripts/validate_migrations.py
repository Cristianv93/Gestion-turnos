#!/usr/bin/env python3
"""Chequeos estáticos mínimos para impedir migraciones peligrosas en CI."""
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
PATTERN = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")
FORBIDDEN = re.compile(r"\b(DROP\s+TABLE|TRUNCATE\s+TABLE)\b", re.IGNORECASE)


def main():
    files = sorted(MIGRATIONS.glob("*.sql"))
    numbers = []
    for path in files:
        match = PATTERN.match(path.name)
        if not match:
            raise SystemExit(f"Nombre de migración inválido: {path.name}")
        numbers.append(int(match.group(1)))
        source = path.read_text(encoding="utf-8")
        if not source.strip():
            raise SystemExit(f"Migración vacía: {path.name}")
        if FORBIDDEN.search(source):
            raise SystemExit(f"Migración destructiva bloqueada: {path.name}")
    if numbers != sorted(set(numbers)):
        raise SystemExit("Los prefijos de migración deben ser únicos y crecientes.")
    print(f"Migraciones validadas: {len(files)}")


if __name__ == "__main__":
    main()
