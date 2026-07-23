# PostgreSQL: migración y operación

La aplicación usa `DATABASE_URL` como fuente de datos. En Railway debe apuntar
al host privado; para ejecutar desde tu computadora, usá la URL pública con
`sslmode=require` en `.env`.

## Carga inicial (una sola vez)

Desde la carpeta del proyecto:

```bash
python3 -m pip install -r requirements.txt
python3 scripts/migrate_postgres.py
python3 scripts/import_json_to_postgres.py
python3 scripts/test_postgres_connection.py
```

Los dos primeros comandos son idempotentes: se pueden repetir sin duplicar
filas. El esquema aplicado queda registrado en `schema_migrations`.

## Queries de validación

En Railway Query, o con `psql "$DATABASE_URL" -f migrations/002_post_import_checks.sql`:

```sql
SELECT 'employees' entidad, count(*) total FROM employees
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'planning_weeks', count(*) FROM planning_weeks
UNION ALL SELECT 'planning_positions', count(*) FROM planning_positions
UNION ALL SELECT 'planning_assignments', count(*) FROM planning_assignments;

SELECT w.name, w.status, w.version, count(a.id) asignaciones
FROM planning_weeks w
LEFT JOIN planning_assignments a ON a.planning_week_id = w.id
GROUP BY w.id
ORDER BY w.start_date DESC;

SELECT p.date, p.label
FROM planning_positions p
JOIN planning_weeks w ON w.id = p.planning_week_id AND w.status = 'published'
LEFT JOIN planning_assignments a ON a.position_id = p.id
WHERE NOT p.optional AND a.id IS NULL
ORDER BY p.date, p.label;
```

## API de dominio

Todas requieren la cookie de sesión y validan permisos en Python. `version` es
el número recibido en `GET /api/state`; si otra persona cambió la semana, la
API responde `409` en vez de pisar datos.

| Acción | Método y endpoint | Cuerpo mínimo |
| --- | --- | --- |
| Crear semana | `POST /api/planning/weeks` | `name`, `startDate` |
| Asignar persona | `POST /api/planning/assignments` | `weekId`, `positionId`, `employeeId`, `version` |
| Quitar asignación | `DELETE /api/planning/assignments/:positionId` | Headers `X-Week-Id`, `If-Match` |
| Cargar franco | `POST /api/planning/days-off` | `weekId`, `employeeId`, `date`, `sectorId`, `type`, `version` |
| Quitar franco | `DELETE /api/planning/days-off/:id` | Headers `X-Week-Id`, `If-Match` |
| Crear/editar excepción | `POST /api/planning/exceptions` | `weekId`, `positionId`, `type`, `version` |
| Quitar excepción | `DELETE /api/planning/exceptions/:id` | Headers `X-Week-Id`, `If-Match` |
| Cambiar estado | `POST /api/planning/weeks/:id/status` | `status`, `version` |
| Eliminar semana | `DELETE /api/planning/weeks/:id` | — |
| Crear solicitud | `POST /api/requests` | `type`, `note`, `scheduleImpact` |
| Resolver solicitud | `POST /api/requests/:id/resolve` | `status` |
| Respuesta de compañero | `POST /api/requests/:id/partner-response` | `status` |
| Leer notificaciones | `POST /api/notifications/read` | `notificationId` opcional |

No hay escritura completa por `PUT /api/state` cuando existe `DATABASE_URL`:
ese endpoint devuelve `410`. El JSON queda sólo como respaldo/importación.

Antes de producción, rotá la contraseña de PostgreSQL que fue compartida y
actualizá `DATABASE_URL` en Railway y en tu `.env` local.
