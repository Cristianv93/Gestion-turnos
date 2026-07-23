# Plan de upgrade: PostgreSQL y backend Python

## Objetivo

Convertir al backend Python en la autoridad de los datos y dejar al frontend como una capa de presentación y captura de acciones. El frontend no debe enviar ni reemplazar el estado completo de la aplicación.

## Estado actual

- `server.py` lee y escribe todo `data/uzumaki-db.json`.
- `src/services/store.js` carga el estado completo y hace `PUT /api/state`.
- `src/app.js` modifica objetos en memoria.
- `src/services/planningEngine.js` contiene reglas de disponibilidad, ciclos F1/F2, coberturas y excepciones.
- Los permisos se comprueban en frontend y parcialmente en el endpoint global.

## Arquitectura objetivo

```text
Frontend vanilla JS
  -> API Python / recursos
  -> servicios de dominio y transacciones
  -> PostgreSQL Railway
  -> almacenamiento de archivos para certificados
```

El frontend podrá conservar un caché de lectura para mejorar la experiencia, pero nunca será la fuente de verdad.

## Fases de implementación

### Fase 0: respaldo y migración inicial

1. Ejecutar `migrations/001_initial_schema.sql` en Railway.
2. Instalar `psycopg[binary]` en el servicio.
3. Ejecutar `scripts/import_json_to_postgres.py` con la variable `DATABASE_URL`.
4. Ejecutar `migrations/002_post_import_checks.sql`.
5. Comparar los conteos contra `uzumaki-db.json`.
6. Conservar el JSON como backup de solo lectura hasta cerrar la migración.

### Fase 1: capa de acceso a datos

Crear módulos Python:

```text
backend/
  db.py              # pool/conexiones y transacciones
  auth.py            # login, hash, sesiones persistentes
  permissions.py     # permisos del lado servidor
  repositories/
    employees.py
    planning.py
    requests.py
  services/
    planning_service.py
    request_service.py
    notification_service.py
  routes/
    auth.py
    employees.py
    planning.py
    requests.py
```

No hace falta introducir un framework inmediatamente. Se puede mantener `http.server` para el primer corte, pero conviene migrar a Flask, FastAPI o una capa HTTP equivalente antes de crecer la API.

### Fase 2: reemplazo progresivo de la API global

Endpoints prioritarios:

```text
GET   /api/bootstrap
GET   /api/me

GET   /api/employees
POST  /api/employees
PATCH /api/employees/{id}

GET   /api/planning-weeks
POST  /api/planning-weeks
GET   /api/planning-weeks/{id}
PATCH /api/planning-weeks/{id}
POST  /api/planning-weeks/{id}/generate-proposal
POST  /api/planning-weeks/{id}/publish
POST  /api/planning-weeks/{id}/pause

PUT   /api/planning-weeks/{id}/assignments/{assignment_id}
POST  /api/planning-weeks/{id}/days-off
POST  /api/planning-weeks/{id}/exceptions

GET   /api/requests
POST  /api/requests
POST  /api/requests/{id}/partner-resolution
POST  /api/requests/{id}/resolve
POST  /api/requests/{id}/revoke
```

`PUT /api/state` debe mantenerse temporalmente para rollback, pero bloquearse o eliminarse después del corte.

### Fase 3: trasladar reglas de negocio

Mover al backend, en este orden:

1. Verificación de roles y permisos.
2. Validación de empleados activos.
3. Regla de una asignación por persona y día.
4. Ciclo F1/F2.
5. Licencias y ausencias aprobadas.
6. Aprobación de cambios de franco y turno.
7. Aplicación y reversión de solicitudes.
8. Generación de propuesta.
9. Publicación y pausa de semanas.
10. Auditoría de cada operación.

`planningEngine.js` puede utilizarse como especificación funcional para reimplementar el motor en Python. Durante una etapa intermedia también puede mantenerse en frontend únicamente para mostrar una previsualización, pero la respuesta del backend debe ser la definitiva.

### Fase 4: quitar poder al frontend

Cambios en `app.js` y `store.js`:

- Eliminar mutaciones directas de `state.employees`, `state.requests` y `state.planningWeek` como mecanismo de persistencia.
- Reemplazar `persist()` por funciones como `api.createRequest()`, `api.publishWeek()` y `api.assignPosition()`.
- Después de cada operación, actualizar el estado local con la respuesta del backend o volver a consultar el recurso.
- No permitir que el frontend elija libremente `status`, `resolved_by`, `published_by` o `created_by`.
- No confiar en nombres de empleados, roles o IDs enviados por pantalla; el backend debe resolverlos mediante relaciones.

## Concurrencia

Cada semana tendrá un campo `version`. Las modificaciones deben usar actualización optimista:

```sql
UPDATE planning_weeks
SET version = version + 1, updated_at = now()
WHERE id = $1 AND version = $2;
```

Si no se actualiza ninguna fila, la API responde `409 Conflict`.

Las acciones compuestas, como aprobar una solicitud y modificar la grilla, deben ejecutarse en una única transacción PostgreSQL.

## Seguridad

- Mantener los hashes PBKDF2 existentes durante la migración.
- Guardar sesiones en PostgreSQL o implementar cookies firmadas y revocables.
- Validar permisos exclusivamente en backend.
- No devolver `password_hash` al frontend.
- Guardar certificados fuera de PostgreSQL, en almacenamiento de objetos, y persistir solo su `storage_key`.
- Agregar límites de intentos de login y auditoría de eventos de seguridad.

## Criterio de finalización

La migración estará completa cuando:

1. Railway sea la única fuente operativa.
2. El frontend no pueda cambiar datos mediante un documento global.
3. Las operaciones críticas tengan transacciones y auditoría.
4. Dos usuarios puedan trabajar simultáneamente sin sobrescribirse cambios no relacionados.
5. Se pueda reconstruir una grilla publicada desde tablas normalizadas.
6. El JSON quede únicamente como exportación o backup manual.
