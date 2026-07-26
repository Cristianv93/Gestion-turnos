import { clearCachedState, hydrateStateFromJson, loadState, resetState, saveState, serializeState, STATE_FILE_NAME, STATE_STORAGE_LABEL } from "./services/store.js?v=20260726-05";
import { authenticate, endSession, requestApi } from "./services/api.js?v=20260726-01";
import { showToast } from "./ui/feedback.js?v=20260726-01";
import { closeModal as closeModalUi, openModal } from "./ui/modal.js?v=20260726-01";
import { canEditApplications, canEditSchedule, canManageEmployees, canResolveRequests, canSeeAudit, isAdminRole, roleLabel } from "./services/permissions.js?v=20260712-3";
import { createDraftPlanningWeek, ensureKitchenPlanningSlots } from "./services/planningWeeks.js?v=20260716-1";
import { applyApprovedAbsenceOrLeave, applyApprovedShiftChange, applyGustavoJulioException, buildDailyDaysOffSummary, buildWeeklyAvailabilityMap, generateFloorCoverageAssignments, generateHabitualAssignments, generateKitchenMorningCollaborationAssignments } from "./services/planningEngine.js?v=20260717-6";

const SESSION_KEY = "uzumaki-user-v5";
let user = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
let state;
try {
  state = user?.mustChangePassword
    ? await loadState({ remote: false })
    : await loadState({ remote: Boolean(user), requireAuth: Boolean(user) });
} catch {
  user = null;
  sessionStorage.removeItem(SESSION_KEY);
  state = await loadState({ remote: false });
}
if (user && !user.mustChangePassword && !state.users.some((item) => item.id === user.id || item.username === user.username)) {
  user = null;
  sessionStorage.removeItem(SESSION_KEY);
}
let page = "dashboard";
let scheduleMode = "official";
let planningView = "library";
let planningDateIndex = 0;
let selectedPlanningWeekIds = new Set();
let sidebarCollapsed = sessionStorage.getItem("uzumaki-sidebar-collapsed") === "true";
let employeeSearch = "";
let requestFilter = "all";
let planningFocusedEmployeeId = null;

const icons = {
  dashboard: "▦", schedule: "▤", employees: "♙", requests: "↔", notifications: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>', audit: "◷", logout: "↪", plus: "+", menu: "☰",
};
const statusText = {
  pending: "Pendiente",
  pendingPartner: "Pendiente de compañero",
  partnerAccepted: "Aceptada por compañero",
  partnerRejected: "Rechazada por compañero",
  pendingManager: "Pendiente de encargada",
  review: "En revisión",
  approved: "Aprobada",
  rejected: "Rechazada",
  revoked: "Revocada",
  active: "Activo",
  inactive: "Inactivo",
};
const shiftState = { working: "Trabaja", sick: "Enfermo", leave: "Licencia", off: "Franco" };
const requestTypes = {
  absence: "Ausencia",
  leave: "Licencia",
  dayOffChange: "Cambio de franco",
  shiftChange: "Cambio de turno",
};
const requestTypeLegacyMap = {
  "Parte de enfermo": "absence",
  Ausencia: "absence",
  Licencia: "leave",
  Vacaciones: "leave",
  "Cambio de franco": "dayOffChange",
  "Cambio de turno": "shiftChange",
};
const shiftOptions = ["Mañana", "Tarde"];
const companyRoleOptions = [
  "Personal de camarería",
  "Personal de cocina",
  "Ayudante de cocina",
  "Personal franquero",
  "Encargada/Nutrición",
  "Supervisión",
];
const operationalCompanyRoles = ["Personal de camarería", "Personal de cocina", "Ayudante de cocina", "Personal franquero"];
const activeRequestStatuses = ["pending", "pendingPartner", "pendingManager", "review"];
const exceptionTypes = {
  leave: "Licencia",
  studyLeave: "Licencia por estudio",
  absence: "Ausencia",
  dayOffChange: "Cambio de franco",
  doubleShift: "Doble turno",
  replacement: "Reemplazo",
  uncovered: "Turno o puesto sin cubrir",
};

function toast(message, tone = "success") {
  showToast(toastRegion, message, tone);
}

function audit(action, entity, result) {
  state.auditLogs.unshift({ id: crypto.randomUUID(), time: "Ahora", user: user.name, action, entity, result });
}

async function persist(options = {}) {
  try {
    return await saveState(state, options);
  } catch (error) {
    if (options.requireFile) throw error;
    toast(error.code === "stateConflict" ? error.message : "No se pudieron guardar los cambios.", "error");
    return { local: false, file: false, error };
  } finally {
    render();
  }
}

function applyApiFragment(result) {
  if (!result || typeof result !== "object") return;
  if (result.week) {
    state.planningWeek = result.week;
    const index = (state.weeklySchedules || []).findIndex((week) => week.id === result.week.id);
    if (index >= 0) state.weeklySchedules[index] = result.week;
    else state.weeklySchedules = [result.week, ...(state.weeklySchedules || [])];
  }
  if (result.deletedWeekId) {
    state.weeklySchedules = (state.weeklySchedules || []).filter((week) => week.id !== result.deletedWeekId);
    if (state.planningWeek?.id === result.deletedWeekId) state.planningWeek = null;
  }
  if (result.request) {
    const index = (state.requests || []).findIndex((request) => request.id === result.request.id);
    if (index >= 0) state.requests[index] = result.request;
    else state.requests = [result.request, ...(state.requests || [])];
  }
  if (Array.isArray(result.notifications)) state.notifications = result.notifications;
  if (Array.isArray(result.employees)) state.employees = result.employees;
  if (Array.isArray(result.users)) state.users = result.users;
  if (result.catalogs) state.catalogs = result.catalogs;
}

// Los cambios operativos se envían como comandos pequeños. El backend valida
// y responde con el recurso actualizado; nunca se vuelve a descargar el
// estado completo después de una acción.
async function apiCommand(path, payload = null, method = "POST", extraHeaders = {}, reloadState = true) {
  const result = await requestApi(path, {
    method,
    payload: payload === null ? undefined : payload,
    headers: extraHeaders,
  });
  if (reloadState) {
    applyApiFragment(result);
    render();
  }
  return result;
}

function persistenceActions() {
  return "";
}

function render() {
  if (!user) return renderLogin();
  // El resumen operativo tiene una grilla compacta de tres filas. El perfil del
  // operario contiene más bloques y debe conservar su flujo vertical natural.
  const contentClass = page === "dashboard" && isAdminRole(user.role) ? "content dashboard-content" : "content";
  app.innerHTML = `<div class="app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}">
    ${sidebar()}
    <div class="workspace">
      ${topbar()}
      <main class="${contentClass}" id="content">${renderPage()}</main>
    </div>
  </div>`;
}

function renderLogin(error = "", username = "") {
  app.innerHTML = `<main class="login-page">
    <section class="login-brand">
      <div class="login-brand-header"><span class="brand-mark large"><img src="./assets/ICONO.webp" alt="" /></span><div><strong>UZUMAKI</strong><small>Gestión operativa</small></div></div>
    </section>
    <section class="login-panel">
      <form class="login-card" id="login-form">
        <div class="mobile-logo"><span class="brand-mark"><img src="./assets/ICONO.webp" alt="" /></span><div><strong>Uzumaki</strong><small>Gestión operativa</small></div></div>
        <span class="eyebrow">BIENVENIDOS</span>
        <h2>Ingresá a tu espacio</h2>
        ${error ? `<div class="form-error">${escapeHtml(error)}</div>` : ""}
        <label>Usuario<input name="username" value="${escapeHtml(username)}" autocomplete="username" required autofocus /></label>
        <label>Contraseña<div class="password-field"><input name="password" type="password" autocomplete="current-password" required /><button type="button" class="text-button" data-action="toggle-password">Ver</button></div></label>
        <button class="button primary wide" type="submit">Ingresar <span>→</span></button>
      </form>
    </section>
  </main>`;
}

function sidebar() {
  const admin = isAdminRole(user.role);
  const items = admin
    ? [["dashboard", "Resumen"], ["schedule", "Grilla operativa"], ["employees", "Personal"], ["requests", "Solicitudes"], ["notifications", "Notificaciones"], ...(canSeeAudit(user.role) ? [["audit", "Auditoría"]] : [])]
    : [["dashboard", "Mi resumen"], ["schedule", "Mi semana"], ["requests", "Mis solicitudes"], ["notifications", "Notificaciones"]];
  return `<aside class="sidebar ${sidebarCollapsed ? "collapsed" : ""}" id="sidebar" aria-label="Navegación principal">
    <button class="brand" type="button" data-action="toggle-sidebar" aria-label="${sidebarCollapsed ? "Expandir menú" : "Contraer menú"}" title="${sidebarCollapsed ? "Expandir menú" : "Contraer menú"}"><span class="brand-mark"><img src="./assets/ICONO.webp" alt="" /></span><div><strong>Uzumaki</strong><small>Gestión operativa</small></div></button>
    <nav>${items.map(([id, label]) => `<button class="nav-item ${page === id ? "active" : ""}" data-page="${id}" aria-label="${escapeHtml(label)}" ${page === id ? 'aria-current="page"' : ""} title="${escapeHtml(label)}"><span class="nav-icon">${icons[id]}</span><span class="nav-label">${escapeHtml(label)}</span>${id === "notifications" && unreadCount() ? `<b>${unreadCount()}</b>` : ""}</button>`).join("")}</nav>
    <button class="sidebar-foot user-session" type="button" data-action="confirm-logout" aria-label="Abrir opciones de sesión de ${escapeHtml(user.name)}"><span class="mini-avatar">${initials(user.name)}</span><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(roleLabel[user.role])}</small></span><span class="session-exit" aria-hidden="true">${icons.logout}</span></button>
  </aside>`;
}

function topbar() {
  const titles = { dashboard: isAdminRole(user.role) ? "Resumen operativo" : `Hola, ${user.name.split(" ")[0]}`, schedule: isAdminRole(user.role) ? "Grilla operativa" : "Mi semana", employees: "Personal", requests: isAdminRole(user.role) ? "Solicitudes" : "Mis solicitudes", notifications: "Notificaciones", audit: "Auditoría" };
  const weekLabel = state.planningWeek ? `${formatIsoDate(state.planningWeek.startDate)} — ${formatIsoDate(state.planningWeek.endDate)}` : "Semana sin crear";
  return `<header class="topbar"><button class="mobile-menu" data-action="menu" aria-label="Abrir menú de navegación">${icons.menu}</button><div><span class="crumb">Uzumaki /</span><strong>${titles[page]}</strong></div><div class="top-actions"><button class="icon-button" data-page="notifications" aria-label="Notificaciones">${icons.notifications}${unreadCount() ? `<b>${unreadCount()}</b>` : ""}</button><span class="date-pill">${weekLabel}</span></div></header>`;
}

function renderPage() {
  const pages = { dashboard: dashboardPage, schedule: schedulePage, employees: employeesPage, requests: requestsPage, notifications: notificationsPage, audit: auditPage };
  return (pages[page] || dashboardPage)();
}

function pageHeading(kicker, title, description, action = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(kicker)}</span><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div>${action}</div>`;
}

function dashboardPage() {
  if (!isAdminRole(user.role)) return staffDashboard();
  const active = state.employees.filter((e) => e.status === "active" && e.participaEnOperacion !== false).length;
  const pending = state.requests.filter((r) => activeRequestStatuses.includes(r.status)).length;
  const snapshot = operationalSnapshot();
  const critical = snapshot.rows.filter((row) => row.missing).length;
  return `${pageHeading(snapshot.label, `Buen día, ${user.name.split(" ")[0]}`, "", `<button class="button primary" data-page="schedule">Abrir grilla <span>→</span></button>`)}
    <section class="metric-grid">
      ${metric("Dotación operativa", `${snapshot.assigned}/${snapshot.total}`, critical ? `${critical} sin cubrir` : "Cobertura completa", critical ? "rose" : "sun", "♙")}
      ${metric("Cobertura", `${snapshot.coverage}%`, snapshot.coverage === 100 ? "Todos los puestos confirmados" : "Revisá puestos pendientes", snapshot.coverage === 100 ? "blue" : "amber", "▤")}
      ${metric("Solicitudes activas", pending, pending ? "Requieren atención" : "Todo al día", "amber", "↔")}
      ${metric("Personal operativo", active, `${state.employees.length} personas registradas`, "sun", "◉")}
    </section>
    <section class="dashboard-grid operational-dashboard"><article class="panel coverage-panel"><div class="panel-head"><div><span class="eyebrow">COBERTURA POR SECTOR</span><h2>Estado de los próximos turnos</h2><p class="muted">La lectura se ordena por impacto operativo.</p></div><button class="button secondary" data-page="schedule">Ver grilla</button></div><div class="coverage-list">${snapshot.rows.map((row) => `<div class="coverage-row"><div><strong>${row.label}</strong><small>${row.assigned}/${row.total} puestos asignados</small></div><div class="coverage-track"><span class="${row.missing ? "risk" : row.coverage < 100 ? "warning" : ""}" style="width:${row.coverage}%"></span></div><span class="coverage-state ${row.missing ? "risk" : row.coverage < 100 ? "warning" : "ok"}">${row.missing ? "Sin cubrir" : row.coverage < 100 ? "Pendiente" : "Completo"}</span></div>`).join("")}</div></article><article class="panel decision-panel"><div class="panel-head"><div><span class="eyebrow">BANDEJA DE DECISIONES</span><h2>Para atender</h2></div><button class="text-link" data-page="requests">Ver todo</button></div><div class="decision-list">${dashboardDecisions(snapshot).join("")}</div></article></section>`;
}

function operationalSnapshot() {
  const week = state.planningWeek;
  const dates = [...new Set((week?.operationalPositions || []).map((position) => position.date))].sort();
  const date = dates.find((item) => item >= localIsoDate()) || dates[0];
  const positions = (week?.operationalPositions || []).filter((position) => position.date === date && !isOptionalPlanningPosition(position));
  const assignments = new Set((week?.assignments || []).map((assignment) => assignment.positionId));
  const groups = [["Cocina", "Mañana"], ["Cocina", "Tarde"], ["Pisos", "Mañana"], ["Pisos", "Tarde"]];
  const rows = groups.map(([sector, shift]) => {
    const targets = positions.filter((position) => position.sector === sector && position.shift === shift);
    const assigned = targets.filter((position) => assignments.has(position.id)).length;
    const total = targets.length;
    return { label: `${sector} · ${shift}`, assigned, total, missing: Math.max(0, total - assigned), coverage: total ? Math.round((assigned / total) * 100) : 100 };
  }).filter((row) => row.total);
  const assigned = rows.reduce((total, row) => total + row.assigned, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return { rows, assigned, total, coverage: total ? Math.round((assigned / total) * 100) : 0, label: date ? `OPERACIÓN · ${formatIsoDate(date).toUpperCase()}` : "OPERACIÓN" };
}

function dashboardDecisions(snapshot) {
  const decisions = snapshot.rows.filter((row) => row.missing).map((row) => ({ icon: "!", title: `Asignar cobertura para ${row.label}`, detail: `${row.missing} ${row.missing === 1 ? "puesto pendiente" : "puestos pendientes"}`, page: "schedule", tone: "risk" }));
  state.requests.filter((request) => activeRequestStatuses.includes(request.status)).slice(0, 3).forEach((request) => decisions.push({ icon: "↔", title: `${requestTypes[normalizeRequestForView(request).type]} de ${requestEmployeeName(request.employeeId)}`, detail: statusText[normalizeRequestForView(request).status], page: "requests", tone: "warning" }));
  return (decisions.length ? decisions : [{ icon: "✓", title: "Operación al día", detail: "No hay acciones pendientes", page: "schedule", tone: "ok" }]).slice(0, 4).map((item) => `<button class="decision-item ${item.tone}" data-page="${item.page}"><span>${item.icon}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div><b>›</b></button>`);
}

function staffDashboard() {
  const employee = state.employees.find((item) => item.id === user.employeeId);
  const publishedWeek = state.planningWeek?.status === "published" ? state.planningWeek : null;
  const myAssignments = publishedWeek && employee ? employeeWeekAssignments(publishedWeek, employee.id) : [];
  const myDaysOff = publishedWeek && employee ? employeeWeekDaysOff(publishedWeek, employee.id) : [];
  const next = myAssignments[0];
  const ownRequests = state.requests.filter((r) => r.employeeId === user.employeeId);
  if (!employee) {
    return `${pageHeading("MI PERFIL", "Información operativa", "Tu usuario no está vinculado a un empleado operativo.")}
      <section class="panel">${empty("No encontramos información operativa para este usuario")}</section>`;
  }
  const planningButton = publishedWeek
    ? `<button class="button primary staff-grid-pulse" data-page="schedule">Ver mi grilla semanal</button>`
    : `<button class="button secondary" disabled>Sin grilla publicada</button>`;
  return `${pageHeading("MI PERFIL", `Hola, ${employee.name}`, "Esta es tu información operativa visible en Uzumaki.", planningButton)}
    <section class="staff-profile-hero">
      <div class="staff-profile-avatar">${employee.initials}</div>
      <div><span class="eyebrow light">PERSONAL OPERATIVO</span><h2>${employee.name}</h2><p>${employee.role} · ${employee.sector || "Sin sector"} · ${employee.turno || "Turno flexible"}</p></div>
      <div class="staff-profile-status"><strong>${next ? formatIsoDate(next.date) : "—"}</strong><small>Próxima asignación</small></div>
    </section>
    <section class="metric-grid staff-metrics">${metric("Asignaciones publicadas", myAssignments.length, publishedWeek ? publishedWeek.name : "Sin grilla publicada", "sun", "▤")}${metric("Francos publicados", myDaysOff.length, "Semana publicada", "amber", "○")}${metric("Solicitudes activas", ownRequests.filter((r) => activeRequestStatuses.includes(r.status)).length, "Seguimiento personal", "blue", "↔")}</section>
    <section class="staff-profile-grid">
      <article class="panel"><div class="panel-head"><div><span class="eyebrow">DATOS OPERATIVOS</span><h2>Mi puesto habitual</h2></div></div>
        <div class="staff-info-list">
          <span><small>Rol operativo</small><strong>${employee.role}</strong></span>
          <span><small>Turno habitual</small><strong>${employee.turno || "Flexible"}</strong></span>
          <span><small>Sector principal</small><strong>${employee.sector || "No operativo"}</strong></span>
          <span><small>Ubicación</small><strong>${employee.piso ? `Piso ${employee.piso}` : employee.role === "Personal franquero" ? "Cobertura flexible" : "Sin piso fijo"}</strong></span>
        </div>
      </article>
      <article class="panel"><div class="panel-head"><div><span class="eyebrow">GRILLA PUBLICADA</span><h2>Próximas asignaciones</h2></div></div>
        ${publishedWeek ? myAssignments.map(staffAssignmentCard).join("") || empty("No tenés asignaciones en la grilla publicada") : empty("No hay grilla publicada disponible")}
      </article>
      <article class="panel"><div class="panel-head"><div><span class="eyebrow">FRANCOS</span><h2>Semana publicada</h2></div></div>
        ${publishedWeek ? myDaysOff.map(staffDayOffCard).join("") || empty("No tenés francos cargados en la semana publicada") : empty("No hay grilla publicada disponible")}
      </article>
    </section>`;
}

function employeeWeekAssignments(week, employeeId) {
  return (week.assignments || [])
    .filter((assignment) => assignment.employeeId === employeeId)
    .map((assignment) => {
      const position = week.operationalPositions.find((item) => item.id === assignment.positionId);
      return position ? { ...position, assignmentId: assignment.id } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

function employeeWeekDaysOff(week, employeeId) {
  return (week.daysOff || [])
    .filter((dayOff) => dayOff.employeeId === employeeId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function staffAssignmentCard(position) {
  const location = position.floor ? `Piso ${position.floor}` : position.sector;
  return `<div class="staff-week-item"><div class="day-box">${formatIsoDate(position.date).slice(0, 5)}</div><div><strong>${position.label}</strong><small>${position.sector} · Turno ${position.shift} · ${location}</small></div><span class="badge working">Asignado</span></div>`;
}

function staffDayOffCard(dayOff) {
  return `<div class="staff-week-item"><div class="day-box">${formatIsoDate(dayOff.date).slice(0, 5)}</div><div><strong>Franco ${dayOff.tipo}</strong><small>${dayOff.sector}</small></div><span class="badge active">Franco</span></div>`;
}

function metric(label, value, meta, color, icon) {
  return `<article class="metric-card"><div class="metric-icon ${color}">${icon}</div><div><span>${label}</span><strong>${value}</strong><small>${meta}</small></div></article>`;
}

function normalizeRequestForView(request) {
  const type = requestTypes[request.type] ? request.type : requestTypeLegacyMap[request.type] || "absence";
  const legacyStatus = request.status === "pending"
    ? request.requiresPartner ? "pendingPartner" : "pendingManager"
    : ["review", "partnerAccepted"].includes(request.status) ? "pendingManager" : request.status || "pendingManager";
  const employee = request.employee || state.employees.find((item) => item.id === request.employeeId)?.name || "Sin solicitante";
  return {
    ...request,
    type,
    status: statusText[legacyStatus] ? legacyStatus : "pendingManager",
    employee,
    detail: request.detail || request.note || "",
    note: request.note || request.detail || "",
    scheduleImpact: request.scheduleImpact || {},
  };
}

function requestMetaItems(request) {
  const impact = request.scheduleImpact || {};
  const partner = state.employees.find((employee) => employee.id === request.partnerEmployeeId);
  if (["absence", "leave"].includes(request.type)) {
    return [
      ["Fecha", impact.target?.date ? formatIsoDate(impact.target.date) : "Sin fecha"],
      ["Turno", impact.target?.shift || "Sin turno"],
      ["Detalle", request.detail],
    ];
  }
  return [
    ["Origen", impact.original?.date ? `${formatIsoDate(impact.original.date)} · ${impact.original.shift}` : "Sin origen"],
    ["Propuesto", impact.proposed?.date ? `${formatIsoDate(impact.proposed.date)} · ${impact.proposed.shift}` : "Sin propuesta"],
    ["Compañero", partner?.name || "Sin compañero"],
  ];
}

function requestEmployeeName(employeeId, fallback = "Sin persona") {
  return state.employees.find((employee) => employee.id === employeeId)?.name || fallback;
}

function requestAssignmentsByDateShift(employeeId, date, shift) {
  const week = state.planningWeek;
  if (!week || !date || !shift || !employeeId) return [];
  return (week.assignments || [])
    .map((assignment) => ({
      assignment,
      position: week.operationalPositions.find((position) => position.id === assignment.positionId),
    }))
    .filter(({ assignment, position }) => assignment.employeeId === employeeId && position?.date === date && position?.shift === shift);
}

function requestImpactRows(rows) {
  return `<div class="request-impact-grid">${rows.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join("")}</div>`;
}

function requestCoverSelector(request) {
  if (!canEditApplications(user.role) || request.status !== "pendingManager" || !["absence", "leave"].includes(request.type)) return "";
  const options = state.employees
    .filter((employee) => employee.status === "active" && employee.participaEnOperacion !== false && employee.id !== request.employeeId)
    .map((employee) => `<option value="${employee.id}">${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`)
    .join("");
  return `<label class="request-cover-selector">Quién cubre el puesto<select name="coverEmployeeId" data-request-cover="${request.id}" required><option value="">Seleccionar reemplazo</option>${options}</select></label>`;
}

function insufficientImpactPreview() {
  return `<p class="request-impact-empty">No hay información suficiente para calcular el impacto</p>`;
}

function requestImpactPreview(request) {
  if (!canEditApplications(user.role) || request.status !== "pendingManager") return "";
  const impact = request.scheduleImpact || {};
  let content = "";
  if (["absence", "leave"].includes(request.type)) {
    const target = impact.target || {};
    if (!target.date || !target.shift || !request.employeeId || !state.planningWeek) content = insufficientImpactPreview();
    else {
      const assignments = requestAssignmentsByDateShift(request.employeeId, target.date, target.shift);
      const positions = assignments.map(({ position }) => position.label).join(", ");
      content = requestImpactRows([
        ["Fecha", formatIsoDate(target.date)],
        ["Turno", target.shift],
        ["Persona afectada", request.employee],
        ["Puesto", positions || "No se encontró puesto asignado en la grilla"],
        ["Impacto", `${request.employee} quedaría ausente`],
        ["Cobertura", assignments.length ? "Requiere reemplazo para no dejar el turno sin cubrir" : "El turno quedaría sin cubrir o requiere revisión manual"],
      ]);
    }
  } else if (request.type === "dayOffChange") {
    const original = impact.original || {};
    const proposed = impact.proposed || {};
    if (!original.date || !original.shift || !proposed.date || !proposed.shift || !request.partnerEmployeeId) content = insufficientImpactPreview();
    else {
      content = requestImpactRows([
        ["Fecha/turno original", `${formatIsoDate(original.date)} · ${original.shift}`],
        ["Fecha/turno propuesto", `${formatIsoDate(proposed.date)} · ${proposed.shift}`],
        ["Persona que cambia", request.employee],
        ["Compañero involucrado", requestEmployeeName(request.partnerEmployeeId)],
        ["Impacto esperado", `${request.employee} intercambiaría el franco con ${requestEmployeeName(request.partnerEmployeeId)}`],
      ]);
    }
  } else if (request.type === "shiftChange") {
    const original = impact.original || {};
    const proposed = impact.proposed || {};
    if (!original.date || !original.shift || !proposed.date || !proposed.shift || !request.partnerEmployeeId || !state.planningWeek) content = insufficientImpactPreview();
    else {
      const requesterAssignments = requestAssignmentsByDateShift(request.employeeId, original.date, original.shift);
      const partnerAssignments = requestAssignmentsByDateShift(request.partnerEmployeeId, proposed.date, proposed.shift);
      content = requestImpactRows([
        ["Turno actual", `${formatIsoDate(original.date)} · ${original.shift}${requesterAssignments[0]?.position ? ` · ${requesterAssignments[0].position.label}` : ""}`],
        ["Turno propuesto", `${formatIsoDate(proposed.date)} · ${proposed.shift}${partnerAssignments[0]?.position ? ` · ${partnerAssignments[0].position.label}` : ""}`],
        ["Solicitante", request.employee],
        ["Compañero involucrado", requestEmployeeName(request.partnerEmployeeId)],
        ["Intercambio esperado", `${request.employee} tomaría el turno de ${requestEmployeeName(request.partnerEmployeeId)} y viceversa`],
      ]);
    }
  } else {
    content = insufficientImpactPreview();
  }
  return `<section class="request-impact-preview"><div><span class="eyebrow">SIMULACIÓN</span><h3>Vista previa del impacto</h3></div>${content}${requestCoverSelector(request)}</section>`;
}

function canViewRequestDetail(request) {
  return isAdminRole(user.role) || request.employeeId === user.employeeId || request.partnerEmployeeId === user.employeeId;
}

function requestMatchesFilter(request, filter) {
  if (filter === "all") return true;
  if (filter === "active") return activeRequestStatuses.includes(request.status);
  if (filter === "waitingResponse") return request.status === "pendingPartner";
  if (filter === "rejected") return ["rejected", "partnerRejected"].includes(request.status);
  if (filter === "history") return ["approved", "rejected", "partnerRejected", "revoked"].includes(request.status);
  return request.status === filter;
}

function canActAsPartner(request) {
  return !isAdminRole(user.role)
    && request.partnerEmployeeId === user.employeeId
    && request.status === "pendingPartner";
}

function canManagerResolveRequest(request) {
  return canResolveRequests(user.role) && request.status === "pendingManager";
}

function canRevokeRequest(request) {
  return canResolveRequests(user.role) && request.status === "approved" && Boolean(request.planningApplication);
}

function planningWeekStatusLabel(status) {
  return { draft: "Borrador", published: "Publicada", paused: "Pausada / No publicada" }[status] || "Sin estado";
}

function planningWeekStatusClass(status) {
  return { draft: "week-draft", published: "week-published", paused: "week-paused" }[status] || "week-draft";
}

function planningWeekStatusIcon(status) {
  return { draft: "✎", published: "✓", paused: "Ⅱ" }[status] || "✎";
}

function planningWeekLifecycleActions(week) {
  // La propuesta automática y el guardado integral se migrarán al backend.
  // Se ocultan mientras PostgreSQL es la única fuente de escritura.
  const saveButton = "";
  const suggestButton = "";
  const exceptionButton = `<button class="button secondary planning-exception-action" data-action="new-week-exception">Excepción</button>`;
  const publishButton = `<button class="button primary planning-publish-action" data-action="publish-planning-week">${week.status === "paused" ? "Republicar" : "Publicar"}</button>`;
  const deleteButton = `<button class="button danger-soft planning-icon-action planning-delete-action" data-action="delete-planning-week" aria-label="Eliminar grilla" title="Eliminar grilla"><span aria-hidden="true">🗑</span></button>`;
  const moreActions = (items) => `<details class="planning-more-actions"><summary aria-label="Más acciones" title="Más acciones"><span aria-hidden="true">⋯</span></summary><div>${items}</div></details>`;
  const commonActions = `${suggestButton}${saveButton}${exceptionButton}`;
  if (week.status === "published") {
    return `<div class="heading-actions planning-compact-actions">${commonActions}${moreActions(`<button data-action="pause-planning-week">Pausar publicación</button><button data-action="draft-planning-week">Volver a borrador</button>`)}${deleteButton}</div>`;
  }
  if (week.status === "paused") {
    return `<div class="heading-actions planning-compact-actions">${commonActions}${publishButton}${moreActions(`<button data-action="draft-planning-week">Volver a borrador</button>`)}${deleteButton}</div>`;
  }
  return `<div class="heading-actions planning-compact-actions">${commonActions}${publishButton}${deleteButton}</div>`;
}

function planningCompactHeading(week, statusLabel, actions) {
  return `<header class="planning-compact-heading">
    <button class="planning-compact-back" data-action="open-planning-library" aria-label="Volver a grillas almacenadas" title="Volver a grillas almacenadas"><span aria-hidden="true">←</span></button>
    <div class="planning-compact-title"><span class="eyebrow">PLANIFICACIÓN SEMANAL</span><div><h1>${escapeHtml(week.name)}</h1><span class="week-status ${week.status}">${statusLabel}</span></div><p>${formatIsoDate(week.startDate)} — ${formatIsoDate(week.endDate)}</p></div>
    ${actions}
  </header>`;
}

function schedulePage() {
  if (canEditSchedule(user.role) && planningView === "library") return planningLibraryPage();
  if (state.planningWeek) return planningWeekPage();
  if (!state.schedule.length) return planningWeekPage();
  const canEdit = canEditSchedule(user.role);
  const mine = !isAdminRole(user.role);
  const source = scheduleMode === "draft" && canEdit ? state.draft : state.schedule;
  const visibleDays = state.days;
  const rows = mine ? source.filter((s) => s.employeeId === user.employeeId) : source;
  const action = canEdit ? `<div class="heading-actions"><button class="button secondary" data-action="toggle-schedule">${scheduleMode === "official" ? "Ver borrador" : "Ver oficial"}</button>${scheduleMode === "draft" ? `<button class="button primary" data-action="publish" ${state.hasDraftChanges ? "" : "disabled"}>Publicar cambios</button>` : ""}</div>` : "";
  const scheduleDescription = state.scheduleVersion === 0
    ? mine ? "Todavía no hay una grilla publicada." : "Borrador inicial · Todavía no existe una versión publicada."
    : mine ? "Tu planificación oficial del 1 al 7 de diciembre de 2025." : `Versión ${state.scheduleVersion} publicada`;
  return `${pageHeading("SEMANA 49 · 1 AL 7 DE DICIEMBRE DE 2025", mine ? "Mi semana" : "Grilla operativa", scheduleDescription, action)}
    ${scheduleMode === "draft" && canEdit ? `<div class="notice"><span>✎</span><div><strong>Estás viendo el borrador</strong><p>Hacé clic en un turno para cambiar su estado. El personal no verá estos cambios hasta publicar.</p></div>${state.hasDraftChanges ? `<b>Cambios sin publicar</b>` : ""}</div>` : ""}
    <section class="schedule-board">${visibleDays.map((day) => {
      const shifts = rows.filter((s) => s.day === day);
      return `<article class="day-column"><header><span>${day.split(" ")[0]}</span><strong>${day.split(" ")[1]}</strong><small>${shifts.length} asignados</small></header><div>${shifts.map((s) => shiftCard(s, scheduleMode === "draft" && canEdit)).join("") || `<div class="no-shift">Franco<br /><small>Sin asignación</small></div>`}</div></article>`;
    }).join("")}</section>
    ${!mine ? `<div class="legend"><span><i class="working"></i> Trabaja</span><span><i class="sick"></i> Parte de enfermo</span><span><i class="leave"></i> Licencia</span><span><i class="off"></i> Franco</span></div>` : ""}`;
}

function planningSnapshots() {
  return (state.weeklySchedules || [])
    .filter((week) => week && typeof week === "object" && week.id)
    .sort((a, b) => (b.savedAt || b.updatedAt || b.startDate || "").localeCompare(a.savedAt || a.updatedAt || a.startDate || ""));
}

function planningWeekHasUnsavedChanges(week) {
  const stored = (state.weeklySchedules || []).find((item) => item.id === week?.id);
  if (!week || !stored) return Boolean(week);
  // El bootstrap conserva el historial como resúmenes. Un resumen no puede
  // usarse para decidir si la grilla abierta fue modificada localmente.
  if (!Array.isArray(stored.operationalPositions)) return false;
  return JSON.stringify(week) !== JSON.stringify(stored);
}

function planningLibraryPage() {
  const canCreate = canEditSchedule(user.role);
  const weeks = planningSnapshots();
  const storedWeekIds = new Set(weeks.map((week) => week.id));
  selectedPlanningWeekIds = new Set([...selectedPlanningWeekIds].filter((id) => storedWeekIds.has(id)));
  const selectedCount = selectedPlanningWeekIds.size;
  return `${pageHeading("PLANIFICACIÓN SEMANAL", "Grillas almacenadas", "Consultá semanas anteriores, retomá un borrador o creá una nueva planificación.", canCreate ? `<button class="button primary" data-action="new-planning-week">${icons.plus} Nueva grilla</button>` : "")}
    <section class="planning-library" aria-label="Grillas guardadas">
      <div class="planning-library-head"><div><span class="eyebrow">HISTORIAL</span><h2>${weeks.length ? `${weeks.length} grillas guardadas` : "Todavía no hay grillas guardadas"}</h2></div><span class="planning-library-file">${STATE_STORAGE_LABEL}</span></div>
      ${selectedCount ? `<div class="planning-library-selection"><span><b>${selectedCount}</b> ${selectedCount === 1 ? "grilla seleccionada" : "grillas seleccionadas"}</span><div><button class="button secondary" data-action="clear-planning-week-selection">Limpiar</button><button class="button danger-soft" data-action="delete-selected-planning-weeks">Eliminar seleccionadas</button></div></div>` : ""}
      ${weeks.length ? `<div class="planning-library-list">${weeks.map(planningLibraryItem).join("")}</div>` : empty("Guardá una planificación para que quede disponible aquí.")}
    </section>`;
}

function planningLibraryItem(week) {
  const assigned = Number.isInteger(week.assignmentCount) ? week.assignmentCount : (week.assignments || []).length;
  const total = Number.isInteger(week.positionCount) ? week.positionCount : (week.operationalPositions || []).length;
  const isCurrent = state.planningWeek?.id === week.id;
  const isSelected = selectedPlanningWeekIds.has(week.id);
  return `<article class="planning-library-item ${isCurrent ? "current" : ""} ${isSelected ? "selected" : ""}">
    <label class="planning-library-select" title="Seleccionar ${escapeHtml(week.name)}"><input type="checkbox" name="planning-week-selection" value="${week.id}" ${isSelected ? "checked" : ""} /><span class="sr-only">Seleccionar ${escapeHtml(week.name)}</span></label>
    <div class="planning-library-icon">▦</div>
    <div class="planning-library-main"><strong>${escapeHtml(week.name)}</strong><small>${formatIsoDate(week.startDate)} al ${formatIsoDate(week.endDate)} · ${assigned}/${total} puestos asignados</small>${week.savedAt ? `<small>Guardada ${formatDateTime(week.savedAt)}</small>` : ""}</div>
    <span class="week-status ${week.status || "draft"}">${planningWeekStatusLabel(week.status)}</span>
    <button class="button secondary" data-action="open-stored-planning" data-week-id="${week.id}">${isCurrent ? "Abrir" : "Ver grilla"}</button>
  </article>`;
}

function planningWeekPage() {
  const week = state.planningWeek;
  ensureKitchenPlanningSlots(week);
  const canCreate = canEditSchedule(user.role);
  if (!canCreate) {
    if (week?.status === "published") return staffPublishedPlanningWeekPage(week);
    return `${pageHeading("PLANIFICACIÓN SEMANAL", "Mi semana", "No hay grilla publicada disponible.")}
      <section class="panel">${empty("No hay grilla publicada disponible")}</section>`;
  }
  if (!week) {
    return `${pageHeading("PLANIFICACIÓN SEMANAL", "Grilla operativa", "Creá el contenedor de una semana antes de comenzar a editar puestos.", canCreate ? `<button class="button primary" data-action="new-planning-week">${icons.plus} Crear semana</button>` : "")}
      <section class="week-lifecycle-card week-not-created">
        <div class="week-lifecycle-head"><span class="week-state-icon">○</span><div><span class="eyebrow">ESTADO ACTUAL</span><h2>Sin crear</h2><p>Todavía no existe una semana de planificación.</p></div><span class="week-status empty">Sin crear</span></div>
        <div class="week-lifecycle-flow" aria-label="Ciclo de vida inicial"><span class="active"><i>1</i><b>Sin crear</b></span><em>→</em><span><i>2</i><b>Borrador</b></span></div>
        <div class="week-empty-explanation"><strong>¿Qué se creará?</strong><p>Un contenedor con nombre, período y los puestos operativos vacíos de sus siete días. No copiará personas, francos, coberturas ni información de otra semana.</p></div>
      </section>`;
  }
  const conflicts = detectPlanningConflicts(week);
  const statusLabel = planningWeekStatusLabel(week.status);
  const publishAction = canCreate ? planningWeekLifecycleActions(week) : "";
  return `${planningCompactHeading(week, statusLabel, publishAction)}
    ${planningWeekStructure(week, conflicts, false, null, true)}`;
}

function planningLaneDayTabs(week, conflicts) {
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  planningDateIndex = Math.min(Math.max(planningDateIndex, 0), Math.max(dates.length - 1, 0));
  return `<div class="planning-lane-days" aria-label="Días de la grilla">${dates.map((date, index) => {
    const positions = week.operationalPositions.filter((position) => position.date === date && !isOptionalPlanningPosition(position));
    const assigned = positions.filter((position) => week.assignments.some((assignment) => assignment.positionId === position.id)).length;
    const warnings = positions.reduce((count, position) => count + (conflicts.positionWarnings.get(position.id) || []).length, 0);
    return `<button class="planning-lane-day ${planningDateIndex === index ? "active" : ""} ${warnings ? "has-alert" : ""}" data-action="select-planning-date" data-date-index="${index}"><span>${["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"][index]}</span><strong>${formatIsoDate(date).slice(0, 5)}</strong><small>${assigned}/${positions.length}${warnings ? " · !" : ""}</small></button>`;
  }).join("")}</div>`;
}

function planningLaneAlerts(week, conflicts) {
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  const date = dates[planningDateIndex];
  const items = conflicts.items.filter((item) => item.text.includes(formatIsoDate(date))).slice(0, 2);
  if (!items.length) return `<div class="planning-lane-alert ok"><span>✓</span><div><strong>La jornada seleccionada no tiene alertas críticas</strong><p>Podés revisar puestos o continuar con el próximo día.</p></div></div>`;
  return `<div class="planning-lane-alert"><span>!</span><div><strong>${items.length} ${items.length === 1 ? "alerta" : "alertas"} para ${formatIsoDate(date)}</strong><p>${items.map((item) => escapeHtml(item.text.replace(`${formatIsoDate(date)} · `, ""))).join(" · ")}</p></div><button class="button secondary" data-action="new-week-exception">Registrar excepción</button></div>`;
}

function planningLanesStructure(week, conflicts, daysOffSummary) {
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  const date = dates[planningDateIndex];
  const sections = [
    { sector: "Cocina", shift: "Mañana", icon: "♨", label: "Cocina · Mañana", time: "06:00–14:00", tone: "kitchen" },
    { sector: "Cocina", shift: "Tarde", icon: "♨", label: "Cocina · Tarde", time: "14:00–21:30", tone: "kitchen" },
    { sector: "Pisos", shift: "Mañana", icon: "▦", label: "Pisos · Mañana", time: "06:00–14:00", tone: "floors" },
    { sector: "Pisos", shift: "Tarde", icon: "▦", label: "Pisos · Tarde", time: "14:00–21:30", tone: "floors" },
  ];
  return `<div class="planning-lanes" aria-label="Carriles operativos">${sections.map((section) => planningLane(week, section, date, conflicts)).join("")}
    ${planningLaneDaysOff(week, "Cocina", date, daysOffSummary, conflicts)}
    ${planningLaneDaysOff(week, "Pisos", date, daysOffSummary, conflicts)}
  </div>`;
}

function planningLane(week, section, date, conflicts) {
  const positions = week.operationalPositions.filter((position) => position.date === date && position.sector === section.sector && position.shift === section.shift);
  const required = positions.filter((position) => !isOptionalPlanningPosition(position));
  const assigned = required.filter((position) => week.assignments.some((assignment) => assignment.positionId === position.id)).length;
  return `<section class="planning-lane ${section.tone}"><header><div class="planning-lane-title"><span>${section.icon}</span><div><h3>${section.label}</h3><small>${section.time}</small></div></div><b class="planning-lane-status ${assigned === required.length ? "ok" : "warning"}">${assigned}/${required.length} cubiertos</b></header><div class="planning-lane-slots">${positions.map((position) => planningLaneSlot(week, position, conflicts)).join("")}</div><footer><span>${positions.length} puestos visibles</span><small>${assigned === required.length ? "Sin pendientes" : `${required.length - assigned} por resolver`}</small></footer></section>`;
}

function planningLaneSlot(week, position, conflicts) {
  const assignment = week.assignments.find((item) => item.positionId === position.id);
  const employee = assignment ? state.employees.find((item) => item.id === assignment.employeeId) : null;
  const warnings = conflicts.positionWarnings.get(position.id) || [];
  const editable = ["draft", "published", "paused"].includes(week.status) && canEditSchedule(user.role);
  const optional = isOptionalPlanningPosition(position);
  const stateClass = employee ? "assigned" : optional ? "optional" : "unfilled";
  const label = employee ? employee.name : optional ? "Apoyo opcional" : position.sector === "Pisos" ? "Sin cobertura" : "Sin asignar";
  const detail = employee ? `${employee.role}${warnings.length ? ` · ${warnings[0]}` : ""}` : optional ? "No requerido para publicar" : warnings[0] || "Elegí una persona compatible";
  return `<button class="planning-lane-slot ${stateClass} ${warnings.length ? "has-warning" : ""}" type="button" ${editable ? `data-action="assign-planning-position" data-position-id="${position.id}"` : "disabled"}><span class="planning-lane-avatar">${employee ? escapeHtml(employee.initials || initials(employee.name)) : optional ? "+" : "!"}</span><span><strong>${escapeHtml(position.label.replace(`${position.sector} ${position.shift} · `, ""))}</strong><small>${escapeHtml(label)} · ${escapeHtml(detail)}</small></span><i>›</i></button>`;
}

function planningLaneDaysOff(week, sector, date, daysOffSummary, conflicts) {
  const dayOffs = daysOffSummary?.[sector]?.[date] || [];
  const editable = ["draft", "published", "paused"].includes(week.status) && canEditSchedule(user.role);
  return `<section class="planning-lane planning-lane-off"><header><div class="planning-lane-title"><span>○</span><div><h3>Francos · ${sector}</h3><small>${dayOffs.length ? `${dayOffs.length} personas disponibles` : "Sin francos cargados"}</small></div></div><b class="planning-lane-status neutral">${dayOffs.length}</b></header><button class="planning-lane-days-off" type="button" ${editable ? `data-action="add-planning-day-off" data-sector="${sector}" data-date="${date}"` : "disabled"}>${dayOffs.length ? dayOffs.map((dayOff) => `<span class="planning-lane-off-chip ${dayOff.source === "manualDayOff" ? "manual" : ""}"><strong>${escapeHtml(dayOff.name)}</strong><small>${escapeHtml(dayOff.type || "Franco")}</small></span>`).join("") : "Agregar franco"}</button></section>`;
}

function planningGoogleStat(label, value, meta) {
  return `<span class="planning-google-stat"><small>${label}</small><strong>${value}</strong><em>${meta}</em></span>`;
}

function staffPublishedPlanningWeekPage(week) {
  const conflicts = detectPlanningConflicts(week);
  const showOperationalExceptions = isAdminRole(user.role);
  return `<section class="week-lifecycle-card week-published staff-published-week">
      <div class="week-lifecycle-head"><span class="week-state-icon">✓</span><div><span class="eyebrow">SOLO LECTURA</span><h2>${escapeHtml(week.name)}</h2><p>${formatIsoDate(week.startDate)} al ${formatIsoDate(week.endDate)} · Publicada ${formatDateTime(week.publishedAt)}</p></div><span class="week-status published">Publicada</span></div>
      ${showOperationalExceptions ? weeklyExceptionsPanel(week, canEditSchedule(user.role)) : ""}
      ${planningWeekStructure(week, conflicts, showOperationalExceptions)}
    </section>`;
}

function planningWeekStructure(week, conflicts, showExceptions = true, providedDaysOffSummary = null, simpleGridView = false) {
  const staffView = simpleGridView || !isAdminRole(user.role);
  const focusedEmployeeId = user.role === "staff" ? user.employeeId : planningFocusedEmployeeId;
  const daysOffSummary = providedDaysOffSummary || buildDailyDaysOffSummary({
    employees: state.employees,
    week,
    availabilityMap: buildWeeklyAvailabilityMap(state.employees, week, { requests: state.requests }),
  });
  return `${planningFocusToolbar(week, focusedEmployeeId, daysOffSummary)}<div class="planning-position-sectors ${staffView ? "planning-position-sectors--staff" : ""}" aria-label="Puestos operativos">
    ${planningPositionSector(week, { sector: "Cocina", key: "kitchen", icon: "🍳", eyebrow: "SECTOR OPERATIVO" }, conflicts, showExceptions, staffView, focusedEmployeeId)}
    ${planningDaysOffSector(week, "Cocina", daysOffSummary, conflicts)}
    ${planningPositionSector(week, { sector: "Pisos", key: "floors", icon: "🏥", eyebrow: "COBERTURA POR PISO" }, conflicts, showExceptions, staffView, focusedEmployeeId)}
    ${planningDaysOffSector(week, "Pisos", daysOffSummary, conflicts)}
  </div>`;
}

function planningFocusToolbar(week, focusedEmployeeId, daysOffSummary = {}) {
  if (user.role === "staff") {
    const turns = (week.assignments || []).filter((assignment) => assignment.employeeId === user.employeeId).length;
    const daysOff = Object.values(daysOffSummary)
      .flatMap((sectorDays) => Object.values(sectorDays).flat())
      .filter((dayOff) => dayOff.employeeId === user.employeeId);
    const offText = daysOff.length ? ` · ${daysOff.map((item) => `${formatIsoDate(item.date).slice(0, 5)} ${item.tipo || "Franco"}`).join(", ")}` : "";
    return `<div class="planning-focus-summary"><strong>Mi semana · ${turns} turnos</strong><span>Mis asignaciones están resaltadas${offText}.</span></div>`;
  }
  if (user.role !== "supervisor") return "";
  const options = state.employees.filter((employee) => employee.status === "active").map((employee) => `<option value="${employee.id}" ${focusedEmployeeId === employee.id ? "selected" : ""}>${escapeHtml(employee.name)}</option>`).join("");
  return `<label class="planning-focus-control">Foco de empleado<select data-action="planning-focus-employee"><option value="">Vista operativa completa</option>${options}</select></label>`;
}

function weeklyExceptionsPanel(week, editable) {
  const exceptions = (week.exceptions || [])
    .map((exception) => ({ ...exception, position: week.operationalPositions.find((position) => position.id === exception.positionId) }))
    .filter((exception) => exception.position && exception.status !== "revoked")
    .sort((a, b) => a.position.date.localeCompare(b.position.date) || a.position.shift.localeCompare(b.position.shift));
  return `<section class="weekly-exceptions-panel" aria-label="Excepciones semanales">
    <div class="panel-head"><div><span class="eyebrow">AJUSTES PUNTUALES</span><h2>Excepciones de la semana</h2></div></div>
    ${exceptions.length ? `<div class="weekly-exception-list">${exceptions.map((exception) => weeklyExceptionItem(exception, editable)).join("")}</div>` : empty("No hay excepciones registradas en esta semana")}
  </section>`;
}

function weeklyExceptionItem(exception, editable) {
  const affected = state.employees.find((employee) => employee.id === exception.affectedEmployeeId);
  const cover = state.employees.find((employee) => employee.id === exception.coverEmployeeId);
  const position = exception.position;
  return `<article class="weekly-exception-item">
    <span class="exception-marker">!</span>
    <div><strong>${exceptionTypes[exception.type] || exception.type}</strong><small>${formatIsoDate(position.date)} · Turno ${position.shift} · ${position.label}</small></div>
    <div><small>Persona afectada</small><strong>${affected?.name || "Puesto sin persona asignada"}</strong></div>
    <div><small>Cubre</small><strong>${cover?.name || "Sin cobertura indicada"}</strong></div>
    ${editable ? `<div class="exception-actions"><button class="row-action" data-action="edit-week-exception" data-exception-id="${exception.id}">Editar</button><button class="row-action danger" data-action="remove-week-exception" data-exception-id="${exception.id}">Eliminar</button></div>` : ""}
  </article>`;
}

function positionExceptions(week, positionId) {
  return (week.exceptions || []).filter((exception) => exception.positionId === positionId && exception.status !== "revoked");
}

function positionExceptionSummary(exceptions) {
  if (!exceptions.length) return "";
  const first = exceptions[0];
  const cover = state.employees.find((employee) => employee.id === first.coverEmployeeId);
  const detail = first.coverageType === "replacement" && cover
    ? `Reemplazo: ${cover.name}`
    : cover ? `Cubre ${cover.name}` : exceptionTypes[first.type] || "Excepción";
  return `<span class="planning-exception-chip">! ${detail}${exceptions.length > 1 ? ` +${exceptions.length - 1}` : ""}</span>`;
}

function isOptionalPlanningPosition(position) {
  return ["kitchen-extra-morning", "kitchen-extra-afternoon"].includes(position?.templateId);
}

function isBaseKitchenPosition(position) {
  return position?.sector === "Cocina" && !isOptionalPlanningPosition(position);
}

function planningSpecialChip(assignment, position, employee, visible) {
  if (!visible || !assignment || !position || !employee) return "";
  if (assignment.assignmentType === "coverage" && position.sector === "Pisos" && ["emp-franquera-debora", "emp-franquera-lucila"].includes(employee.id)) {
    return `<span class="planning-assignment-chip franchise">Franquera</span>`;
  }
  if (assignment.assignmentType === "collaboration" && position.templateId === "kitchen-extra-morning" && ["emp-franquera-debora", "emp-franquera-lucila"].includes(employee.id)) {
    return `<span class="planning-assignment-chip kitchen-support">Apoyo en Cocina</span>`;
  }
  return "";
}

function emptyPositionState(position, warnings) {
  if (!position) return "";
  if (position.sector === "Pisos") return `<span class="planning-empty-state critical">Sin cobertura</span>`;
  if (isOptionalPlanningPosition(position)) return `<span class="planning-empty-state optional">Opcional</span>`;
  if (isBaseKitchenPosition(position)) return `<span class="planning-empty-state pending">Pendiente operativo</span>`;
  return warnings.length ? "" : `<span class="planning-empty-state pending">Pendiente</span>`;
}

function planningEmployeeName(employee) {
  const firstName = String(employee?.name || "").trim().split(/\s+/)[0] || "Sin asignar";
  const size = firstName.length >= 10 ? "extra-long" : firstName.length >= 8 ? "long" : "standard";
  return `<strong class="planning-assignment-name--full">${escapeHtml(employee.name)}</strong><strong class="planning-assignment-name--compact ${size}">${escapeHtml(firstName)}</strong>`;
}

function planningPositionSector(week, section, conflicts, showExceptions = true, staffView = false, focusedEmployeeId = null) {
  const positions = week.operationalPositions.filter((position) => position.sector === section.sector);
  const dates = [...new Set(positions.map((position) => position.date))].sort();
  const rows = positions
    .filter((position) => position.dayIndex === 0)
    .sort((a, b) => a.shift.localeCompare(b.shift) || (a.slot || 0) - (b.slot || 0) || a.label.localeCompare(b.label));
  const dayNames = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  const editable = ["draft", "published", "paused"].includes(week.status) && canEditSchedule(user.role);
  const showSpecialChips = !staffView && canEditSchedule(user.role);
  const shifts = [
    { value: "Mañana", modifier: "morning", icon: "☼", label: "TURNO MAÑANA" },
    { value: "Tarde", modifier: "afternoon", icon: "☾", label: "TURNO TARDE" },
  ];
  const rowsByShift = Object.fromEntries(shifts.map((shift) => [shift.value, rows.filter((row) => row.shift === shift.value)]));
  const rowMarkup = (row) => {
    const [labelTitle, ...details] = row.label.split(" · ");
    const title = row.sector === "Cocina" ? "Cocina" : row.floor ? `${row.floor} piso` : labelTitle;
    const detail = details.join(" · ");
    return `<div class="planning-position-row-label shift-${row.shift === "Mañana" ? "morning" : "afternoon"}"><strong>${title}</strong>${detail ? `<small>${detail}</small>` : ""}</div>${dates.map((date, index) => {
    const position = positions.find((item) => item.templateId === row.templateId && item.date === date);
    const assignment = position ? week.assignments.find((item) => item.positionId === position.id) : null;
    const employee = assignment ? state.employees.find((item) => item.id === assignment.employeeId) : null;
    const warnings = !staffView && position ? conflicts.positionWarnings.get(position.id) || [] : [];
    const allExceptions = position ? positionExceptions(week, position.id) : [];
    const exceptions = showExceptions
      ? allExceptions
      : allExceptions.filter((exception) => exception.affectedEmployeeId === focusedEmployeeId || exception.coverEmployeeId === focusedEmployeeId);
    const emptyState = !employee && !staffView ? emptyPositionState(position, warnings) : "";
    const specialChip = planningSpecialChip(assignment, position, employee, showSpecialChips);
    const isFocused = Boolean(employee && employee.id === focusedEmployeeId);
    const hasFocusedException = exceptions.some((exception) => exception.affectedEmployeeId === focusedEmployeeId || exception.coverEmployeeId === focusedEmployeeId);
    const assignmentContent = employee
      ? staffView ? planningEmployeeName(employee) : `${planningEmployeeName(employee)}<small>${escapeHtml(employee.role)}</small>${specialChip}`
      : emptyState;
    return `<div class="planning-position-cell ${staffView ? "staff-view" : ""} ${isFocused ? "is-focused" : ""} ${hasFocusedException ? "has-focused-exception" : ""} ${index === dates.length - 1 ? "is-last-day" : ""} ${warnings.length ? "has-warning" : ""} ${exceptions.length ? "has-exception" : ""}"><button class="planning-position-assignment ${employee ? "assigned" : "empty"} ${isFocused ? "is-focused" : ""} ${staffView ? "staff-view" : ""} ${warnings.length ? "warning" : ""} ${exceptions.length ? "exception" : ""} ${!staffView && !employee && position?.sector === "Pisos" ? "critical-empty" : ""} ${!staffView && !employee && isOptionalPlanningPosition(position) ? "optional-empty" : ""}" type="button" ${editable && position ? `data-action="assign-planning-position" data-position-id="${position.id}"` : "disabled"} aria-label="${employee ? `Cambiar asignación de ${position.label}: ${employee.name}` : `Asignar empleado a ${position?.label || row.label}`}">${assignmentContent}${staffView ? "" : `${positionExceptionSummary(exceptions)}${warnings.length ? `<em>${warnings[0]}</em>` : ""}`}</button></div>`;
    }).join("")}`;
  };
  return `<section class="planning-position-sector reference-sector reference-sector-${section.key}" aria-labelledby="planning-${section.key}-title">
    <header class="reference-sector-head"><span class="reference-sector-icon" aria-hidden="true">${section.icon}</span><div><span class="reference-sector-eyebrow">${section.eyebrow}</span><h2 id="planning-${section.key}-title">${section.sector}</h2>${section.description ? `<p>${section.description}</p>` : ""}</div></header>
    <p class="planning-scroll-hint">Deslizá horizontalmente para recorrer los siete días.</p>
    <div class="planning-position-board" tabindex="0" aria-label="Grilla semanal desplazable"><div class="planning-position-grid" style="--morning-rows:${rowsByShift["Mañana"].length};--afternoon-rows:${rowsByShift["Tarde"].length}">
      <div class="planning-position-corner"><span class="sr-only">Puesto</span>${staffView ? "" : `<small>${week.assignments.length} asignados</small>`}</div>
      ${dates.map((date, index) => `<div class="planning-position-day ${date === localIsoDate() ? "is-today" : ""} ${index === dates.length - 1 ? "is-last-day" : ""}"><span>${dayNames[index]}</span><strong>${formatIsoDate(date).slice(0, 5)}</strong></div>`).join("")}
      ${shifts.map((shift) => `<div class="planning-shift-divider planning-shift-divider--${shift.modifier}"><span aria-hidden="true">${shift.icon}</span><strong>${shift.label}</strong></div>${rowsByShift[shift.value].map(rowMarkup).join("")}`).join("")}
    </div></div>
  </section>`;
}

function planningDaysOffSector(week, sector, daysOffSummary, conflicts) {
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  const dayNames = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  const editable = ["draft", "published", "paused"].includes(week.status) && canEditSchedule(user.role);
  const sectionId = `planning-days-off-${sector.toLowerCase()}`;
  const title = `FRANCOS ${sector.toUpperCase()}`;
  return `<section class="planning-position-sector reference-sector reference-sector-off" aria-labelledby="${sectionId}">
    <header class="reference-sector-head"><span class="reference-sector-icon" aria-hidden="true">○</span><div><span class="reference-sector-eyebrow">DISPONIBILIDAD</span><h2 id="${sectionId}">${title}</h2></div></header>
    <div class="planning-position-board"><div class="planning-position-grid planning-days-off-grid">
      <div class="planning-position-corner" aria-label="${title}"></div>
      ${dates.map((date, index) => `<div class="planning-position-day"><span>${dayNames[index]}</span><strong>${formatIsoDate(date).slice(0, 5)}</strong></div>`).join("")}
      <div class="planning-position-row-label"><strong>Personal</strong></div>${dates.map((date) => planningDaysOffCell(week, sector, date, daysOffSummary?.[sector]?.[date] || [], editable, conflicts)).join("")}
    </div></div>
  </section>`;
}

function planningDaysOffCell(week, sector, date, dayOffs, editable, conflicts) {
  return `<div class="planning-position-cell planning-days-off-cell"><button class="planning-day-off-button ${dayOffs.length ? "assigned" : "empty"}" type="button" ${editable ? `data-action="add-planning-day-off" data-sector="${sector}" data-date="${date}"` : "disabled"} aria-label="Cargar franco de ${sector} para ${formatIsoDate(date)}">${dayOffs.length ? dayOffs.map((dayOff) => {
    const warnings = dayOff.dayOffId ? conflicts.dayOffWarnings.get(dayOff.dayOffId) || [] : [];
    const type = dayOff.type || "Franco";
    const sourceLabel = dayOff.source === "manualDayOff" ? "Manual" : "";
    const meta = sourceLabel ? `${type} · ${sourceLabel}` : type;
    return `<span class="planning-day-off-chip ${warnings.length ? "warning" : ""} ${dayOff.source === "calculatedCycle" ? "calculated" : "manual"}" title="${escapeHtml(dayOff.name)} · ${escapeHtml(meta)}"><strong>${escapeHtml(dayOff.name)}</strong><small>${escapeHtml(meta)}</small>${warnings.length ? `<em>${warnings[0]}</em>` : ""}</span>`;
  }).join("") : `<span>Sin francos</span>`}</button></div>`;
}

function detectPlanningConflicts(week) {
  const positionWarnings = new Map();
  const dayOffWarnings = new Map();
  const items = [];
  const counts = { assignedAndOff: 0, duplicateAssignment: 0, unassignedPosition: 0, uncoveredFloor: 0 };
  const assignmentsByPosition = new Map((week.assignments || []).map((assignment) => [assignment.positionId, assignment]));
  const positionsById = new Map((week.operationalPositions || []).map((position) => [position.id, position]));
  const employeesById = new Map((state.employees || []).map((employee) => [employee.id, employee]));
  const availabilityMap = buildWeeklyAvailabilityMap(state.employees, week, { requests: state.requests });

  const addPositionWarning = (positionId, message) => {
    if (!positionWarnings.has(positionId)) positionWarnings.set(positionId, []);
    positionWarnings.get(positionId).push(message);
  };
  const addDayOffWarning = (dayOffId, message) => {
    if (!dayOffWarnings.has(dayOffId)) dayOffWarnings.set(dayOffId, []);
    dayOffWarnings.get(dayOffId).push(message);
  };

  week.operationalPositions.forEach((position) => {
    const assignment = assignmentsByPosition.get(position.id);
    if (!assignment && !isOptionalPlanningPosition(position)) {
      counts.unassignedPosition += 1;
      if (position.sector === "Pisos" && position.floor) {
        counts.uncoveredFloor += 1;
        addPositionWarning(position.id, `Piso ${position.floor} sin cobertura`);
        items.push({ type: "uncoveredFloor", text: `${formatIsoDate(position.date)} · Piso ${position.floor} ${position.shift} sin cobertura.` });
      }
      items.push({ type: "unassignedPosition", text: `${formatIsoDate(position.date)} · ${position.label} está sin asignar.` });
    }
  });

  const assignmentsByDayEmployee = new Map();
  (week.assignments || []).forEach((assignment) => {
    const position = positionsById.get(assignment.positionId);
    if (!position) return;
    const key = `${position.date}:${assignment.employeeId}`;
    if (!assignmentsByDayEmployee.has(key)) assignmentsByDayEmployee.set(key, []);
    assignmentsByDayEmployee.get(key).push({ assignment, position });
  });

  assignmentsByDayEmployee.forEach((records) => {
    if (records.length < 2) return;
    const employee = employeesById.get(records[0].assignment.employeeId);
    counts.duplicateAssignment += 1;
    records.forEach(({ position }) => addPositionWarning(position.id, "Duplicado mismo día"));
    items.push({ type: "duplicateAssignment", text: `${formatIsoDate(records[0].position.date)} · ${employee?.name || "Empleado"} figura ${records.length} veces en el mismo día.` });
  });

  (week.assignments || []).forEach((assignment) => {
    const position = positionsById.get(assignment.positionId);
    if (!position) return;
    const availability = availabilityMap[assignment.employeeId]?.[position.date];
    if (!availability || availability.available !== false) return;
    const employee = employeesById.get(assignment.employeeId);
    const manualDayOff = (week.daysOff || []).find((dayOff) => dayOff.employeeId === assignment.employeeId && dayOff.date === position.date);
    const reason = availabilityConflictLabel(availability);
    counts.assignedAndOff += 1;
    if (manualDayOff?.id) addDayOffWarning(manualDayOff.id, "También asignado");
    addPositionWarning(position.id, reason);
    items.push({ type: "assignedAndOff", text: `${formatIsoDate(position.date)} · ${employee?.name || "Empleado"} está asignado con indisponibilidad: ${reason}.` });
  });

  return { counts, items, positionWarnings, dayOffWarnings, total: items.length };
}

function availabilityConflictLabel(availability) {
  if (availability?.reason === "dayOff") return availability.dayOffType ? `Franco ${availability.dayOffType}` : "Empleado de franco";
  if (availability?.reason === "leave") return "Licencia";
  if (availability?.reason === "absence") return "Ausencia";
  if (availability?.reason === "vacation") return "Vacaciones";
  if (availability?.reason === "weeklyException") return "Excepción semanal";
  if (availability?.reason === "approvedRequest") return "Solicitud aprobada";
  return "Indisponible";
}

function planningConflictPanel(conflicts) {
  if (!conflicts.total) {
    return `<div class="planning-conflict-panel ok"><span>✓</span><div><strong>Sin advertencias visibles</strong><p>No se detectan conflictos básicos en esta grilla.</p></div></div>`;
  }
  const summary = [
    ["Asignado no disponible", conflicts.counts.assignedAndOff],
    ["Asignación duplicada", conflicts.counts.duplicateAssignment],
    ["Puestos sin asignar", conflicts.counts.unassignedPosition],
    ["Pisos sin cobertura", conflicts.counts.uncoveredFloor],
  ];
  return `<section class="planning-conflict-panel warning" aria-label="Advertencias de la grilla">
    <div class="planning-conflict-head"><span>!</span><div><strong>Advertencias de la grilla</strong><p>Los puestos sin asignar y pisos sin cobertura no bloquean la publicación. Solo se bloquea una persona repetida dentro del mismo día.</p></div></div>
    <div class="planning-conflict-summary">${summary.map(([label, count]) => `<span><b>${count}</b><small>${label}</small></span>`).join("")}</div>
    <ul>${conflicts.items.slice(0, 8).map((item) => `<li>${item.text}</li>`).join("")}${conflicts.items.length > 8 ? `<li>+ ${conflicts.items.length - 8} advertencias más en la grilla.</li>` : ""}</ul>
  </section>`;
}

async function publishPlanningWeek() {
  const week = state.planningWeek;
  if (!week || !["draft", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  const conflicts = detectPlanningConflicts(week);
  if (conflicts.counts.duplicateAssignment) {
    return toast(`No se puede publicar: corregí ${conflicts.counts.duplicateAssignment} duplicado(s) dentro del mismo día.`, "error");
  }
  try {
    const wasPaused = week.status === "paused";
    await apiCommand(`/api/planning/weeks/${encodeURIComponent(week.id)}/status`, { status: "published", version: week.version });
    toast(wasPaused ? "Grilla republicada correctamente" : "Grilla publicada correctamente");
  } catch (error) { toast(error.message, "error"); }
}

async function savePlanningWeekToJson() {
  const week = state.planningWeek;
  if (!week || !canEditSchedule(user.role)) return;
  week.savedAt = new Date().toISOString();
  week.savedBy = { id: user.id || user.username, name: user.name, role: user.role };
  audit("Guardó una planificación", week.name, STATE_STORAGE_LABEL);
  try {
    await persistPlanningWeekLifecycle(week, { requireFile: true });
    toast(`Planificación guardada en ${STATE_STORAGE_LABEL}`);
  } catch (error) {
    toast(error.message || `No se pudo guardar en ${STATE_STORAGE_LABEL}`, "error");
  }
}

function storePlanningWeekSnapshot(week) {
  if (!Array.isArray(state.weeklySchedules)) state.weeklySchedules = [];
  const snapshot = structuredClone(week);
  const index = state.weeklySchedules.findIndex((item) => item.id === week.id);
  if (index >= 0) state.weeklySchedules[index] = snapshot;
  else state.weeklySchedules.unshift(snapshot);
}

function persistPlanningWeekLifecycle(week, options = {}) {
  if (!week || typeof week !== "object") return persist(options);
  const timestamp = new Date().toISOString();
  week.createdAt = week.createdAt || timestamp;
  week.updatedAt = timestamp;
  storePlanningWeekSnapshot(week);
  return persist(options);
}

async function openStoredPlanningWeek(weekId) {
  const stored = planningSnapshots().find((week) => week.id === weekId);
  if (!stored || !canEditSchedule(user.role)) return toast("No se encontró la grilla almacenada.", "error");
  if (state.planningWeek && state.planningWeek.id !== weekId && planningWeekHasUnsavedChanges(state.planningWeek) && !confirm("La grilla actual tiene cambios sin guardar en el historial. ¿Abrir otra grilla de todos modos?")) return;
  try {
    const result = await requestApi(`/api/planning/weeks/${encodeURIComponent(weekId)}`);
    applyApiFragment(result);
    planningView = "editor";
    render();
  } catch (error) {
    toast(error.message || "No se pudo abrir la grilla.", "error");
  }
}

function generatePlanningProposal() {
  const week = state.planningWeek;
  if (!week || !canEditSchedule(user.role)) return;
  if (week.status === "published") return toast("La grilla publicada validada no se modifica. Creá o abrí una grilla borrador para generar una propuesta.", "error");
  if (!confirm("Se completarán puestos vacíos con titulares habituales, excepción Gustavo/Julio, coberturas de Pisos y colaboración de Cocina mañana si Pisos queda completo. Las asignaciones manuales se conservan.")) return;
  ensureKitchenPlanningSlots(week);
  const generatedAt = new Date().toISOString();
  const availabilityMap = buildWeeklyAvailabilityMap(state.employees, week, { requests: state.requests });
  const habitualProposals = generateHabitualAssignments({ week, employees: state.employees, availabilityMap });
  const gustavoJulioResult = applyGustavoJulioException({
    week,
    employees: state.employees,
    availabilityMap,
    pendingAssignments: habitualProposals,
    generatedAt,
  });
  const coverageResult = generateFloorCoverageAssignments({
    week,
    employees: state.employees,
    availabilityMap,
    weeklySchedules: state.weeklySchedules,
    pendingAssignments: gustavoJulioResult.assignments,
    generatedAt,
  });
  const kitchenCollaborations = generateKitchenMorningCollaborationAssignments({
    week,
    employees: state.employees,
    availabilityMap,
    weeklySchedules: state.weeklySchedules,
    pendingAssignments: [...gustavoJulioResult.assignments, ...coverageResult.assignments],
    floorCoverageGaps: coverageResult.uncovered,
    generatedAt,
  });
  const proposals = [...gustavoJulioResult.assignments, ...coverageResult.assignments, ...kitchenCollaborations];
  proposals.forEach((proposal) => week.assignments.push({ id: crypto.randomUUID(), ...proposal }));
  week.lastProposalAt = generatedAt;
  week.lastProposalMode = "habitualPositionsGustavoJulioFloorCoverageAndKitchenMorningCollaboration";
  week.lastCoverageGaps = coverageResult.uncovered;
  audit("Generó una propuesta de planificación", week.name, `${gustavoJulioResult.assignments.length - gustavoJulioResult.coverages.length} titulares, ${gustavoJulioResult.coverages.length} cobertura Gustavo/Julio, ${coverageResult.assignments.length} coberturas de Pisos y ${kitchenCollaborations.length} colaboraciones en Cocina mañana`);
  persistPlanningWeekLifecycle(week);
  const gapText = coverageResult.uncovered.length ? ` · ${coverageResult.uncovered.length} puestos de Pisos sin cubrir` : "";
  toast(proposals.length ? `Propuesta generada: ${gustavoJulioResult.assignments.length - gustavoJulioResult.coverages.length} titulares, ${gustavoJulioResult.coverages.length} cobertura Gustavo/Julio, ${coverageResult.assignments.length} coberturas y ${kitchenCollaborations.length} colaboraciones${gapText}` : `No había asignaciones disponibles${gapText}`);
}

async function pausePlanningWeek() {
  const week = state.planningWeek;
  if (!week || week.status !== "published" || !canEditSchedule(user.role)) return;
  if (!confirm("¿Pausar la publicación? El personal dejará de ver esta grilla hasta que se republice.")) return;
  try { await apiCommand(`/api/planning/weeks/${encodeURIComponent(week.id)}/status`, { status: "paused", version: week.version }); toast("Publicación pausada"); } catch (error) { toast(error.message, "error"); }
}

async function draftPlanningWeek() {
  const week = state.planningWeek;
  if (!week || !["published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  if (!confirm("¿Volver la grilla a borrador? El personal dejará de verla hasta que se publique nuevamente.")) return;
  try { await apiCommand(`/api/planning/weeks/${encodeURIComponent(week.id)}/status`, { status: "draft", version: week.version }); toast("Grilla en borrador"); } catch (error) { toast(error.message, "error"); }
}

async function deletePlanningWeek() {
  const week = state.planningWeek;
  if (!week || !canEditSchedule(user.role)) return;
  if (!confirm("¿Eliminar esta grilla? Se quitará también del historial almacenado.")) return;
  try { await apiCommand(`/api/planning/weeks/${encodeURIComponent(week.id)}`, null, "DELETE", { "If-Match": String(week.version) }); planningView = "library"; toast("Grilla eliminada"); } catch (error) { toast(error.message, "error"); }
}

function deleteSelectedPlanningWeeks() {
  if (!canEditSchedule(user.role)) return;
  const selectedWeeks = planningSnapshots().filter((week) => selectedPlanningWeekIds.has(week.id));
  if (!selectedWeeks.length) return toast("Seleccioná al menos una grilla.", "error");
  const confirmation = selectedWeeks.length === 1
    ? `¿Eliminar "${selectedWeeks[0].name}"? Se quitará del historial almacenado.`
    : `¿Eliminar ${selectedWeeks.length} grillas seleccionadas? Se quitarán del historial almacenado.`;
  if (!confirm(confirmation)) return;
  const selectedIds = new Set(selectedWeeks.map((week) => week.id));
  state.weeklySchedules = (state.weeklySchedules || []).filter((week) => !selectedIds.has(week.id));
  if (state.planningWeek && selectedIds.has(state.planningWeek.id)) state.planningWeek = null;
  selectedWeeks.forEach((week) => audit("Eliminó una grilla semanal", week.name, "Eliminada"));
  selectedPlanningWeekIds.clear();
  planningView = "library";
  persist();
  toast(selectedWeeks.length === 1 ? "Grilla eliminada" : `${selectedWeeks.length} grillas eliminadas`);
}

function referenceSchedulePage() {
  const reference = state.referenceSchedule;
  const kitchenRows = [
    { sector: "Cocina", label: "Turno mañana", values: (day) => day.cocina.manana },
    { sector: "Cocina", label: "Turno tarde", values: (day) => day.cocina.tarde },
  ];
  const floorRows = [
    { sector: "Pisos", label: "Mañana · Piso 1", values: (day) => [day.pisos.manana[1]] },
    { sector: "Pisos", label: "Mañana · Piso 2", values: (day) => [day.pisos.manana[2]] },
    { sector: "Pisos", label: "Mañana · Piso 3", values: (day) => [day.pisos.manana[3]] },
    { sector: "Pisos", label: "Tarde · Piso 1", values: (day) => [day.pisos.tarde[1]] },
    { sector: "Pisos", label: "Tarde · Piso 2", values: (day) => [day.pisos.tarde[2]] },
    { sector: "Pisos", label: "Tarde · Piso 3", values: (day) => [day.pisos.tarde[3]] },
  ];
  const offRows = [
    { sector: "Francos", label: "Cocina", values: (day) => day.francos.cocina, state: "off" },
    { sector: "Francos", label: "Pisos", values: (day) => day.francos.pisos, state: "off" },
  ];
  return `${pageHeading("SEMANA DE REFERENCIA · 29 JUN — 5 JUL 2026", "Grilla operativa", "Ejemplo manual de una semana real. Define el formato visual, no calcula semanas futuras.")}
    <div class="notice reference-notice"><span>ⓘ</span><div><strong>Referencia visual y funcional</strong><p>Esta distribución no modifica el ciclo F1/F2 ni funciona como regla de planificación automática.</p></div><b>NO CALCULADA</b></div>
    <div class="reference-sectors">
      ${referenceSectorBlock(reference, { key: "kitchen", icon: "🍳", eyebrow: "SECTOR OPERATIVO", title: "Cocina", description: "Producción y apoyo organizados por turno.", cornerLabel: "Turno", rows: kitchenRows })}
      ${referenceSectorBlock(reference, { key: "floors", icon: "🏥", eyebrow: "DISTRIBUCIÓN", title: "Pisos", description: "Cobertura de los tres pisos en ambos turnos.", cornerLabel: "Turno / piso", rows: floorRows })}
      ${referenceSectorBlock(reference, { key: "off", icon: "○", eyebrow: "DISPONIBILIDAD", title: "Francos", description: "Personal de Cocina y Pisos que no presta servicio ese día.", cornerLabel: "Área", rows: offRows })}
    </div>
    <div class="reference-legend"><span><i class="working"></i> Asignación habitual</span><span><i class="coverage"></i> Cobertura o colaboración</span><span><i class="exception"></i> Cobertura excepcional</span><span><i class="off"></i> Franco</span></div>`;
}

function referenceSectorBlock(reference, section) {
  return `<section class="reference-sector reference-sector-${section.key}" aria-labelledby="reference-${section.key}-title">
    <header class="reference-sector-head"><span class="reference-sector-icon" aria-hidden="true">${section.icon}</span><div><span class="reference-sector-eyebrow">${section.eyebrow}</span><h2 id="reference-${section.key}-title">${section.title}</h2><p>${section.description}</p></div></header>
    <div class="reference-board"><div class="reference-grid">
      <div class="reference-corner"><strong>${section.title}</strong><small>${section.cornerLabel}</small></div>
      ${reference.days.map((day) => `<header class="reference-day"><span>${day.shortLabel}</span><strong>${day.displayDate}</strong></header>`).join("")}
      ${section.rows.map((row) => `<div class="reference-row-label"><strong>${row.label}</strong><small>${section.title}</small></div>${reference.days.map((day) => `<div class="reference-cell">${row.values(day).filter(Boolean).map((person) => referencePerson(person, row.state)).join("")}</div>`).join("")}`).join("")}
    </div></div>
  </section>`;
}

function referencePerson(person, state = "") {
  const tone = state || person.kind || "working";
  return `<div class="reference-person ${tone}"><strong>${person.name}</strong>${person.note ? `<small>${person.note}</small>` : ""}</div>`;
}

function shiftCard(s, editable) {
  return `<button class="shift-card ${s.state}" ${editable ? `data-action="cycle-shift" data-id="${s.id}" title="Cambiar estado"` : "disabled"}><span class="avatar tiny">${initials(s.employee)}</span><span><strong>${s.employee.split(" ")[0]}</strong><small>${s.time}<br />${s.sector}</small></span><i></i></button>`;
}

function employeesPage() {
  if (!isAdminRole(user.role)) return staffDashboard();
  const canManage = canManageEmployees(user.role);
  const query = employeeSearch.toLowerCase();
  const rows = userRows().filter(({ user: rowUser, employee }) => {
    return [rowUser?.username, rowUser?.name, rowUser ? roleLabel[rowUser.role] : "Sin usuario", employee?.name, employee?.role, employee?.sector, employee?.turno]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(query));
  });
  const withAccess = state.users.filter((item) => item.employeeId && item.active !== false).length;
  return `<section class="people-page">
    <header class="people-page-header"><div><span class="eyebrow">DOTACIÓN</span><h1>Personal</h1><p>Directorio operativo, accesos y ubicación del equipo.</p></div><div class="people-page-actions"><span class="people-access-summary"><b>${withAccess}</b> accesos activos</span>${canManage ? `<button class="button primary" data-action="new-user">${icons.plus} Nuevo acceso</button>` : ""}</div></header>
    <section class="people-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input id="employee-search" placeholder="Buscar por nombre, rol, sector o turno…" value="${employeeSearch}" /></label><span class="people-result-count"><i></i>${rows.length} de ${state.employees.length} personas</span></section>
    ${usersAdminPanel(canManage, rows)}
  </section>`;
}

function userRows() {
  const linkedEmployeeIds = new Set();
  const rows = state.employees.map((employee) => {
    const rowUser = state.users.find((item) => item.employeeId === employee.id);
    if (rowUser) linkedEmployeeIds.add(employee.id);
    return { user: rowUser, employee };
  });
  state.users.forEach((rowUser) => {
    if (!rowUser.employeeId || linkedEmployeeIds.has(rowUser.employeeId)) return;
    rows.push({ user: rowUser, employee: state.employees.find((employee) => employee.id === rowUser.employeeId) || null });
  });
  return rows;
}

function usersAdminPanel(canManage, rows = userRows()) {
  return `<section class="people-table-panel"><div class="people-table-label"><div><strong>Directorio del equipo</strong><small>Gestioná los perfiles y accesos desde cada registro.</small></div><span>${rows.length} registros</span></div><div class="people-table-scroll"><table class="people-table"><thead><tr><th>Usuario</th><th>Persona</th><th>Rol empresa</th><th>Ubicación</th><th>Rol sistema</th><th>Gestión</th></tr></thead><tbody>${rows.map(({ user: rowUser, employee }) => {
      const rowId = rowUser?.id || employee?.id || "";
      const actions = !canManage ? "" : rowUser
        ? rowUser.active === false
          ? `<div class="table-actions"><button class="row-action" data-action="reactivate-user" data-id="${escapeHtml(rowUser.id)}">Reactivar</button></div>`
          : `<div class="table-actions"><button class="row-action" data-action="edit-user" data-id="${escapeHtml(rowUser.id)}">Editar</button><button class="row-action" data-action="reset-user-password" data-id="${escapeHtml(rowUser.id)}">Restablecer clave</button><button class="row-action danger" data-action="delete-user" data-id="${escapeHtml(rowUser.id)}">Desactivar</button></div>`
        : employee ? `<button class="row-action" data-action="create-user-for-employee" data-employee-id="${escapeHtml(employee.id)}">Crear acceso</button>` : "";
      return `<tr class="${rowUser?.active === false ? "is-inactive" : ""}"><td>${rowUser ? `<strong>${escapeHtml(rowUser.username)}</strong>${rowUser.active === false ? `<small class="access-status">Acceso desactivado</small>` : ""}` : `<span class="muted">Sin usuario</span>`}</td><td><div class="person-cell"><span class="avatar">${escapeHtml(employee?.initials || initials(rowUser?.name || rowUser?.username || "?"))}</span><div><strong>${escapeHtml(employee?.name || rowUser?.name || "Sin persona")}</strong><small>${escapeHtml(employee?.phone || "Sin teléfono")}</small></div></div></td><td>${escapeHtml(employee?.role || "Sin rol laboral")}</td><td>${employeeAssignment(employee || {})}</td><td>${rowUser ? escapeHtml(roleLabel[rowUser.role] || rowUser.role) : `<span class="muted">Sin acceso</span>`}</td><td>${actions || `<span class="muted">Sin permisos</span>`}</td></tr>`;
    }).join("")}</tbody></table>${rows.length ? "" : empty("No encontramos usuarios con esa búsqueda")}</div></section>`;
}

function employeeAssignment(employee) {
  const location = employee.piso ? `Piso ${employee.piso}` : employee.role === "Personal franquero" ? "Cobertura flexible" : employee.sector || "No operativo";
  return `<div class="employee-assignment"><strong>${employee.turno || "Sin turno fijo"}</strong><small>${location}</small></div>`;
}

function employeeFrancos(employee) {
  if (!employee.francos?.length) return `<span class="muted">Sin francos cargados</span>`;
  return `<details class="francos-details"><summary>${employee.francos.length} fechas cargadas</summary><div>${employee.francos.map((franco) => `<span class="franco-chip ${franco.tipo.toLowerCase()}"><b>${franco.tipo}</b> ${franco.fecha.slice(8, 10)}/${franco.fecha.slice(5, 7)}</span>`).join("")}</div></details>`;
}

function requestsPage() {
  const admin = isAdminRole(user.role);
  const visibleRequests = (admin ? state.requests : state.requests.filter((r) => r.employeeId === user.employeeId || r.partnerEmployeeId === user.employeeId)).map(normalizeRequestForView);
  const filtered = visibleRequests.filter((request) => requestMatchesFilter(request, requestFilter));
  const filters = [
    ["all", "Todas", "◉"],
    ["active", "En curso", "●"],
    ["waitingResponse", "Esperando respuesta", "↔"],
    ["approved", "Aprobadas", "✓"],
    ["rejected", "Rechazadas", "×"],
    ["history", "Historial", "◷"],
  ];
  return `${pageHeading("GESTIÓN", admin ? "Solicitudes" : "Mis solicitudes", admin ? "Revisá y resolvé los pedidos del equipo." : "Creá pedidos y seguí su resolución.", `<button class="button primary" data-action="new-request">${icons.plus} Nueva solicitud</button>`)}
    <div class="requests-layout">
      <aside class="request-filter-panel" aria-label="Filtros de solicitudes">
        <h2>Filtros</h2>
        <div class="request-filter-list">${filters.map(([id, label, icon]) => `<button class="request-filter-card ${requestFilter === id ? "active" : ""}" data-action="filter-request" data-filter="${id}" ${requestFilter === id ? 'aria-pressed="true"' : 'aria-pressed="false"'}><span class="request-filter-icon" aria-hidden="true">${icon}</span><span><strong>${label}</strong></span><b>${visibleRequests.filter((request) => requestMatchesFilter(request, id)).length}</b></button>`).join("")}</div>
      </aside>
      <section class="request-results-panel" aria-live="polite"><header class="request-results-head"><span>${filters.find(([id]) => id === requestFilter)?.[1] || "Solicitudes"}</span><b>${filtered.length}</b></header><div class="request-cards">${filtered.map((r) => requestCard(r, admin)).join("") || empty("No hay solicitudes en este estado")}</div></section>
    </div>`;
}

function requestCard(r, admin) {
  const request = normalizeRequestForView(r);
  const meta = requestMetaItems(request);
  return `<article class="request-card"><div class="request-card-top"><span class="request-icon large">${request.type === "absence" ? "+" : "↔"}</span><div><span class="request-id">${escapeHtml(request.id)}</span><h3>${escapeHtml(requestTypes[request.type] || request.type)}</h3><p>${escapeHtml(request.detail)}</p></div><span class="badge ${request.status}">${escapeHtml(statusText[request.status] || request.status)}</span></div><div class="request-meta"><span><small>SOLICITANTE</small><strong>${escapeHtml(request.employee)}</strong></span>${meta.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join("")}</div><div class="card-actions"><button class="button secondary" data-action="view-request" data-id="${request.id}">Ver detalle</button>${admin && canManagerResolveRequest(request) ? `<span class="muted">Requiere revisión</span>` : ""}</div></article>`;
}

function notificationsPage() {
  return `${pageHeading("CENTRO DE AVISOS", "Notificaciones", `${unreadCount()} novedades sin leer.`, unreadCount() ? `<button class="button secondary" data-action="read-all">Marcar todas como leídas</button>` : "")}
    <section class="notification-list">${state.notifications.map((n) => `<button class="notification ${n.read ? "read" : ""}" data-action="read-notification" data-id="${n.id}"><span class="notification-symbol ${n.type}">${n.type === "alert" ? "!" : n.type === "schedule" ? "▤" : "↔"}</span><span><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.text)}</p><small>${escapeHtml(n.time)}</small></span>${n.read ? "" : `<i></i>`}</button>`).join("") || empty("No tenés notificaciones")}</section>`;
}

function auditPage() {
  if (!canSeeAudit(user.role)) return dashboardPage();
  return `${pageHeading("TRAZABILIDAD", "Auditoría", "Registro de las acciones relevantes del sistema.")}
    <section class="table-card"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Elemento</th><th>Resultado</th></tr></thead><tbody>${state.auditLogs.map((a) => `<tr><td>${escapeHtml(a.time)}</td><td><strong>${escapeHtml(a.user)}</strong></td><td>${escapeHtml(a.action)}</td><td><span class="sector-pill">${escapeHtml(a.entity)}</span></td><td><span class="badge active">${escapeHtml(a.result)}</span></td></tr>`).join("")}</tbody></table></section>`;
}

function modal(content, variant = "", label = "Diálogo") {
  openModal(content, variant, label, escapeHtml);
}

function closeModal() {
  closeModalUi();
}

function busyModal(title, message) {
  modal(`<div class="busy-dialog" role="status" aria-live="assertive"><span class="spinner" aria-hidden="true"></span><div><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(message)}</p></div></div>`, "busy-modal", title);
}

function loginErrorModal(message) {
  modal(`<span class="dialog-icon error" aria-hidden="true">!</span><span class="eyebrow">NO PUDIMOS INGRESAR</span><h2>Revisá tus datos</h2><p class="muted">${escapeHtml(message)}</p><div class="modal-actions"><button class="button primary" data-action="close-login-error" autofocus>Reintentar</button></div>`, "error-modal", "Error de inicio de sesión");
}

function logoutConfirmationModal() {
  modal(`<span class="dialog-icon" aria-hidden="true">↪</span><span class="eyebrow">CERRAR SESIÓN</span><h2>¿Querés salir de Uzumaki?</h2><p class="muted">Tendrás que ingresar nuevamente para consultar la operación.</p><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button type="button" class="button danger-soft" data-action="perform-logout">Cerrar sesión</button></div>`, "confirm-modal", "Confirmar cierre de sesión");
}

function accountSessionModal() {
  modal(`<button class="modal-close" data-action="close-modal" aria-label="Cerrar">×</button><span class="eyebrow">MI CUENTA</span><h2>${escapeHtml(user.name)}</h2><p class="muted">${escapeHtml(roleLabel[user.role])} · ${escapeHtml(user.username)}</p><div class="account-session-actions"><button type="button" class="account-session-action" data-action="open-own-password-change"><span class="account-session-icon" aria-hidden="true">⌁</span><span><strong>Cambiar contraseña</strong><small>Actualizá tu clave de acceso.</small></span><span aria-hidden="true">›</span></button><button type="button" class="account-session-action account-session-action--logout" data-action="open-logout-confirmation"><span class="account-session-icon" aria-hidden="true">↪</span><span><strong>Cerrar sesión</strong><small>Salir de este dispositivo.</small></span><span aria-hidden="true">›</span></button></div>`, "account-modal", "Opciones de cuenta");
}

function ownPasswordChangeModal() {
  modal(`<button class="modal-close" data-action="close-modal" aria-label="Cerrar">×</button><span class="eyebrow">SEGURIDAD DE LA CUENTA</span><h2>Cambiar contraseña</h2><p class="muted">Confirmá tu contraseña actual y definí una nueva para proteger tu acceso.</p><form id="own-password-change-form"><label>Contraseña actual<input name="currentPassword" type="password" autocomplete="current-password" required autofocus /></label><label>Nueva contraseña<input name="newPassword" type="password" minlength="10" autocomplete="new-password" required /></label><label>Confirmar nueva contraseña<input name="confirmPassword" type="password" minlength="10" autocomplete="new-password" required /></label><div class="week-form-note"><strong>Sesiones protegidas</strong><p>Usá al menos 10 caracteres. Al guardar se cerrarán las otras sesiones activas de tu cuenta.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="open-account-session">Volver</button><button class="button primary">Guardar contraseña</button></div></form>`, "account-modal", "Cambiar contraseña");
}

function clearClientSession() {
  clearCachedState();
  [SESSION_KEY, "uzumaki-user-v4", "uzumaki-user-v3", "uzumaki-user-v2", "uzumaki-user", "turnia-user"].forEach((key) => sessionStorage.removeItem(key));
}

function exportStateJson() {
  const blob = new Blob([serializeState(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = STATE_FILE_NAME;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("Archivo JSON generado");
}

function importStateJson() {
  if (!canEditApplications(user.role)) return toast("Solo una encargada puede importar datos.", "error");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const importedState = hydrateStateFromJson(await file.text());
      importedState.stateRevision = state.stateRevision;
      state = importedState;
      audit("Importó datos desde JSON", file.name, "Datos restaurados");
      persist();
      toast("Datos importados correctamente");
    } catch {
      toast("El archivo JSON no tiene un formato válido.", "error");
    }
  }, { once: true });
  input.click();
}

function updateRequestFormSections(form) {
  if (!form) return;
  const type = form.elements.type.value;
  const isChange = ["dayOffChange", "shiftChange"].includes(type);
  const singleSection = form.querySelector('[data-request-section="single"]');
  const changeSection = form.querySelector('[data-request-section="change"]');
  singleSection.hidden = isChange;
  changeSection.hidden = !isChange;
  ["targetDate", "targetShift"].forEach((name) => {
    form.elements[name].required = !isChange;
  });
  ["originalDate", "originalShift", "proposedDate", "proposedShift"].forEach((name) => {
    form.elements[name].required = isChange;
  });
  form.elements.partnerEmployeeId.required = isChange;
}

function newRequestModal() {
  const activeEmployees = state.employees.filter((employee) => employee.status === "active" && employee.participaEnOperacion !== false && employee.id !== user.employeeId);
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">NUEVA SOLICITUD</span><h2>¿Qué necesitás gestionar?</h2><p class="muted">La solicitud quedará registrada con fecha y turno para automatización futura.</p><form id="request-form"><label>Tipo<select name="type" required>${Object.entries(requestTypes).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label><div data-request-section="single"><div class="form-row"><label>Fecha<input name="targetDate" type="date" /></label><label>Turno<select name="targetShift">${shiftOptions.map((shift) => `<option value="${shift}">${shift}</option>`).join("")}</select></label></div></div><div data-request-section="change" hidden><div class="form-row"><label>Fecha original<input name="originalDate" type="date" /></label><label>Turno original<select name="originalShift">${shiftOptions.map((shift) => `<option value="${shift}">${shift}</option>`).join("")}</select></label></div><div class="form-row"><label>Fecha propuesta<input name="proposedDate" type="date" /></label><label>Turno propuesto<select name="proposedShift">${shiftOptions.map((shift) => `<option value="${shift}">${shift}</option>`).join("")}</select></label></div><label>Compañero involucrado<select name="partnerEmployeeId"><option value="">Sin compañero</option>${activeEmployees.map((employee) => `<option value="${employee.id}">${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`).join("")}</select></label></div><label>Motivo o detalle<textarea name="note" rows="3" placeholder="Contanos brevemente el motivo" required></textarea></label><label class="file-label">Certificado o respaldo (opcional)<input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png" /><span>Adjuntar archivo</span></label><div class="week-form-note"><strong>Datos para aprobación futura</strong><p>La aprobación todavía no modifica la grilla. Estos campos dejan preparada la solicitud para automatizar ese impacto más adelante.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">Enviar solicitud</button></div></form>`);
  updateRequestFormSections(document.querySelector("#request-form"));
}

function requestDetailModal(requestId) {
  const storedRequest = state.requests.find((item) => item.id === requestId);
  if (!storedRequest) return toast("No se encontró la solicitud.", "error");
  const request = normalizeRequestForView(storedRequest);
  if (!canViewRequestDetail(request)) return toast("No tenés permiso para ver esta solicitud.", "error");
  const rows = [
    ["Solicitante", request.employee || "Sin solicitante"],
    ["Tipo", requestTypes[request.type] || request.type],
    ["Estado", statusText[request.status] || request.status],
    ...requestMetaItems(request),
    ["Motivo / detalle", request.note || request.detail || "Sin detalle"],
  ];
  const partnerActions = canActAsPartner(request)
    ? `<button class="button danger-soft" data-action="partner-resolve" data-id="${request.id}" data-status="partnerRejected">Rechazar</button><button class="button primary" data-action="partner-resolve" data-id="${request.id}" data-status="partnerAccepted">Aceptar</button>`
    : "";
  const managerActions = canManagerResolveRequest(request)
    ? `<button class="button danger-soft" data-action="resolve" data-id="${request.id}" data-status="rejected">Rechazar</button><button class="button primary" data-action="resolve" data-id="${request.id}" data-status="approved">Aprobar</button>`
    : "";
  const revokeAction = "";
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">SOLICITUD</span><h2>${escapeHtml(request.id)}</h2><p class="muted">Detalle completo para revisión. Las licencias y ausencias aprobadas se aplican automáticamente con el reemplazo elegido.</p><div class="request-meta request-detail">${rows.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join("")}</div>${requestImpactPreview(request)}<div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cerrar</button>${partnerActions}${managerActions}${revokeAction}</div>`);
}

function revokeRequestModal(requestId) {
  const storedRequest = state.requests.find((item) => item.id === requestId);
  const request = storedRequest ? normalizeRequestForView(storedRequest) : null;
  if (!request || !canRevokeRequest(request)) return toast("No se puede revocar esta solicitud.", "error");
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">REVOCACIÓN</span><h2>Revocar ${escapeHtml(request.id)}</h2><p class="muted">El Motor de Planificación intentará revertir el impacto automáticamente solo si es seguro.</p><form id="request-revoke-form"><input type="hidden" name="requestId" value="${escapeHtml(request.id)}" /><label>Motivo de revocación<textarea name="reason" rows="4" placeholder="Indicá por qué se revoca esta aprobación" required></textarea></label><div class="week-form-note"><strong>Reversión segura</strong><p>Si la grilla cambió después de la aprobación, no se modificará automáticamente y quedará marcada para revisión manual.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button danger-soft">Revocar aprobación</button></div></form>`);
}

function selectOptions(options, selected = "") {
  return options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
}

function companyRoleSelectOptions(selected = "") {
  return selectOptions(companyRoleOptions.map((role) => ({ value: role, label: role })), selected);
}

function shiftSelectOptions(selected = "") {
  return `<option value="" ${selected ? "" : "selected"}>Flexible / sin turno</option>${selectOptions(shiftOptions.map((shift) => ({ value: shift, label: shift })), selected)}`;
}

function sectorSelectOptions(selected = "") {
  return selectOptions([
    { value: "", label: "No operativo" },
    { value: "Cocina", label: "Cocina" },
    { value: "Pisos", label: "Pisos" },
  ], selected || "");
}

function floorSelectOptions(selected = "") {
  return selectOptions([
    { value: "", label: "Sin piso fijo" },
    { value: "1", label: "Piso 1" },
    { value: "2", label: "Piso 2" },
    { value: "3", label: "Piso 3" },
  ], selected ? String(selected) : "");
}

function systemRoleSelectOptions(selected = "staff") {
  const options = [
    { value: "staff", label: "Personal operativo" },
    { value: "manager", label: "Encargada" },
    { value: "supervisor", label: "Supervisión" },
    { value: "admin", label: "Administración principal" },
  ];
  return selectOptions(user?.role === "manager" ? options.filter((item) => ["staff", "supervisor"].includes(item.value)) : options, selected);
}

function newUserModal() {
  if (!canManageEmployees(user.role)) return toast("Solo una encargada puede crear usuarios.", "error");
  userModal();
}

function editUserModal(userId) {
  if (!canManageEmployees(user.role)) return toast("Solo una encargada puede editar usuarios.", "error");
  const targetUser = state.users.find((item) => item.id === userId);
  if (!targetUser) return toast("No se encontró el usuario.", "error");
  userModal(targetUser);
}

function createUserForEmployeeModal(employeeId) {
  if (!canManageEmployees(user.role)) return toast("Solo una encargada puede crear usuarios.", "error");
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return toast("No se encontró la persona.", "error");
  userModal(null, employee);
}

function userModal(targetUser = null, linkedEmployee = null) {
  const employee = targetUser ? state.employees.find((item) => item.id === targetUser.employeeId) : linkedEmployee;
  const isEditing = Boolean(targetUser);
  const username = targetUser?.username || (employee ? slugify(employee.name).split("-")[0] : "");
  const name = employee?.name || targetUser?.name || "";
  const companyRole = employee?.role || companyRoleOptions[0];
  const systemRole = targetUser?.role || "staff";
  const sector = employee?.sector || "";
  const turno = employee?.turno || "";
  const piso = employee?.piso || "";
  const phone = employee?.phone || "";
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">${isEditing ? "EDITAR USUARIO" : "NUEVO USUARIO"}</span><h2>${isEditing ? "Editar usuario" : "Agregar usuario"}</h2><p class="muted">${isEditing ? "Los datos del perfil y el acceso se administran por separado." : "Se crea el acceso a la app con sus datos laborales en una sola operación."}</p><form id="user-form"><input type="hidden" name="userId" value="${escapeHtml(targetUser?.id || "")}" /><input type="hidden" name="employeeId" value="${escapeHtml(employee?.id || "")}" /><div class="form-row"><label>Usuario<input name="username" autocomplete="off" value="${escapeHtml(username)}" required /></label>${isEditing ? "" : `<label>Contraseña inicial<input name="password" type="password" minlength="10" autocomplete="new-password" required /></label>`}</div><label>Nombre completo<input name="name" value="${escapeHtml(name)}" required /></label><div class="form-row"><label>Rol del sistema<select name="systemRole" required>${systemRoleSelectOptions(systemRole)}</select></label><label>Rol dentro de la empresa<select name="companyRole" required>${companyRoleSelectOptions(companyRole)}</select></label></div><div class="form-row"><label>Sector<select name="sector">${sectorSelectOptions(sector)}</select></label><label>Turno<select name="turno">${shiftSelectOptions(turno)}</select></label></div><div class="form-row"><label>Piso<select name="piso">${floorSelectOptions(piso)}</select></label><label>Teléfono<input name="phone" value="${escapeHtml(phone)}" /></label></div><div class="week-form-note"><strong>Roles y acceso separados</strong><p>El rol del sistema define permisos. Para restablecer una contraseña usá la acción específica desde el directorio.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">${isEditing ? "Guardar cambios" : "Guardar usuario"}</button></div></form>`);
}

function resetUserPasswordModal(userId) {
  if (!canManageEmployees(user.role)) return toast("Solo Administración y Encargada pueden restablecer accesos.", "error");
  const targetUser = state.users.find((item) => item.id === userId);
  if (!targetUser) return toast("No se encontró el usuario.", "error");
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">RESTABLECER ACCESO</span><h2>${escapeHtml(targetUser.name || targetUser.username)}</h2><p class="muted">Definí una contraseña temporal. Se cerrarán sus sesiones y deberá crear una nueva al ingresar.</p><form id="reset-user-password-form"><input type="hidden" name="userId" value="${escapeHtml(targetUser.id)}" /><label>Contraseña temporal<input name="newPassword" type="password" minlength="10" autocomplete="new-password" required autofocus /></label><label>Confirmar contraseña<input name="confirmPassword" type="password" minlength="10" autocomplete="new-password" required /></label><label>Motivo <small class="muted">(opcional, quedará auditado)</small><textarea name="reason" rows="2" maxlength="240" placeholder="Ej.: restablecimiento solicitado por la persona"></textarea></label><div class="week-form-note"><strong>Acción sensible</strong><p>La contraseña no se registra ni se vuelve a mostrar en la aplicación.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button danger-soft">Restablecer acceso</button></div></form>`);
}

function forcePasswordChangeModal() {
  modal(`<span class="eyebrow">SEGURIDAD DE LA CUENTA</span><h2>Creá tu nueva contraseña</h2><p class="muted">Tu acceso fue restablecido. Para continuar necesitás reemplazar la contraseña temporal.</p><form id="force-password-change-form"><label>Contraseña temporal<input name="currentPassword" type="password" autocomplete="current-password" required autofocus /></label><label>Nueva contraseña<input name="newPassword" type="password" minlength="10" autocomplete="new-password" required /></label><label>Confirmar nueva contraseña<input name="confirmPassword" type="password" minlength="10" autocomplete="new-password" required /></label><div class="week-form-note"><strong>Requisito mínimo</strong><p>Usá al menos 10 caracteres. Al guardar se cerrarán las otras sesiones de tu cuenta.</p></div><div class="modal-actions"><button class="button primary">Guardar y continuar</button></div></form>`, "mandatory-modal", "Cambio obligatorio de contraseña");
}

function newPlanningWeekModal() {
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">NUEVA SEMANA</span><h2>Crear semana de planificación</h2><p class="muted">Se creará la estructura operativa vacía en estado Borrador.</p><form id="planning-week-form"><label>Nombre o identificador<input name="name" placeholder="Ej: Semana del 6 al 12 de julio" required /></label><div class="form-row"><label>Fecha de inicio<input name="startDate" type="date" required /></label><label>Fecha de fin<input name="endDate" type="date" readonly required /></label></div><div class="week-form-note"><strong>Semana de 7 días</strong><p>Al elegir la fecha de inicio, la fecha de fin se calcula automáticamente 6 días después.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">Crear borrador</button></div></form>`);
}

function assignmentModal(positionId) {
  const week = state.planningWeek;
  if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  const position = week.operationalPositions.find((item) => item.id === positionId);
  if (!position) return;
  const assignment = week.assignments.find((item) => item.positionId === positionId);
  const availableEmployees = state.employees.filter((employee) => employee.status === "active" && employee.participaEnOperacion !== false);
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">ASIGNACIÓN MANUAL</span><h2>${position.label}</h2><p class="muted">${formatIsoDate(position.date)} · Turno ${position.shift} · ${position.sector}</p><form id="position-assignment-form"><input type="hidden" name="positionId" value="${position.id}" /><label>Empleado<select name="employeeId" required><option value="">Seleccionar empleado</option>${availableEmployees.map((employee) => `<option value="${employee.id}" ${assignment?.employeeId === employee.id ? "selected" : ""}>${employee.name} · ${employee.role}</option>`).join("")}</select></label><div class="week-form-note"><strong>Asignación manual</strong><p>La lista muestra el equipo activo. La aplicación bloquea dobles asignaciones en el mismo día.</p></div><div class="modal-actions">${assignment ? `<button type="button" class="button danger-soft" data-action="remove-planning-assignment" data-position-id="${position.id}">Quitar asignación</button>` : ""}<button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">${assignment ? "Cambiar empleado" : "Asignar empleado"}</button></div></form>`, "assignment-drawer");
}

function dayOffModal({ sector, date }) {
  const week = state.planningWeek;
  if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  const availableEmployees = state.employees.filter((employee) => employee.status === "active" && employee.participaEnOperacion !== false && employee.sector === sector);
  const currentDayOffs = (week.daysOff || []).filter((item) => item.sector === sector && item.date === date);
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">FRANCO MANUAL</span><h2>Francos ${sector}</h2><p class="muted">${formatIsoDate(date)} · Grilla ${planningWeekStatusLabel(week.status)}</p><form id="planning-day-off-form"><input type="hidden" name="sector" value="${sector}" /><input type="hidden" name="date" value="${date}" /><label>Empleado<select name="employeeId" required><option value="">Seleccionar empleado</option>${availableEmployees.map((employee) => `<option value="${employee.id}">${employee.name} · ${employee.role}</option>`).join("")}</select></label><label>Tipo de franco<select name="tipo" required><option value="F1">F1</option><option value="F2">F2</option></select></label><div class="week-form-note"><strong>Carga manual</strong><p>Este dato se guarda solo dentro de la semana. No modifica los francos base ni calcula el ciclo F1/F2.</p>${currentDayOffs.length ? `<p><strong>Ya cargados:</strong> ${currentDayOffs.map((dayOff) => {
    const employee = state.employees.find((item) => item.id === dayOff.employeeId);
    return `${employee?.name || "Empleado"} (${dayOff.tipo})`;
  }).join(" · ")}</p><div class="remove-list">${currentDayOffs.map((dayOff) => {
    const employee = state.employees.find((item) => item.id === dayOff.employeeId);
    return `<button type="button" class="row-action danger" data-action="remove-planning-day-off" data-day-off-id="${dayOff.id}">Quitar ${employee?.name || "franco"} (${dayOff.tipo})</button>`;
  }).join("")}</div>` : ""}</div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">Guardar franco</button></div></form>`);
}

function weekExceptionModal(exceptionId = "") {
  const week = state.planningWeek;
  if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  if (!Array.isArray(week.exceptions)) week.exceptions = [];
  const exception = week.exceptions.find((item) => item.id === exceptionId);
  const selectedPosition = exception
    ? week.operationalPositions.find((position) => position.id === exception.positionId)
    : week.operationalPositions[0];
  const selectedAssignment = selectedPosition ? week.assignments.find((assignment) => assignment.positionId === selectedPosition.id) : null;
  const affectedEmployeeValue = exception ? exception.affectedEmployeeId || "unassigned" : selectedAssignment?.employeeId || "unassigned";
  const activeEmployees = state.employees.filter((employee) => employee.status === "active" && employee.participaEnOperacion !== false);
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  const shifts = [...new Set(week.operationalPositions.map((position) => position.shift))];
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">EXCEPCIÓN SEMANAL</span><h2>${exception ? "Editar excepción" : "Registrar excepción"}</h2><p class="muted">Este ajuste queda guardado solo en esta semana. No modifica la grilla base.</p><form id="week-exception-form"><input type="hidden" name="exceptionId" value="${escapeHtml(exception?.id || "")}" /><div class="form-row"><label>Día<select name="date" required>${dates.map((date) => `<option value="${date}" ${selectedPosition?.date === date ? "selected" : ""}>${formatIsoDate(date)}</option>`).join("")}</select></label><label>Turno<select name="shift" required>${shifts.map((shift) => `<option value="${shift}" ${selectedPosition?.shift === shift ? "selected" : ""}>${shift}</option>`).join("")}</select></label></div><label>Puesto<select name="positionId" required>${exceptionPositionOptions(week, selectedPosition?.date, selectedPosition?.shift, selectedPosition?.id)}</select></label><label>Persona afectada<select name="affectedEmployeeId" required><option value="unassigned" ${affectedEmployeeValue === "unassigned" ? "selected" : ""}>Puesto sin persona asignada</option>${activeEmployees.map((employee) => `<option value="${employee.id}" ${affectedEmployeeValue === employee.id ? "selected" : ""}>${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`).join("")}</select></label><label>Tipo de excepción<select name="type" required>${Object.entries(exceptionTypes).map(([value, label]) => `<option value="${value}" ${exception?.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Quién cubre el turno<select name="coverEmployeeId"><option value="">Sin cobertura indicada</option>${activeEmployees.map((employee) => `<option value="${employee.id}" ${exception?.coverEmployeeId === employee.id ? "selected" : ""}>${escapeHtml(employee.name)} · ${escapeHtml(employee.role)}</option>`).join("")}</select></label><label>Observación<textarea name="note" rows="3" placeholder="Ej: certificado pendiente, cambio acordado, se deja sin cubrir">${escapeHtml(exception?.note || "")}</textarea></label><div class="week-form-note"><strong>Registro simple</strong><p>La excepción queda visible sobre la celda de la grilla y se puede editar o eliminar. No bloquea la publicación.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">${exception ? "Guardar cambios" : "Guardar excepción"}</button></div></form>`);
}

function exceptionPositionOptions(week, date, shift, selectedId = "") {
  return week.operationalPositions
    .filter((position) => (!date || position.date === date) && (!shift || position.shift === shift))
    .map((position) => `<option value="${position.id}" ${position.id === selectedId ? "selected" : ""}>${position.label} · ${position.sector}${position.floor ? ` · Piso ${position.floor}` : ""}</option>`)
    .join("");
}

function updateExceptionPositionOptions(form) {
  const week = state.planningWeek;
  const select = form.querySelector('select[name="positionId"]');
  if (!week || !select) return;
  const current = select.value;
  select.innerHTML = exceptionPositionOptions(week, form.elements.date.value, form.elements.shift.value, current);
  if (![...select.options].some((option) => option.value === current)) select.selectedIndex = 0;
  updateExceptionAffectedEmployee(form);
}

function updateExceptionAffectedEmployee(form) {
  const week = state.planningWeek;
  if (!week) return;
  const position = week.operationalPositions.find((item) => item.id === form.elements.positionId.value);
  const assignment = position ? week.assignments.find((item) => item.positionId === position.id) : null;
  const affectedSelect = form.querySelector('select[name="affectedEmployeeId"]');
  if (!affectedSelect || affectedSelect.dataset.touched === "true") return;
  affectedSelect.value = assignment?.employeeId || "unassigned";
}

function initials(name) { return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase(); }
function slugify(value) { return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function uniqueId(prefix, seed, collection) {
  const base = `${prefix}-${slugify(seed) || "nuevo"}`;
  let candidate = base;
  let index = 2;
  while (collection.some((item) => item.id === candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}
function roleIdFor(role) {
  return {
    "Personal de cocina": "rol-cocinero",
    "Ayudante de cocina": "rol-peon-cocina",
    "Personal de camarería": "rol-camarera",
    "Personal franquero": "rol-franquera",
    "Encargada/Nutrición": "rol-nutricionista",
    Cocinero: "rol-cocinero",
    "Peón de cocina": "rol-peon-cocina",
    Camarera: "rol-camarera",
    Franquera: "rol-franquera",
    "Encargada/Nutricionista": "rol-nutricionista",
  }[role] || null;
}
function sectorIdFor(sector) {
  return { Cocina: "sec-cocina", Pisos: "sec-pisos" }[sector] || null;
}
function turnoIdFor(turno) {
  return { Mañana: "turno-manana", Tarde: "turno-tarde" }[turno] || null;
}
function systemRoleFor(role, participaEnOperacion) {
  if (role === "Encargada/Nutrición") return "Encargada";
  if (role === "Supervisión") return "Supervisión";
  if (role === "Encargada/Nutricionista") return "Encargada";
  if (role === "Supervisora") return "Supervisión";
  return participaEnOperacion ? "Personal" : "Administrativo";
}
function formatIsoDate(value) { const [year, month, day] = value.split("-"); return `${day}/${month}/${year}`; }
function localIsoDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function addIsoDays(value, amount) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}
function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}
function hasSameDayAssignment(week, position, employeeId) {
  return (week.assignments || []).some((assignment) => {
    if (assignment.positionId === position.id || assignment.employeeId !== employeeId) return false;
    const assignedPosition = week.operationalPositions.find((item) => item.id === assignment.positionId);
    return assignedPosition?.date === position.date;
  });
}
function unreadCount() { return state.notifications.filter((n) => !n.read).length; }
function empty(message) { return `<div class="empty-state"><span>◇</span><p>${message}</p></div>`; }

function waitForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function loginAsDemoUser(match, options = {}) {
  const { promptPasswordChange = true } = options;
  user = match;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  sessionStorage.removeItem("uzumaki-user-v3");
  sessionStorage.removeItem("uzumaki-user-v2");
  sessionStorage.removeItem("uzumaki-user");
  sessionStorage.removeItem("turnia-user");
  page = "dashboard";
  state = match.mustChangePassword ? await loadState({ remote: false }) : await loadState();
  render();
  if (promptPasswordChange && match.mustChangePassword) forcePasswordChangeModal();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "login-form") {
    const data = new FormData(event.target);
    const username = data.get("username").trim().toLowerCase();
    const submit = event.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    event.target.querySelectorAll("input").forEach((input) => { input.disabled = true; });
    busyModal("Ingresando", "Estamos validando tu acceso.");
    try {
      const match = await authenticate(username, data.get("password"));
      await loginAsDemoUser(match, { promptPasswordChange: false });
      await waitForPaint();
      closeModal();
      if (match.mustChangePassword) forcePasswordChangeModal();
      return undefined;
    } catch (error) {
      closeModal();
      renderLogin("", username);
      loginErrorModal(error.message || "Usuario o contraseña incorrectos.");
      return undefined;
    }
  }
  if (event.target.id === "request-form") {
    const data = new FormData(event.target);
    const employee = state.employees.find((e) => e.id === user.employeeId);
    if (!employee) return toast("El usuario no está vinculado a un empleado.", "error");
    const type = data.get("type");
    const note = data.get("note").trim();
    if (!requestTypes[type] || !note) return toast("Completá los datos obligatorios de la solicitud.", "error");
    const isChange = ["dayOffChange", "shiftChange"].includes(type);
    const partnerEmployeeId = data.get("partnerEmployeeId");
    if (isChange && (!data.get("originalDate") || !data.get("proposedDate"))) return toast("Completá fecha original y fecha propuesta.", "error");
    if (!isChange && !data.get("targetDate")) return toast("Seleccioná la fecha de la solicitud.", "error");
    if (isChange && !partnerEmployeeId) return toast("Los cambios de franco o turno requieren compañero involucrado.", "error");
    if (partnerEmployeeId && !state.employees.some((item) => item.id === partnerEmployeeId && item.status === "active" && item.participaEnOperacion !== false)) return toast("El compañero seleccionado no es válido.", "error");
    const scheduleImpact = isChange
      ? {
        original: { date: data.get("originalDate"), shift: data.get("originalShift") },
        proposed: { date: data.get("proposedDate"), shift: data.get("proposedShift") },
      }
      : {
        target: { date: data.get("targetDate"), shift: data.get("targetShift") },
      };
    const detail = isChange
      ? `${formatIsoDate(scheduleImpact.original.date)} ${scheduleImpact.original.shift} → ${formatIsoDate(scheduleImpact.proposed.date)} ${scheduleImpact.proposed.shift}`
      : `${formatIsoDate(scheduleImpact.target.date)} · ${scheduleImpact.target.shift}`;
    const status = isChange ? "pendingPartner" : "pendingManager";
    try {
      await apiCommand("/api/requests", { type, note, partnerEmployeeId, scheduleImpact });
      closeModal();
      toast("Solicitud enviada correctamente");
    } catch (error) { toast(error.message, "error"); }
  }
  if (event.target.id === "request-revoke-form") {
    const data = new FormData(event.target);
    const request = state.requests.find((item) => item.id === data.get("requestId"));
    const normalizedRequest = request ? normalizeRequestForView(request) : null;
    const reason = data.get("reason").trim();
    if (!request || !canRevokeRequest(normalizedRequest)) return toast("No se puede revocar esta solicitud.", "error");
    if (!reason) return toast("Indicá un motivo de revocación.", "error");
    if (!confirm("¿Confirmás la revocación? Las solicitudes aprobadas quedarán marcadas para revisión operativa.")) return;
    try {
      const result = await apiCommand(`/api/requests/${encodeURIComponent(request.id)}/revoke`, { reason });
      closeModal();
      toast(result.requiresManualReview ? "Solicitud revocada: revisá el impacto en la grilla." : "Solicitud revocada");
    } catch (error) { toast(error.message, "error"); }
  }
  if (event.target.id === "planning-week-form") {
    if (!canEditSchedule(user.role)) return;
    const data = new FormData(event.target);
    const name = data.get("name").trim();
    const startDate = data.get("startDate");
    const endDate = addIsoDays(startDate, 6);
    if (!name) return toast("Ingresá un nombre para la semana.", "error");
    if (data.get("endDate") && data.get("endDate") !== endDate) return toast("La semana debe durar exactamente 7 días.", "error");
    try {
      await apiCommand("/api/planning/weeks", { name, startDate });
      planningView = "editor";
      closeModal();
      toast("Semana creada como borrador");
    } catch (error) { toast(error.message, "error"); }
  }
  if (event.target.id === "position-assignment-form") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    const data = new FormData(event.target);
    const positionId = data.get("positionId");
    const employeeId = data.get("employeeId");
    const position = week.operationalPositions.find((item) => item.id === positionId);
    const employee = state.employees.find((item) => item.id === employeeId && item.status === "active" && item.participaEnOperacion !== false);
    if (!position || !employee) return toast("No se pudo guardar la asignación.", "error");
    if (hasSameDayAssignment(week, position, employeeId)) return toast(`${employee.name} ya está asignado ese día.`, "error");
    try {
      await apiCommand("/api/planning/assignments", { weekId: week.id, positionId, employeeId, version: week.version });
      closeModal();
      toast(`${employee.name} fue asignado al puesto`);
    } catch (error) { toast(error.message, "error"); }
  }
  if (event.target.id === "planning-day-off-form") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    const data = new FormData(event.target);
    const sector = data.get("sector");
    const date = data.get("date");
    const employeeId = data.get("employeeId");
    const tipo = data.get("tipo");
    const employee = state.employees.find((item) => item.id === employeeId && item.status === "active" && item.participaEnOperacion !== false && item.sector === sector);
    if (!["Cocina", "Pisos"].includes(sector) || !["F1", "F2"].includes(tipo) || !employee) return toast("No se pudo guardar el franco.", "error");
    try {
      await apiCommand("/api/planning/days-off", { weekId: week.id, employeeId, date, sectorId: employee.sectorId, type: tipo, version: week.version });
      closeModal();
      toast(`Franco ${tipo} cargado para ${employee.name}`);
    } catch (error) { toast(error.message, "error"); }
  }
  if (event.target.id === "week-exception-form") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    const data = new FormData(event.target);
    const exceptionId = data.get("exceptionId");
    const position = week.operationalPositions.find((item) => item.id === data.get("positionId"));
    const type = data.get("type");
    const affectedEmployeeId = data.get("affectedEmployeeId") === "unassigned" ? "" : data.get("affectedEmployeeId");
    const coverEmployeeId = data.get("coverEmployeeId");
    if (!position || position.date !== data.get("date") || position.shift !== data.get("shift") || !exceptionTypes[type]) return toast("No se pudo guardar la excepción.", "error");
    if (affectedEmployeeId && !state.employees.some((employee) => employee.id === affectedEmployeeId)) return toast("La persona afectada no es válida.", "error");
    if (coverEmployeeId && !state.employees.some((employee) => employee.id === coverEmployeeId)) return toast("La cobertura indicada no es válida.", "error");
    const note = data.get("note").trim();
    const existing = week.exceptions.find((item) => item.id === exceptionId);
    try {
      await apiCommand("/api/planning/exceptions", { id: exceptionId || undefined, weekId: week.id, positionId: position.id, affectedEmployeeId, coverEmployeeId, type, note, version: week.version });
      closeModal(); toast(existing ? "Excepción actualizada" : "Excepción registrada");
    } catch (error) { toast(error.message, "error"); }
  }
  if (event.target.id === "user-form") {
    if (!canManageEmployees(user.role)) return toast("Solo una encargada puede crear usuarios.", "error");
    const data = new FormData(event.target);
    const submit = event.target.querySelector('button[type="submit"], .modal-actions .button.primary');
    const userId = data.get("userId");
    const employeeId = data.get("employeeId");
    const username = data.get("username").trim().toLowerCase();
    const password = data.get("password");
    const name = data.get("name").trim();
    const role = data.get("systemRole");
    const companyRole = data.get("companyRole");
    const sector = data.get("sector");
    const turno = data.get("turno");
    const participaEnOperacion = operationalCompanyRoles.includes(companyRole);
    if (!username || (!userId && !password) || !name || !role || !companyRole) return toast("Completá usuario, contraseña, nombre y roles.", "error");
    try {
      if (submit) submit.disabled = true;
      const payload = { username, password, name, systemRole: role, companyRole, sector, turno, piso: data.get("piso") || null, phone: data.get("phone").trim(), employeeId };
      if (userId) delete payload.password;
      await apiCommand(userId ? `/api/users/${encodeURIComponent(userId)}/profile` : "/api/users", payload);
      closeModal();
      toast(userId ? "Usuario actualizado" : "Usuario creado");
    } catch (error) {
      if (submit) submit.disabled = false;
      toast(error.message, "error");
    }
  }
  if (event.target.id === "reset-user-password-form") {
    const data = new FormData(event.target);
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== data.get("confirmPassword")) return toast("Las contraseñas no coinciden.", "error");
    try {
      await apiCommand(`/api/users/${encodeURIComponent(data.get("userId"))}/reset-password`, { newPassword, reason: String(data.get("reason") || "") });
      closeModal();
      toast("Acceso restablecido: deberá cambiar la contraseña al ingresar.");
    } catch (error) { toast(error.message, "error"); }
  }
  if (["force-password-change-form", "own-password-change-form"].includes(event.target.id)) {
    const data = new FormData(event.target);
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== data.get("confirmPassword")) return toast("Las contraseñas no coinciden.", "error");
    const submit = event.target.querySelector('button[type="submit"], .modal-actions .button.primary');
    try {
      if (submit) submit.disabled = true;
      await apiCommand("/api/me/change-password", { currentPassword: String(data.get("currentPassword") || ""), newPassword }, "POST", {}, false);
      user = { ...user, mustChangePassword: false };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
      closeModal();
      render();
      toast("Contraseña actualizada. Las demás sesiones se cerraron.");
    } catch (error) {
      if (submit) submit.disabled = false;
      toast(error.message, "error");
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "employee-search") { employeeSearch = event.target.value; render(); document.querySelector("#employee-search")?.focus(); }
  if (event.target.name === "startDate" && event.target.closest("#planning-week-form")) {
    const endDateInput = event.target.form.querySelector('input[name="endDate"]');
    endDateInput.value = event.target.value ? addIsoDays(event.target.value, 6) : "";
  }
  if (event.target.closest("#week-exception-form") && ["date", "shift", "positionId"].includes(event.target.name)) {
    updateExceptionPositionOptions(event.target.form);
  }
  if (event.target.closest("#request-form") && event.target.name === "type") {
    updateRequestFormSections(event.target.form);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches('[data-action="planning-focus-employee"]')) {
    planningFocusedEmployeeId = event.target.value || null;
    render();
    return;
  }
  if (event.target.name === "planning-week-selection") {
    if (!canEditSchedule(user.role)) return;
    if (event.target.checked) selectedPlanningWeekIds.add(event.target.value);
    else selectedPlanningWeekIds.delete(event.target.value);
    render();
    return;
  }
  if (event.target.name === "startDate" && event.target.closest("#planning-week-form")) {
    const endDateInput = event.target.form.querySelector('input[name="endDate"]');
    endDateInput.value = event.target.value ? addIsoDays(event.target.value, 6) : "";
  }
  if (event.target.closest("#week-exception-form") && ["date", "shift"].includes(event.target.name)) {
    updateExceptionPositionOptions(event.target.form);
  }
  if (event.target.closest("#week-exception-form") && event.target.name === "positionId") {
    updateExceptionAffectedEmployee(event.target.form);
  }
  if (event.target.closest("#week-exception-form") && event.target.name === "affectedEmployeeId") {
    event.target.dataset.touched = "true";
  }
  if (event.target.closest("#request-form") && event.target.name === "type") {
    updateRequestFormSections(event.target.form);
  }
});

document.addEventListener("click", async (event) => {
  const sidebarToggle = event.target.closest('[data-action="toggle-sidebar"]');
  if (sidebarToggle) {
    sidebarCollapsed = !sidebarCollapsed;
    sessionStorage.setItem("uzumaki-sidebar-collapsed", String(sidebarCollapsed));
    render();
    return;
  }
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) { page = pageButton.dataset.page; if (page === "schedule" && canEditSchedule(user.role)) planningView = "library"; document.querySelector("#sidebar")?.classList.remove("open"); render(); return; }
  const button = event.target.closest("[data-action]"); if (!button) return;
  const action = button.dataset.action;
  if (action === "toggle-password") { const input = document.querySelector('input[name="password"]'); input.type = input.type === "password" ? "text" : "password"; button.textContent = input.type === "password" ? "Ver" : "Ocultar"; }
  if (action === "confirm-logout") accountSessionModal();
  if (action === "open-account-session") { closeModal(); accountSessionModal(); }
  if (action === "open-own-password-change") { closeModal(); ownPasswordChangeModal(); }
  if (action === "open-logout-confirmation") { closeModal(); logoutConfirmationModal(); }
  if (action === "logout") logoutConfirmationModal();
  if (action === "close-login-error") {
    closeModal();
    requestAnimationFrame(() => {
      const passwordInput = document.querySelector('input[name="password"]');
      passwordInput?.focus();
      passwordInput?.select?.();
    });
    return;
  }
  if (action === "perform-logout") {
    closeModal();
    busyModal("Cerrando sesión", "Estamos protegiendo tu sesión.");
    try {
      await endSession();
      user = null;
      clearClientSession();
      closeModal();
      renderLogin();
    } catch (error) {
      closeModal();
      toast(error.message || "No se pudo cerrar la sesión.", "error");
    }
  }
  if (action === "menu") document.querySelector("#sidebar")?.classList.toggle("open");
  if (["export-state-json", "import-state-json", "toggle-schedule", "cycle-shift", "publish", "save-planning-week", "generate-planning-proposal", "reset-demo"].includes(action)) toast("Esta función está temporalmente deshabilitada mientras se migra al backend PostgreSQL.", "error");
  if (action === "new-request") newRequestModal();
  if (action === "view-request") requestDetailModal(button.dataset.id);
  if (action === "open-revoke-request") revokeRequestModal(button.dataset.id);
  if (action === "new-user") newUserModal();
  if (action === "edit-user") editUserModal(button.dataset.id);
  if (action === "reset-user-password") resetUserPasswordModal(button.dataset.id);
  if (action === "create-user-for-employee") createUserForEmployeeModal(button.dataset.employeeId);
  if (action === "delete-user") {
    const targetUser = state.users.find((item) => item.id === button.dataset.id);
    if (!targetUser) return toast("No se encontró el usuario.", "error");
    if (!confirm(`¿Desactivar el acceso de ${targetUser.username}? Se conservará el historial.`)) return;
    try { await apiCommand(`/api/users/${encodeURIComponent(targetUser.id)}/deactivate`, {}); toast("Acceso desactivado"); } catch (error) { toast(error.message, "error"); }
  }
  if (action === "reactivate-user") {
    const targetUser = state.users.find((item) => item.id === button.dataset.id);
    if (!targetUser) return toast("No se encontró el usuario.", "error");
    if (!confirm(`¿Reactivar el acceso de ${targetUser.username}?`)) return;
    try { await apiCommand(`/api/users/${encodeURIComponent(targetUser.id)}/reactivate`, {}); toast("Acceso reactivado"); } catch (error) { toast(error.message, "error"); }
  }
  if (action === "new-planning-week" && canEditSchedule(user.role)) newPlanningWeekModal();
  if (action === "open-planning-library") { planningView = "library"; render(); }
  if (action === "select-planning-date") { planningDateIndex = Number(button.dataset.dateIndex) || 0; render(); }
  if (action === "open-current-planning") { planningView = "editor"; render(); }
  if (action === "open-stored-planning") openStoredPlanningWeek(button.dataset.weekId);
  if (action === "clear-planning-week-selection") { selectedPlanningWeekIds.clear(); render(); }
  if (action === "delete-selected-planning-weeks") deleteSelectedPlanningWeeks();
  if (action === "assign-planning-position") assignmentModal(button.dataset.positionId);
  if (action === "add-planning-day-off") dayOffModal({ sector: button.dataset.sector, date: button.dataset.date });
  if (action === "new-week-exception") weekExceptionModal();
  if (action === "edit-week-exception") weekExceptionModal(button.dataset.exceptionId);
  if (action === "remove-planning-assignment") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    try {
      await apiCommand(`/api/planning/assignments/${encodeURIComponent(button.dataset.positionId)}`, null, "DELETE", { "X-Week-Id": week.id, "If-Match": String(week.version) });
      closeModal(); toast("Asignación quitada");
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "remove-planning-day-off") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    try {
      await apiCommand(`/api/planning/days-off/${encodeURIComponent(button.dataset.dayOffId)}`, null, "DELETE", { "X-Week-Id": week.id, "If-Match": String(week.version) });
      closeModal(); toast("Franco quitado");
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "remove-week-exception") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    try {
      await apiCommand(`/api/planning/exceptions/${encodeURIComponent(button.dataset.exceptionId)}`, null, "DELETE", { "X-Week-Id": week.id, "If-Match": String(week.version) });
      toast("Excepción eliminada");
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "publish-planning-week") publishPlanningWeek();
  if (action === "pause-planning-week") pausePlanningWeek();
  if (action === "draft-planning-week") draftPlanningWeek();
  if (action === "delete-planning-week") deletePlanningWeek();
  if (action === "close-modal") {
    if (document.querySelector(".busy-modal-backdrop")) return;
    if (document.querySelector(".mandatory-modal-backdrop")) return;
    if (event.target === button || button.classList.contains("modal-close") || button.tagName === "BUTTON") closeModal();
  }
  if (action === "filter-request") { requestFilter = button.dataset.filter; render(); }
  if (action === "partner-resolve") {
    const request = state.requests.find((r) => r.id === button.dataset.id);
    const normalizedRequest = request ? normalizeRequestForView(request) : null;
    if (!request || normalizedRequest.partnerEmployeeId !== user.employeeId || normalizedRequest.status !== "pendingPartner") return toast("No se puede resolver esta solicitud.", "error");
    try {
      const result = await apiCommand(`/api/requests/${encodeURIComponent(request.id)}/partner-response`, { status: button.dataset.status });
      closeModal(); toast(statusText[result.status]);
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "resolve") {
    const request = state.requests.find((r) => r.id === button.dataset.id);
    const normalizedRequest = request ? normalizeRequestForView(request) : null;
    if (!request || !canManagerResolveRequest(normalizedRequest)) return toast("La solicitud no está lista para resolver.", "error");
    try {
      await apiCommand(`/api/requests/${encodeURIComponent(request.id)}/resolve`, { status: button.dataset.status });
      closeModal();
      toast(`Solicitud ${statusText[button.dataset.status].toLowerCase()}`);
    } catch (error) { toast(error.message, "error"); }
    return;
    const approvedBy = { id: user.id || user.username, name: user.name, role: user.role };
    if (button.dataset.status === "approved" && ["absence", "leave"].includes(normalizedRequest.type)) {
      const coverEmployeeId = document.querySelector(`[data-request-cover="${request.id}"]`)?.value || "";
      const application = applyApprovedAbsenceOrLeave({
        week: state.planningWeek,
        request: normalizedRequest,
        coverEmployeeId,
        approvedBy,
        employees: state.employees,
        createId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
      });
      if (!application.ok) return toast(application.message, "error");
      request.planningApplication = application.trace;
      audit("Aplicó automáticamente una licencia/ausencia", request.id, `${formatIsoDate(application.trace.date)} · ${application.trace.shift}`);
    }
    if (button.dataset.status === "approved" && normalizedRequest.type === "shiftChange") {
      const application = applyApprovedShiftChange({
        week: state.planningWeek,
        request: normalizedRequest,
        approvedBy,
        employees: state.employees,
        now: () => new Date().toISOString(),
      });
      if (!application.ok) return toast(application.message, "error");
      request.planningApplication = application.trace;
      audit("Aplicó automáticamente un cambio de turno", request.id, `${formatIsoDate(application.trace.original.date)} ${application.trace.original.shift} → ${formatIsoDate(application.trace.proposed.date)} ${application.trace.proposed.shift}`);
    }
    request.status = button.dataset.status;
    state.notifications.unshift({ id: crypto.randomUUID(), title: `Solicitud ${statusText[request.status].toLowerCase()}`, text: `${request.id} · ${requestTypes[normalizeRequestForView(request).type]}.`, time: "Ahora", type: "request", read: false });
    audit(`${request.status === "approved" ? "Aprobó" : "Rechazó"} una solicitud`, request.id, statusText[request.status]);
    closeModal(); persist(); toast(`Solicitud ${statusText[request.status].toLowerCase()}`);
  }
  if (action === "disabled-delete-user") {
    if (!canManageEmployees(user.role)) return toast("Solo una encargada puede eliminar usuarios.", "error");
    const targetUser = state.users.find((item) => item.id === button.dataset.id);
    if (!targetUser) return toast("No se encontró el usuario.", "error");
    if (targetUser.id === user.id || targetUser.username === user.username) return toast("No podés eliminar el usuario con la sesión abierta.", "error");
    const targetEmployee = state.employees.find((item) => item.id === targetUser.employeeId);
    const shouldDeleteEmployee = targetEmployee && !state.users.some((item) => item.id !== targetUser.id && item.employeeId === targetEmployee.id);
    if (!confirm(`¿Eliminar el usuario ${targetUser.username}${shouldDeleteEmployee ? " y sus datos laborales" : ""}? Esta acción se guarda en el JSON.`)) return;
    state.users = state.users.filter((item) => item.id !== targetUser.id);
    if (shouldDeleteEmployee) state.employees = state.employees.filter((item) => item.id !== targetEmployee.id);
    audit("Eliminó un usuario", targetUser.username, shouldDeleteEmployee ? "Usuario y datos laborales eliminados" : "Usuario eliminado");
    persist(); toast(shouldDeleteEmployee ? "Usuario y datos laborales eliminados de la base JSON" : "Usuario eliminado de la base JSON");
  }
  if (action === "toggle-employee") toast("Usá editar o eliminar usuario para modificar la base JSON.", "error");
  if (action === "read-notification") { try { await apiCommand("/api/notifications/read", { notificationId: button.dataset.id }); } catch (error) { toast(error.message, "error"); } }
  if (action === "read-all") { try { await apiCommand("/api/notifications/read", {}); toast("Notificaciones marcadas como leídas"); } catch (error) { toast(error.message, "error"); } }
});

document.addEventListener("keydown", (event) => {
  const backdrop = document.querySelector(".modal-backdrop");
  if (!backdrop) return;
  if (event.key === "Escape" && !backdrop.classList.contains("busy-modal-backdrop") && !backdrop.classList.contains("mandatory-modal-backdrop")) {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...backdrop.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

render();
if (user?.mustChangePassword) forcePasswordChangeModal();
