# Backups y restauración en Railway

Railway/PostgreSQL es la fuente de verdad. Configurá un backup administrado diario en el servicio PostgreSQL y conservá al menos 14 días.

## Antes de cada migración

1. Crear un backup/snapshot desde Railway.
2. Ejecutar `python scripts/migrate_postgres.py` desde un entorno con `DATABASE_URL` privado.
3. Ejecutar `migrations/002_post_import_checks.sql` y conservar el resultado en el ticket de despliegue.

## Restauración probada

1. Restaurar primero en una base Railway temporal, nunca directamente sobre producción.
2. Levantar la app temporal contra esa base y validar `/health`, `/ready`, login, grilla y solicitudes.
3. Confirmar conteos de empleados, usuarios, semanas, posiciones, asignaciones y solicitudes.
4. Sólo con aprobación operativa, restaurar el backup seleccionado en producción.

El JSON no se usa como respaldo operativo ni se expone por HTTP; una exportación administrativa futura deberá generarse desde PostgreSQL y almacenarse cifrada.
