# Uzumaki — Gestión de turnos

Aplicación web para planificar turnos, gestionar personal y procesar solicitudes operativas. PostgreSQL es la fuente de verdad; el JSON histórico no forma parte del repositorio ni de la operación normal.

## Desarrollo local

1. Crear `.env` con `DATABASE_URL` o `DATABASE_PUBLIC_URL` de PostgreSQL.
2. Instalar dependencias y preparar la base:

```bash
python3 -m pip install -r requirements.txt
python3 scripts/migrate_postgres.py
python3 scripts/import_json_to_postgres.py # sólo para la primera carga histórica
LOG_LEVEL=INFO python3 -u server.py
```

Abrir `http://127.0.0.1:53123`.

La terminal muestra logs JSON de inicio, peticiones HTTP, duración, usuario
autenticado, operaciones de planificación y rechazos de validación. Usá
`LOG_LEVEL=DEBUG` durante diagnóstico; `INFO` es el valor recomendado.

## Arquitectura

```text
server.py       API HTTP, autenticación y archivos estáticos
database.py     transacciones, permisos y reglas de persistencia PostgreSQL
migrations/     esquema versionado y consultas de validación
scripts/        migración, importación y prueba de conexión
src/            interfaz JavaScript y estilos
docs/           operación y plan de evolución
```

Las acciones críticas se comunican mediante comandos de API: crear semanas, asignar personal, cargar francos y gestionar solicitudes. La API valida permisos y la versión de la semana para evitar sobrescribir cambios concurrentes.

## Railway

En Railway, configurá `DATABASE_URL` con la URL privada del servicio PostgreSQL. Para ejecutar desde una computadora, usá la URL pública con `sslmode=require`. Consultá [docs/postgres-operations.md](docs/postgres-operations.md) para migración, validaciones y endpoints.

No publiques `.env`, respaldos ni datos personales. Rotá las credenciales de base de datos antes de producción.
