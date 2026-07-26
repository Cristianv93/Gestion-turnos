"""Falla si un secreto frecuente quedó versionado por accidente.

No sustituye los secretos del proveedor de despliegue: es una barrera rápida
para el repositorio y no imprime el contenido sensible que detecta.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


RULES = {
    "URL de PostgreSQL con credenciales": re.compile(r"postgres(?:ql)?://(?!\$\{)[^\s'\"`]+", re.IGNORECASE),
    "clave privada": re.compile(r"BEGIN (?:RSA|OPENSSH) PRIVATE KEY"),
    "AWS_SECRET_ACCESS_KEY": re.compile(r"AWS_SECRET_ACCESS_KEY\s*=\s*[^\s]+"),
}
EXCLUDED_FILES = {".env.example"}


def tracked_files() -> list[Path]:
    output = subprocess.check_output(["git", "ls-files", "-z"], text=False)
    return [Path(value.decode("utf-8")) for value in output.split(b"\0") if value]


def main() -> int:
    failures: list[str] = []
    for path in tracked_files():
        if path.name in EXCLUDED_FILES or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in RULES.items():
            if pattern.search(text):
                failures.append(f"{path}: {label}")
    if failures:
        print("Posibles secretos detectados (el contenido fue ocultado):", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Chequeo de secretos aprobado.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
