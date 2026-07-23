# Plan de acción para producción

## Estado actual

PostgreSQL ya contiene la operación migrada: empleados, usuarios, semana,
puestos, asignaciones, notificaciones y auditoría. La API ya controla creación
de semanas, asignaciones, francos y solicitudes. Aún queda lógica de negocio
en el navegador y compatibilidad JSON que debe retirarse ordenadamente.

## Fase 1 — Preparar el repositorio (inmediata)

1. Mantener `data/uzumaki-db.json` sólo como backup privado y nunca subirlo.
2. Rotar la contraseña PostgreSQL expuesta y actualizar las variables Railway.
3. Confirmar que `.env` no está versionado y que `docs/` sí lo está.
4. Corregir el Dockerfile para instalar `requirements.txt`; hoy una imagen nueva
   no incluye `psycopg`.
5. Elegir una única estrategia de despliegue: Railway o Docker/Caddy. Si la
   operación será exclusivamente Railway, retirar `docker-compose.yml` y
   `deploy/Caddyfile` en una limpieza posterior.

## Fase 2 — Eliminar dependencia JSON y poder del frontend

### `src/services/store.js`

Hoy mezcla API, localStorage, exportación/importación y valores mock. Dividirlo
en un cliente HTTP (`api.js`) y consultas de lectura. Retirar `saveState`,
`resetState`, el `PUT /api/state` legado y la persistencia operativa en
localStorage. Conservar exportación sólo como reporte administrativo generado
por backend.

### `src/data/mockData.js`

Se usa como fallback y normalizador. Moverlo a `scripts/seed_demo.py` si se
necesita una base demo. Después eliminar la importación desde la aplicación y
retirar el archivo del bundle productivo.

### `src/services/planningWeeks.js`

La creación de semana ya se hace en Python. Tras confirmar que el frontend usa
solamente `POST /api/planning/weeks`, retirar `createDraftPlanningWeek` y dejar
el archivo sólo si aporta componentes de visualización. Los templates deben
vivir en PostgreSQL (`position_templates`).

### `src/services/planningEngine.js`

Es la prioridad técnica: contiene F1/F2, disponibilidad, coberturas,
excepciones y reglas Gustavo/Julio. Portar esas reglas a un servicio Python
(`planning_service.py`) con pruebas. El frontend debe pedir propuestas y
previsualizaciones a endpoints, nunca decidir asignaciones finales.

### `src/app.js`

Está demasiado concentrado: render, modales, reglas y eventos conviven en un
archivo grande. Separar por dominios (`pages/planning.js`, `pages/requests.js`,
`pages/employees.js`, `ui/modal.js`). Cada mutación debe llamar una API y
recargar el recurso afectado.

## Fase 3 — Completar API de dominio

Implementar y conectar, en este orden:

1. Quitar/editar asignación, franco y excepción. **Implementado** para las
   acciones manuales de planificación.
2. Publicar, pausar y devolver a borrador una semana. **Implementado**.
3. Aceptar/rechazar solicitud por compañero y revocar una aprobada. La respuesta
   de compañero está **implementada**; falta la revocación transaccional.
4. Aplicar en backend ausencias, licencias y cambios de turno a la semana.
5. CRUD de empleados y usuarios, incluyendo desactivación en lugar de borrado
   físico cuando haya historial.
6. Notificaciones: marcar una/todas como leídas.

Cada operación debe escribir `audit_logs`, validar el rol y usar la columna
`planning_weeks.version` para concurrencia.

## Fase 4 — Calidad, seguridad y operación

1. Pruebas de API para permisos, doble asignación y ciclos F1/F2.
2. Rate limit de login, restablecimiento seguro de contraseña y auditoría de
   accesos.
3. Backups automáticos de Railway y restauración probada.
4. CI: compilación Python, validación SQL, pruebas y chequeo de secretos.
5. Variables separadas por desarrollo/staging/producción y `COOKIE_SECURE=true`
   en producción.

## Archivos eliminados en esta limpieza

- `scripts/create_users_table_from_json.py` (reemplazado por migración completa).
- `assets/login-logo-spiral.png`, `assets/login-spiral.svg` y
  `assets/Orange_Vector_Color_Palette_generated.jpg` (sin referencias).
- Cachés `__pycache__/` y `*.pyc` (generadas automáticamente).
