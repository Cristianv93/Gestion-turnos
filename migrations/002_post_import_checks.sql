-- Consultas de verificación para ejecutar después de la importación.
-- No modifican datos.

SELECT 'employees' AS entity, count(*) AS total FROM employees
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'planning_weeks', count(*) FROM planning_weeks
UNION ALL SELECT 'planning_positions', count(*) FROM planning_positions
UNION ALL SELECT 'planning_assignments', count(*) FROM planning_assignments
UNION ALL SELECT 'planning_days_off', count(*) FROM planning_days_off
UNION ALL SELECT 'planning_exceptions', count(*) FROM planning_exceptions
UNION ALL SELECT 'notifications', count(*) FROM notifications
UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs;

-- Asignaciones que apuntan a una persona inexistente.
SELECT a.id, a.employee_id
FROM planning_assignments a
LEFT JOIN employees e ON e.id = a.employee_id
WHERE e.id IS NULL;

-- Personas asignadas más de una vez durante el mismo día.
SELECT a.planning_week_id, a.employee_id, p.date, count(*) AS assignments
FROM planning_assignments a
JOIN planning_positions p ON p.id = a.position_id
GROUP BY a.planning_week_id, a.employee_id, p.date
HAVING count(*) > 1;

-- Puestos que quedaron sin asignación en semanas publicadas.
SELECT p.planning_week_id, p.date, p.label
FROM planning_positions p
JOIN planning_weeks w ON w.id = p.planning_week_id AND w.status = 'published'
LEFT JOIN planning_assignments a ON a.position_id = p.id
WHERE a.id IS NULL AND p.optional = FALSE
ORDER BY p.date, p.label;
