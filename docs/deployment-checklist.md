# Despliegue y recuperación

## Railway

1. Configurar `DATABASE_URL` con la red privada de PostgreSQL. No agregar la URL pública al repositorio.
2. Definir `COOKIE_SECURE=true`, `HOST=0.0.0.0` y un `LOG_LEVEL` adecuado (normalmente `INFO`).
3. Mantener `DATABASE_POOL_MIN_SIZE=1`, `DATABASE_POOL_MAX_SIZE=8` y `DATABASE_POOL_TIMEOUT_SECONDS=5` salvo que las métricas indiquen otro valor.
4. Desplegar, consultar `/health` y luego `/ready`. El primero confirma que el proceso vive; el segundo que PostgreSQL responde.
5. Revisar en los logs `http_request` y `database_cursor`. Las claves `duration_ms` permiten identificar si la demora está en la base o en la app.

## Backup y restauración

1. Activar las copias automáticas del servicio PostgreSQL desde Railway.
2. Antes de una migración relevante, generar un backup manual y registrar fecha, entorno y responsable.
3. Restaurar primero sobre una base aislada, ejecutar `python scripts/validate_migrations.py` y comprobar conteos operativos.
4. Validar inicio de sesión, semana publicada, solicitudes y auditoría antes de redirigir tráfico.

El procedimiento ampliado de restauración está en `docs/railway-backup-runbook.md`.
