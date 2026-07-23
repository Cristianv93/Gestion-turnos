const MANAGER_ROLES = ["admin", "manager"];

export const isAdminRole = (role) => ["admin", "manager", "supervisor"].includes(role);
export const canEditSchedule = (role) => MANAGER_ROLES.includes(role);
export const canEditApplications = (role) => MANAGER_ROLES.includes(role);
export const canManageEmployees = (role) => MANAGER_ROLES.includes(role);
export const canResolveRequests = (role) => canEditApplications(role);
export const canSeeAudit = (role) => ["admin", "manager", "supervisor"].includes(role);

export const roleLabel = {
  admin: "Administración principal",
  manager: "Encargada",
  supervisor: "Supervisión",
  staff: "Personal operativo",
};
