import {
  auditLogs,
  DAYS,
  demoUsers as initialUsers,
  employees,
  incidents,
  initialAudit,
  initialNotifications,
  initialRequests,
  initialSchedule,
  pisos,
  referenceSchedule,
  requests,
  rolesOperativos,
  rolesSistema,
  sectores,
  turnos,
  weeklySchedules,
} from "../data/mockData.js?v=20260717-2";

const KEY = "uzumaki-mvp-state-v5";
const LEGACY_KEYS = ["uzumaki-mvp-state-v4", "uzumaki-mvp-state-v3", "uzumaki-mvp-state-v2", "uzumaki-mvp-state-v1", "turnia-mvp-state-v1"];
const API_STATE_URL = "/api/state";
let saveQueue = Promise.resolve();
export const STATE_FILE_NAME = "uzumaki-db.json";
export const canPersistStateFile = () => window.location.protocol.startsWith("http");
const normalizePlanningWeek = (week) => {
  if (!week || typeof week !== "object") return null;
  return {
    ...week,
    operationalPositions: Array.isArray(week.operationalPositions) ? week.operationalPositions : [],
    assignments: Array.isArray(week.assignments) ? week.assignments : [],
    daysOff: Array.isArray(week.daysOff) ? week.daysOff : [],
    coverages: Array.isArray(week.coverages) ? week.coverages : [],
    exceptions: Array.isArray(week.exceptions) ? week.exceptions : [],
  };
};
const requestTypeLegacyMap = {
  "Parte de enfermo": "absence",
  Ausencia: "absence",
  Licencia: "leave",
  Vacaciones: "leave",
  "Cambio de franco": "dayOffChange",
  "Cambio de turno": "shiftChange",
};
const companyRoleMap = {
  Cocinero: "Personal de cocina",
  "Peón de cocina": "Ayudante de cocina",
  Camarera: "Personal de camarería",
  Franquera: "Personal franquero",
  "Encargada/Nutricionista": "Encargada/Nutrición",
  Supervisora: "Supervisión",
};
const neutralizeCompanyRole = (role) => companyRoleMap[role] || role;
const normalizeEmployee = (employee) => {
  if (!employee || typeof employee !== "object") return employee;
  const canonicalEmployee = employees.find((item) => item.id === employee.id);
  const missingCycle = !Object.prototype.hasOwnProperty.call(employee, "francoCycle") && canonicalEmployee?.francoCycle;
  const missingHabitualPosition = !Object.prototype.hasOwnProperty.call(employee, "habitualPositionTemplateId")
    && Object.prototype.hasOwnProperty.call(canonicalEmployee || {}, "habitualPositionTemplateId");
  return {
    ...employee,
    role: neutralizeCompanyRole(employee.role),
    francos: canonicalEmployee?.francoCycle ? [] : Array.isArray(employee.francos) ? employee.francos : [],
    ...(missingCycle ? { francoCycle: structuredClone(canonicalEmployee.francoCycle) } : {}),
    ...(missingHabitualPosition ? { habitualPositionTemplateId: canonicalEmployee.habitualPositionTemplateId } : {}),
  };
};
const normalizeCatalogs = (catalogs, baseCatalogs) => {
  const normalized = {
    ...baseCatalogs,
    ...(catalogs || {}),
  };
  if (normalized.rolesOperativos) {
    Object.values(normalized.rolesOperativos).forEach((role) => {
      if (role?.nombre) role.nombre = neutralizeCompanyRole(role.nombre);
    });
  }
  if (normalized.rolesSistema) {
    if (normalized.rolesSistema.admin) normalized.rolesSistema.admin.nombre = "Administración";
    if (normalized.rolesSistema.encargada) normalized.rolesSistema.encargada.nombre = "Encargada";
    if (normalized.rolesSistema.supervisora) normalized.rolesSistema.supervisora.nombre = "Supervisión";
    if (normalized.rolesSistema.personal) normalized.rolesSistema.personal.nombre = "Personal operativo";
  }
  return normalized;
};
const normalizeRequest = (request) => {
  if (!request || typeof request !== "object") return request;
  const type = requestTypeLegacyMap[request.type] || request.type || "absence";
  const status = request.status === "pending"
    ? request.requiresPartner ? "pendingPartner" : "pendingManager"
    : ["review", "partnerAccepted"].includes(request.status) ? "pendingManager" : request.status || "pendingManager";
  return {
    ...request,
    type,
    status,
    partnerEmployeeId: request.partnerEmployeeId || "",
    partnerStatus: request.partnerStatus || (request.status === "partnerAccepted" ? "accepted" : request.partnerEmployeeId ? "pending" : ""),
    scheduleImpact: request.scheduleImpact || {},
  };
};
const freshState = () => ({
  stateRevision: 0,
  stateUpdatedAt: null,
  employees: structuredClone(employees),
  weeklySchedules: structuredClone(weeklySchedules),
  requests: structuredClone(initialRequests),
  notifications: structuredClone(initialNotifications),
  auditLogs: structuredClone(initialAudit),
  incidents: structuredClone(incidents),
  schedule: structuredClone(initialSchedule),
  draft: structuredClone(initialSchedule),
  planningWeek: null,
  referenceSchedule: structuredClone(referenceSchedule),
  catalogs: {
    rolesOperativos: structuredClone(rolesOperativos),
    rolesSistema: structuredClone(rolesSistema),
    sectores: structuredClone(sectores),
    turnos: structuredClone(turnos),
    pisos: structuredClone(pisos),
  },
  users: structuredClone(initialUsers),
  days: structuredClone(DAYS),
  scheduleVersion: 0,
  hasDraftChanges: false,
});

const mergeUsers = (...sources) => {
  const merged = new Map();
  sources.flat().filter(Boolean).forEach((item) => {
    if (!item || typeof item !== "object") return;
    const key = item.id || item.username;
    if (!key) return;
    merged.set(key, { ...(merged.get(key) || {}), ...item });
  });
  return [...merged.values()];
};

const normalizeState = (parsed) => {
  const baseState = freshState();
  const users = mergeUsers(baseState.users, Array.isArray(parsed.demoUsers) ? parsed.demoUsers : [], Array.isArray(parsed.users) ? parsed.users : []);
  return {
    ...baseState,
    ...parsed,
    stateRevision: Number.isInteger(parsed.stateRevision) ? parsed.stateRevision : 0,
    stateUpdatedAt: typeof parsed.stateUpdatedAt === "string" ? parsed.stateUpdatedAt : null,
    employees: Array.isArray(parsed.employees) ? parsed.employees.map(normalizeEmployee) : baseState.employees.map(normalizeEmployee),
    weeklySchedules: Array.isArray(parsed.weeklySchedules) ? parsed.weeklySchedules : baseState.weeklySchedules,
    requests: Array.isArray(parsed.requests) ? parsed.requests.map(normalizeRequest) : baseState.requests,
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : baseState.notifications,
    auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : baseState.auditLogs,
    incidents: Array.isArray(parsed.incidents) ? parsed.incidents : baseState.incidents,
    schedule: Array.isArray(parsed.schedule) ? parsed.schedule : baseState.schedule,
    draft: Array.isArray(parsed.draft) ? parsed.draft : baseState.draft,
    planningWeek: normalizePlanningWeek(parsed.planningWeek),
    referenceSchedule: baseState.referenceSchedule,
    catalogs: normalizeCatalogs(parsed.catalogs, baseState.catalogs),
    users,
    demoUsers: undefined,
    days: baseState.days,
    scheduleVersion: Array.isArray(parsed.schedule) && parsed.schedule.length
      ? Number(parsed.scheduleVersion) || 1
      : 0,
    hasDraftChanges: Boolean(parsed.hasDraftChanges),
  };
};

const removeCredentials = (state) => {
  (state.users || []).forEach((item) => {
    delete item.password;
    delete item.passwordHash;
  });
  return state;
};

export async function authenticate(username, password) {
  if (!canPersistStateFile()) throw new Error("Abrí la app desde server.py para iniciar sesión.");
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "No se pudo iniciar sesión.");
  return result.user;
}

export async function endSession() {
  if (canPersistStateFile()) await fetch("/api/auth/logout", { method: "POST" });
}

async function loadStateFromApi(options = {}) {
  if (!options.remote || !window.location.protocol.startsWith("http")) return null;
  const response = await fetch(API_STATE_URL, { cache: "no-store" });
  if (response.status === 404) return null;
  if (response.status === 401) {
    const error = new Error("La sesión venció. Volvé a iniciar sesión.");
    error.code = "authenticationRequired";
    throw error;
  }
  if (!response.ok) throw new Error("No se pudo cargar la base JSON.");
  return removeCredentials(normalizeState(await response.json()));
}

export async function loadState(options = { remote: true }) {
  try {
    const apiState = await loadStateFromApi(options);
    if (apiState) {
      localStorage.setItem(KEY, JSON.stringify(apiState));
      return removeCredentials(apiState);
    }
    const saved = localStorage.getItem(KEY);
    if (!saved) return freshState();
    const parsed = JSON.parse(saved);
    return normalizeState(parsed);
  } catch {
    if (options.requireAuth) throw new Error("La sesión venció. Volvé a iniciar sesión.");
    try {
      const saved = localStorage.getItem(KEY);
      return saved ? normalizeState(JSON.parse(saved)) : freshState();
    } catch {
      return freshState();
    }
  }
}

async function persistState(state, options = {}) {
  const users = mergeUsers(Array.isArray(state.demoUsers) ? state.demoUsers : [], Array.isArray(state.users) ? state.users : []);
  state.users = users;
  state.employees = Array.isArray(state.employees) ? state.employees.map(normalizeEmployee) : freshState().employees;
  delete state.demoUsers;
  if (!canPersistStateFile()) {
    removeCredentials(state);
    localStorage.setItem(KEY, JSON.stringify(state));
    if (options.requireFile) {
      throw new Error(`Para guardar en ${STATE_FILE_NAME}, abrí la app desde server.py y no como archivo local.`);
    }
    return { local: true, file: false };
  }
  try {
    const response = await fetch(API_STATE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (response.status === 409) {
      const details = await response.json();
      const conflict = new Error("Otra pestaña guardó cambios más nuevos. Recargá la aplicación antes de continuar.");
      conflict.code = "stateConflict";
      conflict.currentRevision = details.currentRevision;
      throw conflict;
    }
    if (!response.ok) throw new Error(`No se pudo escribir ${STATE_FILE_NAME}.`);
    const result = await response.json();
    state.stateRevision = result.stateRevision;
    state.stateUpdatedAt = result.stateUpdatedAt;
    removeCredentials(state);
    localStorage.setItem(KEY, JSON.stringify(state));
    return { local: true, file: true, stateRevision: result.stateRevision };
  } catch (error) {
    if (error.code === "stateConflict" || options.requireFile) throw error;
    removeCredentials(state);
    localStorage.setItem(KEY, JSON.stringify(state));
    return { local: true, file: false, error };
  }
}

export function saveState(state, options = {}) {
  const operation = () => persistState(state, options);
  const queued = saveQueue.then(operation, operation);
  saveQueue = queued.catch(() => undefined);
  return queued;
}

export function serializeState(state) {
  return JSON.stringify({
    schemaVersion: 1,
    app: "uzumaki",
    exportedAt: new Date().toISOString(),
    data: state,
  }, null, 2);
}

export function hydrateStateFromJson(text) {
  const parsed = JSON.parse(text);
  const payload = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  return normalizeState(payload);
}

export function resetState(stateRevision = 0) {
  localStorage.removeItem(KEY);
  LEGACY_KEYS.forEach((key) => localStorage.removeItem(key));
  const state = freshState();
  state.stateRevision = stateRevision;
  saveState(state);
  return state;
}
