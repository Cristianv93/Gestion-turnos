import { authenticate, endSession, hydrateStateFromJson, loadState, resetState, saveState, serializeState, STATE_FILE_NAME, STATE_STORAGE_LABEL } from "./services/store.js?v=20260726-03";
import { canEditApplications, canEditSchedule, canManageEmployees, canResolveRequests, canSeeAudit, isAdminRole, roleLabel } from "./services/permissions.js?v=20260712-3";
import { createDraftPlanningWeek, ensureKitchenPlanningSlots } from "./services/planningWeeks.js?v=20260716-1";
import { applyApprovedAbsenceOrLeave, applyApprovedShiftChange, applyGustavoJulioException, buildDailyDaysOffSummary, buildWeeklyAvailabilityMap, generateFloorCoverageAssignments, generateHabitualAssignments, generateKitchenMorningCollaborationAssignments, revokePlanningApplication } from "./services/planningEngine.js?v=20260717-6";

const SESSION_KEY = "uzumaki-user-v5";
let user = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
let state;
try {
  state = await loadState({ remote: Boolean(user), requireAuth: Boolean(user) });
} catch {
  user = null;
  sessionStorage.removeItem(SESSION_KEY);
  state = await loadState({ remote: false });
}
if (user && !state.users.some((item) => item.id === user.id || item.username === user.username)) {
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

const icons = {
  dashboard: "▦", schedule: "▤", employees: "♙", requests: "↔", notifications: "🔔", audit: "◷", logout: "↪", plus: "+", menu: "☰",
};
const loginIcons = {
  user: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3"/><path d="M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11Z"/></svg>`,
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
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.textContent = message;
  toastRegion.append(node);
  setTimeout(() => node.remove(), 3200);
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

function persistenceActions() {
  return `<div class="heading-actions"><button class="button secondary" data-action="export-state-json">Exportar JSON</button>${canEditApplications(user.role) ? `<button class="button primary" data-action="import-state-json">Importar JSON</button>` : ""}</div>`;
}

function render() {
  if (!user) return renderLogin();
  const contentClass = page === "dashboard" ? "content dashboard-content" : "content";
  app.innerHTML = `<div class="app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}">
    ${sidebar()}
    <div class="workspace">
      ${topbar()}
      <main class="${contentClass}" id="content">${renderPage()}</main>
    </div>
  </div>`;
}

function renderLogin(error = "") {
  app.innerHTML = `<main class="login-page">
    <section class="login-brand">
      <div class="login-brand-header"><span class="brand-mark large"><img src="./assets/ICONO.webp" alt="" /></span><div><strong>UZUMAKI</strong><small>Gestión operativa</small></div></div>
    </section>
    <section class="login-panel">
      <form class="login-card" id="login-form">
        <div class="mobile-logo"><span class="brand-mark"><img src="./assets/ICONO.webp" alt="" /></span><div><strong>Uzumaki</strong><small>Gestión operativa</small></div></div>
        <span class="eyebrow">BIENVENIDOS</span>
        <h2>Ingresá a tu espacio</h2>
        ${error ? `<div class="form-error">${error}</div>` : ""}
        <label>Usuario<div class="input-field"><span class="input-icon" aria-hidden="true">${loginIcons.user}</span><input name="username" autocomplete="username" required autofocus /></div></label>
        <label>Contraseña<div class="input-field password-field"><span class="input-icon" aria-hidden="true">${loginIcons.lock}</span><input name="password" type="password" autocomplete="current-password" required /><button type="button" class="text-button" data-action="toggle-password">Ver</button></div></label>
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
    <nav>${items.map(([id, label]) => `<button class="nav-item ${page === id ? "active" : ""}" data-page="${id}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="nav-icon">${icons[id]}</span><span class="nav-label">${escapeHtml(label)}</span>${id === "notifications" && unreadCount() ? `<b>${unreadCount()}</b>` : ""}</button>`).join("")}</nav>
    <div class="sidebar-foot"><div class="mini-avatar">${initials(user.name)}</div><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(roleLabel[user.role])}</small></div><button title="Cerrar sesión" data-action="logout" aria-label="Cerrar sesión">${icons.logout}</button></div>
  </aside>`;
}

function topbar() {
  const titles = { dashboard: isAdminRole(user.role) ? "Resumen operativo" : `Hola, ${user.name.split(" ")[0]}`, schedule: isAdminRole(user.role) ? "Grilla operativa" : "Mi semana", employees: "Personal", requests: isAdminRole(user.role) ? "Solicitudes" : "Mis solicitudes", notifications: "Notificaciones", audit: "Auditoría" };
  const weekLabel = state.planningWeek ? `${formatIsoDate(state.planningWeek.startDate)} — ${formatIsoDate(state.planningWeek.endDate)}` : "Semana sin crear";
  return `<header class="topbar"><button class="mobile-menu" data-action="menu">${icons.menu}</button><div><span class="crumb">Uzumaki /</span><strong>${titles[page]}</strong></div><div class="top-actions"><button class="icon-button" data-page="notifications" aria-label="Notificaciones">${icons.notifications}${unreadCount() ? `<b>${unreadCount()}</b>` : ""}</button><span class="date-pill">${weekLabel}</span></div></header>`;
}

function renderPage() {
  const pages = { dashboard: dashboardPage, schedule: schedulePage, employees: employeesPage, requests: requestsPage, notifications: notificationsPage, audit: auditPage };
  return (pages[page] || dashboardPage)();
}

function pageHeading(kicker, title, description, action = "", extraClass = "") {
  return `<div class="page-heading ${extraClass}"><div><span class="eyebrow">${escapeHtml(kicker)}</span><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div>${action}</div>`;
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
  const date = dates.find((item) => item >= new Date().toISOString().slice(0, 10)) || dates[0];
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
  return `${pageHeading("MI PERFIL", `Hola, ${employee.name}`, "", `<button class="button secondary" data-page="schedule">Ver grilla publicada</button>`, "staff-profile-heading")}
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
  if (filter === "active") return ["pending", "pendingManager", "review"].includes(request.status) || request.status === "partnerAccepted";
  if (filter === "waitingResponse") return request.status === "pendingPartner";
  if (filter === "approved") return request.status === "approved";
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
  const saveButton = `<button class="button secondary planning-icon-action" data-action="save-planning-week" aria-label="Guardar grilla" title="Guardar grilla"><span aria-hidden="true">⌑</span></button>`;
  const suggestButton = `<button class="button planning-proposal-action magic-pulse" data-action="generate-planning-proposal" title="Generar propuesta automática"><span aria-hidden="true">✦</span><span>Propuesta</span></button>`;
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
  const assigned = (week.assignments || []).length;
  const total = (week.operationalPositions || []).length;
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

function planningMobileWeekPanel(week, conflicts, daysOffSummary) {
  const positions = week.operationalPositions.filter((position) => !isOptionalPlanningPosition(position));
  const assigned = positions.filter((position) => week.assignments.some((assignment) => assignment.positionId === position.id)).length;
  return `<section class="planning-mobile-panel" aria-label="Grilla semanal móvil">
    <header class="planning-lanes-head">
      <div><span class="eyebrow">VISTA MÓVIL</span><h2>Grilla por día</h2><p>Elegí un día para leer turnos, puestos y francos sin mover la pantalla completa.</p></div>
      <span class="planning-mobile-coverage"><b>${assigned}</b>/<small>${positions.length}</small> cubiertos</span>
    </header>
    ${planningLaneDayTabs(week, conflicts)}
    <div class="planning-lanes-summary">
      ${planningGoogleStat("Puestos", positions.length, "Semana")}
      ${planningGoogleStat("Cubiertos", assigned, `${Math.max(positions.length - assigned, 0)} pendientes`)}
      ${planningGoogleStat("Alertas", conflicts.total, "Revisión")}
      ${planningGoogleStat("Día", planningDateIndex + 1, "de 7")}
    </div>
    ${planningLaneAlerts(week, conflicts)}
    ${planningLanesStructure(week, conflicts, daysOffSummary)}
    <footer class="planning-lanes-foot"><span>La grilla completa queda disponible en escritorio.</span><b>${formatIsoDate([...new Set(week.operationalPositions.map((position) => position.date))][planningDateIndex])}</b></footer>
  </section>`;
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
  return `<section class="planning-lane planning-lane-off"><header><div class="planning-lane-title"><span>○</span><div><h3>Francos · ${sector}</h3><small>${dayOffs.length ? `${dayOffs.length} personas disponibles` : "Sin francos cargados"}</small></div></div><b class="planning-lane-status neutral">${dayOffs.length}</b></header><button class="planning-lane-days-off" type="button" ${editable ? `data-action="add-planning-day-off" data-sector="${sector}" data-date="${date}"` : "disabled"}>${dayOffs.length ? dayOffs.map((dayOff) => `<span class="planning-lane-off-chip ${dayOff.source === "manualDayOff" ? "manual" : ""}"><strong>${escapeHtml(dayOff.name)}</strong></span>`).join("") : "Agregar franco"}</button></section>`;
}

function planningGoogleStat(label, value, meta) {
  return `<span class="planning-google-stat"><small>${label}</small><strong>${value}</strong><em>${meta}</em></span>`;
}

function staffPublishedPlanningWeekPage(week) {
  const conflicts = detectPlanningConflicts(week);
  const showOperationalExceptions = isAdminRole(user.role);
  return `${pageHeading("GRILLA PUBLICADA", "", "")}
    <section class="week-lifecycle-card week-published staff-published-week">
      <div class="week-lifecycle-head"><span class="week-state-icon">✓</span><div><span class="eyebrow">SOLO LECTURA</span><h2>${escapeHtml(week.name)}</h2><p>${formatIsoDate(week.startDate)} al ${formatIsoDate(week.endDate)} · Publicada ${formatDateTime(week.publishedAt)}</p></div><span class="week-status published">Publicada</span></div>
      <div class="week-empty-canvas">
        <span class="week-empty-symbol">▦</span><div><h3>Grilla semanal publicada</h3><p>Consultá tus turnos, francos y novedades de la semana.</p></div>
      </div>
      ${showOperationalExceptions ? weeklyExceptionsPanel(week, canEditSchedule(user.role)) : ""}
      ${planningWeekStructure(week, conflicts, showOperationalExceptions)}
    </section>`;
}

function planningWeekStructure(week, conflicts, showExceptions = true, providedDaysOffSummary = null, simpleGridView = false) {
  const staffView = simpleGridView || !isAdminRole(user.role);
  const showDayOffTables = staffView || showExceptions || canEditSchedule(user.role);
  const daysOffSummary = providedDaysOffSummary || buildDailyDaysOffSummary({
    employees: state.employees,
    week,
    availabilityMap: buildWeeklyAvailabilityMap(state.employees, week, { requests: state.requests }),
  });
  return `${planningMobileWeekPanel(week, conflicts, daysOffSummary)}
  <div class="planning-position-sectors planning-position-sectors--desktop ${staffView ? "planning-position-sectors--staff" : ""}" aria-label="Puestos operativos">
    ${planningPositionSector(week, { sector: "Cocina", key: "kitchen", icon: "🍳", eyebrow: "SECTOR OPERATIVO" }, conflicts, showExceptions, staffView)}
    ${showDayOffTables ? planningDaysOffSector(week, "Cocina", daysOffSummary, conflicts) : ""}
    ${planningPositionSector(week, { sector: "Pisos", key: "floors", icon: "🏥", eyebrow: "COBERTURA POR PISO" }, conflicts, showExceptions, staffView)}
    ${showDayOffTables ? planningDaysOffSector(week, "Pisos", daysOffSummary, conflicts) : ""}
  </div>`;
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

function compactEmployeeName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = parts[0];
  if (first.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === "veronica") return "Vero";
  const initials = parts.slice(1).map((part) => `${part[0]}.`).join(" ");
  return initials ? `${first} ${initials}` : first;
}

function planningAssignmentName(employee) {
  return `<strong class="planning-assignment-name planning-assignment-name--full">${escapeHtml(employee.name)}</strong><strong class="planning-assignment-name planning-assignment-name--compact">${escapeHtml(compactEmployeeName(employee.name))}</strong>`;
}

function emptyPositionState(position, warnings) {
  if (!position) return "";
  if (position.sector === "Pisos") return `<span class="planning-empty-state critical">Sin cobertura</span>`;
  if (isOptionalPlanningPosition(position)) return `<span class="planning-empty-state optional">Opcional</span>`;
  if (isBaseKitchenPosition(position)) return `<span class="planning-empty-state pending">Pendiente operativo</span>`;
  return warnings.length ? "" : `<span class="planning-empty-state pending">Pendiente</span>`;
}

function planningPositionSector(week, section, conflicts, showExceptions = true, staffView = false) {
  const positions = week.operationalPositions.filter((position) => position.sector === section.sector);
  const dates = [...new Set(positions.map((position) => position.date))];
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
    const exceptions = showExceptions && position ? positionExceptions(week, position.id) : [];
    const emptyState = !employee && !staffView ? emptyPositionState(position, warnings) : "";
    const specialChip = planningSpecialChip(assignment, position, employee, showSpecialChips);
    const assignmentContent = employee
      ? staffView ? planningAssignmentName(employee) : `${planningAssignmentName(employee)}<small>${escapeHtml(employee.role)}</small>${specialChip}`
      : emptyState;
    return `<div class="planning-position-cell ${staffView ? "staff-view" : ""} ${index === dates.length - 1 ? "is-last-day" : ""} ${warnings.length ? "has-warning" : ""} ${exceptions.length ? "has-exception" : ""}"><button class="planning-position-assignment ${employee ? "assigned" : "empty"} ${staffView ? "staff-view" : ""} ${warnings.length ? "warning" : ""} ${exceptions.length ? "exception" : ""} ${!staffView && !employee && position?.sector === "Pisos" ? "critical-empty" : ""} ${!staffView && !employee && isOptionalPlanningPosition(position) ? "optional-empty" : ""}" type="button" ${editable && position ? `data-action="assign-planning-position" data-position-id="${position.id}"` : "disabled"} aria-label="${employee ? `Cambiar asignación de ${position.label}: ${employee.name}` : `Asignar empleado a ${position?.label || row.label}`}">${assignmentContent}${staffView ? "" : `${positionExceptionSummary(exceptions)}${warnings.length ? `<em>${warnings[0]}</em>` : ""}`}</button></div>`;
    }).join("")}`;
  };
  return `<section class="planning-position-sector reference-sector reference-sector-${section.key}" aria-labelledby="planning-${section.key}-title">
    <header class="reference-sector-head"><span class="reference-sector-icon" aria-hidden="true">${section.icon}</span><div><h2 id="planning-${section.key}-title">${section.sector}</h2>${section.description ? `<p>${section.description}</p>` : ""}</div></header>
    <div class="planning-position-board"><div class="planning-position-grid" style="--morning-rows:${rowsByShift["Mañana"].length};--afternoon-rows:${rowsByShift["Tarde"].length}">
      <div class="planning-position-corner"><span class="sr-only">Puesto</span>${staffView ? "" : `<small>${week.assignments.length} asignados</small>`}</div>
      ${dates.map((date, index) => `<div class="planning-position-day ${index === dates.length - 1 ? "is-last-day" : ""}"><span>${dayNames[index]}</span><strong>${formatIsoDate(date).slice(0, 5)}</strong></div>`).join("")}
      ${shifts.map((shift) => `<div class="planning-shift-divider planning-shift-divider--${shift.modifier}"><span aria-hidden="true">${shift.icon}</span><strong>${shift.label}</strong></div>${rowsByShift[shift.value].map(rowMarkup).join("")}`).join("")}
    </div></div>
  </section>`;
}

function planningDaysOffSector(week, sector, daysOffSummary, conflicts) {
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  const dayNames = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  const editable = ["draft", "published", "paused"].includes(week.status) && canEditSchedule(user.role);
  const sectionId = `planning-days-off-${sector.toLowerCase()}`;
  const displaySector = sector === "Pisos" ? "Camareras" : sector;
  const title = `Francos ${displaySector}`;
  return `<section class="planning-position-sector reference-sector reference-sector-off" aria-labelledby="${sectionId}">
    <header class="reference-sector-head"><span class="reference-sector-icon" aria-hidden="true">☕</span><div><h2 id="${sectionId}">${title}</h2></div></header>
    <div class="planning-position-board"><div class="planning-position-grid planning-days-off-grid">
      <div class="planning-position-corner"><span class="sr-only">${title}</span></div>
      ${dates.map((date, index) => `<div class="planning-position-day"><span>${dayNames[index]}</span><strong>${formatIsoDate(date).slice(0, 5)}</strong></div>`).join("")}
      <div class="planning-position-row-label"><strong>Personal de franco</strong></div>${dates.map((date) => planningDaysOffCell(week, sector, date, daysOffSummary?.[sector]?.[date] || [], editable, conflicts)).join("")}
    </div></div>
  </section>`;
}

function planningDaysOffCell(week, sector, date, dayOffs, editable, conflicts) {
  return `<div class="planning-position-cell planning-days-off-cell"><button class="planning-day-off-button ${dayOffs.length ? "assigned" : "empty"}" type="button" ${editable ? `data-action="add-planning-day-off" data-sector="${sector}" data-date="${date}"` : "disabled"} aria-label="Cargar franco de ${sector} para ${formatIsoDate(date)}">${dayOffs.length ? dayOffs.map((dayOff) => {
    const warnings = dayOff.dayOffId ? conflicts.dayOffWarnings.get(dayOff.dayOffId) || [] : [];
    return `<span class="planning-day-off-chip ${warnings.length ? "warning" : ""} ${dayOff.source === "calculatedCycle" ? "calculated" : "manual"}"><strong>${dayOff.name}</strong>${warnings.length ? `<em>${warnings[0]}</em>` : ""}</span>`;
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

function publishPlanningWeek() {
  const week = state.planningWeek;
  if (!week || !["draft", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  const conflicts = detectPlanningConflicts(week);
  if (conflicts.counts.duplicateAssignment) {
    return toast(`No se puede publicar: corregí ${conflicts.counts.duplicateAssignment} duplicado(s) dentro del mismo día.`, "error");
  }
  const publishedAt = new Date().toISOString();
  const wasPaused = week.status === "paused";
  week.status = "published";
  week.publishedAt = publishedAt;
  week.publishedBy = { id: user.id || user.username, name: user.name, role: user.role };
  week.pausedAt = "";
  week.pausedBy = null;
  state.notifications.unshift({
    id: crypto.randomUUID(),
    title: wasPaused ? "Grilla republicada" : "Nueva grilla publicada",
    text: `${week.name} ya está visible para el personal.`,
    time: "Ahora",
    type: "schedule",
    read: false,
  });
  audit(wasPaused ? "Republicó una grilla" : "Publicó una grilla manual", week.name, "Publicada");
  persistPlanningWeekLifecycle(week);
  toast(wasPaused ? "Grilla republicada correctamente" : "Grilla publicada correctamente");
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

function openStoredPlanningWeek(weekId) {
  const stored = planningSnapshots().find((week) => week.id === weekId);
  if (!stored || !canEditSchedule(user.role)) return toast("No se encontró la grilla almacenada.", "error");
  if (state.planningWeek && state.planningWeek.id !== weekId && planningWeekHasUnsavedChanges(state.planningWeek) && !confirm("La grilla actual tiene cambios sin guardar en el historial. ¿Abrir otra grilla de todos modos?")) return;
  state.planningWeek = structuredClone(stored);
  planningView = "editor";
  render();
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

function pausePlanningWeek() {
  const week = state.planningWeek;
  if (!week || week.status !== "published" || !canEditSchedule(user.role)) return;
  if (!confirm("¿Pausar la publicación? El personal dejará de ver esta grilla hasta que se republice.")) return;
  week.status = "paused";
  week.pausedAt = new Date().toISOString();
  week.pausedBy = { id: user.id || user.username, name: user.name, role: user.role };
  audit("Pausó una grilla publicada", week.name, "Pausada");
  persistPlanningWeekLifecycle(week);
  toast("Publicación pausada");
}

function draftPlanningWeek() {
  const week = state.planningWeek;
  if (!week || !["published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
  if (!confirm("¿Volver la grilla a borrador? El personal dejará de verla hasta que se publique nuevamente.")) return;
  week.status = "draft";
  week.returnedToDraftAt = new Date().toISOString();
  week.returnedToDraftBy = { id: user.id || user.username, name: user.name, role: user.role };
  audit("Volvió una grilla a borrador", week.name, "Borrador");
  persistPlanningWeekLifecycle(week);
  toast("Grilla en borrador");
}

function deletePlanningWeek() {
  const week = state.planningWeek;
  if (!week || !canEditSchedule(user.role)) return;
  if (!confirm("¿Eliminar esta grilla? Se quitará también del historial almacenado.")) return;
  const weekName = week.name;
  state.weeklySchedules = (state.weeklySchedules || []).filter((item) => item.id !== week.id);
  state.planningWeek = null;
  planningView = "library";
  audit("Eliminó una grilla semanal", weekName, "Eliminada");
  persist();
  toast("Grilla eliminada");
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
  const withAccess = state.users.filter((item) => item.employeeId).length;
  return `<section class="people-page">
    <header class="people-page-header"><div><span class="eyebrow">DOTACIÓN</span><h1>Personal</h1><p>Directorio operativo, accesos y ubicación del equipo.</p></div><div class="people-page-actions"><span class="people-access-summary"><b>${withAccess}</b> accesos activos</span>${canManage ? `<button class="button primary" data-action="new-user"><span aria-hidden="true">+</span> Agregar persona</button>` : ""}</div></header>
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
      return `<tr><td>${rowUser ? `<strong>${escapeHtml(rowUser.username)}</strong>` : `<span class="muted">Sin usuario</span>`}</td><td><div class="person-cell"><span class="avatar">${escapeHtml(employee?.initials || initials(rowUser?.name || rowUser?.username || "?"))}</span><div><strong>${escapeHtml(employee?.name || rowUser?.name || "Sin persona")}</strong><small>${escapeHtml(employee?.phone || "Sin teléfono")}</small></div></div></td><td>${escapeHtml(employee?.role || "Sin rol laboral")}</td><td>${employeeAssignment(employee || {})}</td><td>${rowUser ? escapeHtml(roleLabel[rowUser.role] || rowUser.role) : `<span class="muted">Sin acceso</span>`}</td><td>${canManage ? `<div class="row-actions">${rowUser ? `<button class="row-action" data-action="edit-user" data-id="${rowId}">Editar</button><button class="row-action danger" data-action="delete-user" data-id="${rowId}">Eliminar</button>` : `<button class="row-action" data-action="create-user-for-employee" data-id="${rowId}">Crear acceso</button>`}</div>` : `<span class="muted">Solo lectura</span>`}</td></tr>`;
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

function requestFilterOptions(visibleRequests, admin) {
  const waitingForMe = visibleRequests.some((request) => request.status === "pendingPartner" && request.partnerEmployeeId === user.employeeId);
  const waitingFromMe = visibleRequests.some((request) => request.status === "pendingPartner" && request.employeeId === user.employeeId);
  const waitingDescription = admin
    ? "Solicitudes esperando respuesta."
    : waitingForMe
      ? "Esperando tu respuesta."
      : waitingFromMe
        ? "Esperando respuesta del compañero."
        : "Solicitudes esperando respuesta.";
  return [
    { id: "all", icon: "◉", title: "Todas", description: "Ver todas las solicitudes." },
    { id: "active", icon: "●", title: "En curso", description: "Solicitudes pendientes o en revisión." },
    { id: "waitingResponse", icon: "↔", title: "Esperando respuesta", description: waitingDescription },
    { id: "approved", icon: "✓", title: "Aprobadas", description: "Solicitudes confirmadas." },
    { id: "rejected", icon: "×", title: "Rechazadas", description: "Solicitudes no aprobadas." },
    { id: "history", icon: "◷", title: "Historial", description: "Registro completo de solicitudes finalizadas." },
  ].map((option) => ({ ...option, count: visibleRequests.filter((request) => requestMatchesFilter(request, option.id)).length }));
}

function requestSortValue(request) {
  return request.revokedAt || request.updatedAt || request.resolvedAt || request.createdAt || request.date || request.id || "";
}

function sortRequestsForFilter(requests, filter) {
  if (filter !== "history") return requests;
  return [...requests].sort((a, b) => String(requestSortValue(b)).localeCompare(String(requestSortValue(a))));
}

function requestSummaryLine(request) {
  const impact = request.scheduleImpact || {};
  const target = impact.target || impact.proposed || impact.original || {};
  const date = target.date ? formatShortDayMonth(target.date) : "";
  const shift = target.shift ? `Turno ${target.shift}` : "";
  return [date, shift].filter(Boolean).join(" · ") || request.detail || "Sin fecha definida";
}

function formatShortDayMonth(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return value || "";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", timeZone: "UTC" }).format(date).replace(".", "");
}

function requestsPage() {
  const admin = isAdminRole(user.role);
  const visibleRequests = (admin ? state.requests : state.requests.filter((r) => r.employeeId === user.employeeId || r.partnerEmployeeId === user.employeeId)).map(normalizeRequestForView);
  const filters = requestFilterOptions(visibleRequests, admin);
  if (!filters.some((filter) => filter.id === requestFilter)) requestFilter = "all";
  const filtered = sortRequestsForFilter(visibleRequests.filter((request) => requestMatchesFilter(request, requestFilter)), requestFilter);
  return `${pageHeading("GESTIÓN", admin ? "Solicitudes" : "Mis solicitudes", admin ? "Revisá y resolvé los pedidos del equipo." : "", `<button class="button primary" data-action="new-request">${icons.plus} Nueva solicitud</button>`)}
    <section class="requests-layout">
      <aside class="request-filter-panel" aria-label="Filtros de solicitudes">
        <h2>Filtros</h2>
        <div class="request-filter-list">${filters.map((filter) => `<button class="request-filter-card ${requestFilter === filter.id ? "active" : ""}" data-action="filter-request" data-filter="${filter.id}"><span class="request-filter-icon">${filter.icon}</span><span><strong>${escapeHtml(filter.title)}</strong></span><b>${filter.count}</b></button>`).join("")}</div>
      </aside>
      <section class="request-results-panel">
        <div class="request-results-head"><span>${escapeHtml(filters.find((filter) => filter.id === requestFilter)?.title || "Solicitudes")}</span><b>${filtered.length}</b></div>
        <div class="request-cards">${filtered.map((r) => requestCard(r, admin)).join("") || empty("No hay solicitudes en este filtro")}</div>
      </section>
    </section>`;
}

function requestCard(r, admin) {
  const request = normalizeRequestForView(r);
  return `<article class="request-card"><div class="request-card-top"><span class="request-icon large">${request.type === "absence" ? "+" : "↔"}</span><div><span class="request-id">${escapeHtml(request.id)}</span><h3>${escapeHtml(requestTypes[request.type] || request.type)}</h3><p>${escapeHtml(request.detail)}</p></div></div><div class="request-card-status"><span class="badge ${request.status}">${escapeHtml(statusText[request.status] || request.status)}</span>${admin && canManagerResolveRequest(request) ? `<small>Requiere revisión</small>` : ""}</div><p class="request-card-summary">${escapeHtml(requestSummaryLine(request))}</p><div class="card-actions"><button class="text-link" data-action="view-request" data-id="${request.id}">Ver detalle →</button></div></article>`;
}

function notificationsPage() {
  return `${pageHeading("CENTRO DE AVISOS", "Notificaciones", `${unreadCount()} novedades sin leer.`, unreadCount() ? `<button class="button secondary" data-action="read-all">Marcar todas como leídas</button>` : "")}
    <section class="notification-list">${state.notifications.map((n) => `<button class="notification ${n.read ? "read" : ""}" data-action="read-notification" data-id="${n.id}"><span class="notification-symbol ${n.type}">${n.type === "alert" ? "!" : n.type === "schedule" ? "▤" : "↔"}</span><span><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.text)}</p><small>${escapeHtml(n.time)}</small></span>${n.read ? "" : `<i></i>`}</button>`).join("") || empty("No tenés notificaciones")}</section>`;
}

function auditPage() {
  if (!canSeeAudit(user.role)) return dashboardPage();
  return `${pageHeading("TRAZABILIDAD", "Auditoría", "Registro de las acciones relevantes del sistema.")}
    <section class="table-card"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Elemento</th><th>Resultado</th></tr></thead><tbody>${state.auditLogs.map((a) => `<tr><td>${escapeHtml(a.time)}</td><td><strong>${escapeHtml(a.user)}</strong></td><td>${escapeHtml(a.action)}</td><td><span class="sector-pill">${escapeHtml(a.entity)}</span></td><td><span class="badge active">${escapeHtml(a.result)}</span></td></tr>`).join("")}</tbody></table></section>
    <button class="reset-link" data-action="reset-demo">Restablecer datos iniciales</button>`;
}

function modal(content, variant = "") {
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop ${variant ? `${variant}-backdrop` : ""}" data-action="close-modal"><section class="modal ${variant}" role="dialog" aria-modal="true">${content}</section></div>`);
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
  const revokeAction = canRevokeRequest(request)
    ? `<button class="button danger-soft" data-action="open-revoke-request" data-id="${request.id}">Revocar aprobación</button>`
    : "";
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
  return selectOptions([
    { value: "staff", label: "Personal operativo" },
    { value: "manager", label: "Encargada" },
    { value: "supervisor", label: "Supervisión" },
    { value: "admin", label: "Administración principal" },
  ], selected);
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
  const password = "";
  const name = employee?.name || targetUser?.name || "";
  const companyRole = employee?.role || companyRoleOptions[0];
  const systemRole = targetUser?.role || "staff";
  const sector = employee?.sector || "";
  const turno = employee?.turno || "";
  const piso = employee?.piso || "";
  const phone = employee?.phone || "";
  modal(`<button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">${isEditing ? "EDITAR USUARIO" : "NUEVO USUARIO"}</span><h2>${isEditing ? "Editar usuario" : "Agregar usuario"}</h2><p class="muted">${isEditing ? "Los cambios actualizan datos laborales. Dejá la contraseña vacía para conservarla." : "Se crea el acceso a la app con sus datos laborales en una sola operación."}</p><form id="user-form"><input type="hidden" name="userId" value="${escapeHtml(targetUser?.id || "")}" /><input type="hidden" name="employeeId" value="${escapeHtml(employee?.id || "")}" /><div class="form-row"><label>Usuario<input name="username" autocomplete="off" value="${escapeHtml(username)}" required /></label><label>Contraseña<input name="password" type="password" value="${escapeHtml(password)}" ${isEditing ? 'placeholder="Sin cambios"' : "required"} /></label></div><label>Nombre completo<input name="name" value="${escapeHtml(name)}" required /></label><div class="form-row"><label>Rol del sistema<select name="systemRole" required>${systemRoleSelectOptions(systemRole)}</select></label><label>Rol dentro de la empresa<select name="companyRole" required>${companyRoleSelectOptions(companyRole)}</select></label></div><div class="form-row"><label>Sector<select name="sector">${sectorSelectOptions(sector)}</select></label><label>Turno<select name="turno">${shiftSelectOptions(turno)}</select></label></div><div class="form-row"><label>Piso<select name="piso">${floorSelectOptions(piso)}</select></label><label>Teléfono<input name="phone" value="${escapeHtml(phone)}" /></label></div><div class="week-form-note"><strong>Roles separados</strong><p>El rol del sistema define permisos. El rol dentro de la empresa define la función laboral y cómo aparece en grilla.</p></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary">${isEditing ? "Guardar cambios" : "Guardar usuario"}</button></div></form>`);
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

function closeModal() { document.querySelector(".modal-backdrop")?.remove(); }
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

async function loginAsDemoUser(match) {
  user = match;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  sessionStorage.removeItem("uzumaki-user-v3");
  sessionStorage.removeItem("uzumaki-user-v2");
  sessionStorage.removeItem("uzumaki-user");
  sessionStorage.removeItem("turnia-user");
  page = "dashboard";
  state = await loadState();
  render();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "login-form") {
    const data = new FormData(event.target);
    const username = data.get("username").trim().toLowerCase();
    try {
      const match = await authenticate(username, data.get("password"));
      return loginAsDemoUser(match);
    } catch (error) {
      return renderLogin(error.message || "Usuario o contraseña incorrectos.");
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
    const request = { id: `SOL-${String(25 + state.requests.length).padStart(3, "0")}`, employee: employee.name, employeeId: employee.id, type, detail, date: "Ahora", status, note, requiresPartner: isChange, partnerEmployeeId, partnerStatus: isChange ? "pending" : "", scheduleImpact };
    state.requests.unshift(request);
    state.notifications.unshift({ id: crypto.randomUUID(), title: "Solicitud enviada", text: `${requestTypes[request.type]}: ${request.detail}.`, time: "Ahora", type: "request", read: false });
    audit("Creó una solicitud", request.id, statusText[request.status]);
    closeModal(); persist(); toast("Solicitud enviada correctamente");
  }
  if (event.target.id === "request-revoke-form") {
    const data = new FormData(event.target);
    const request = state.requests.find((item) => item.id === data.get("requestId"));
    const normalizedRequest = request ? normalizeRequestForView(request) : null;
    const reason = data.get("reason").trim();
    if (!request || !canRevokeRequest(normalizedRequest)) return toast("No se puede revocar esta solicitud.", "error");
    if (!reason) return toast("Indicá un motivo de revocación.", "error");
    if (!confirm("¿Confirmás la revocación? El sistema intentará revertir la grilla solo si es seguro.")) return;
    const revokedBy = { id: user.id || user.username, name: user.name, role: user.role };
    const revocation = revokePlanningApplication({
      week: state.planningWeek,
      request: normalizedRequest,
      revokedBy,
      reason,
      now: () => new Date().toISOString(),
    });
    if (!revocation.ok) return toast(revocation.message, "error");
    const revokedAt = revocation.trace?.revokedAt || new Date().toISOString();
    request.status = "revoked";
    request.revokedAt = revokedAt;
    request.revokedBy = revokedBy;
    request.revocationReason = reason;
    request.revocationApplication = {
      ...revocation.trace,
      sourceRequestId: request.id,
      revokedChangeType: normalizedRequest.type,
      revokedBy,
      revokedAt,
      reason,
      automatic: revocation.reverted,
      requiresManualReview: revocation.requiresManualReview,
      message: revocation.message,
    };
    audit("Revocó una solicitud aprobada", request.id, revocation.requiresManualReview ? "Revisión manual requerida" : "Reversión automática aplicada");
    closeModal();
    persist();
    toast(revocation.requiresManualReview ? "No se pudo revertir automáticamente. Revisar la grilla manualmente." : "Solicitud revocada y grilla revertida");
  }
  if (event.target.id === "planning-week-form") {
    if (!canEditSchedule(user.role)) return;
    const data = new FormData(event.target);
    const name = data.get("name").trim();
    const startDate = data.get("startDate");
    const endDate = addIsoDays(startDate, 6);
    if (!name) return toast("Ingresá un nombre para la semana.", "error");
    if (data.get("endDate") && data.get("endDate") !== endDate) return toast("La semana debe durar exactamente 7 días.", "error");
    if (state.planningWeek) {
      if (!confirm("La grilla que estás editando se guardará en el historial antes de crear una nueva.")) return;
      state.planningWeek.savedAt = state.planningWeek.savedAt || new Date().toISOString();
      state.planningWeek.savedBy = state.planningWeek.savedBy || { id: user.id || user.username, name: user.name, role: user.role };
      state.planningWeek.updatedAt = new Date().toISOString();
      storePlanningWeekSnapshot(state.planningWeek);
    }
    state.planningWeek = createDraftPlanningWeek({
      id: crypto.randomUUID(),
      name,
      startDate,
      endDate,
    });
    planningView = "editor";
    closeModal(); persistPlanningWeekLifecycle(state.planningWeek); toast("Semana creada como borrador");
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
    const existingAssignment = week.assignments.find((item) => item.positionId === positionId);
    if (existingAssignment) existingAssignment.employeeId = employeeId;
    else week.assignments.push({ id: crypto.randomUUID(), positionId, employeeId });
    closeModal(); persistPlanningWeekLifecycle(week); toast(`${employee.name} fue asignado al puesto`);
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
    if (!Array.isArray(week.daysOff)) week.daysOff = [];
    const existingDayOff = week.daysOff.find((item) => item.date === date && item.sector === sector && item.employeeId === employeeId);
    if (existingDayOff) existingDayOff.tipo = tipo;
    else week.daysOff.push({ id: crypto.randomUUID(), date, sector, employeeId, tipo });
    closeModal(); persistPlanningWeekLifecycle(week); toast(`Franco ${tipo} cargado para ${employee.name}`);
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
    if (!Array.isArray(week.exceptions)) week.exceptions = [];
    const note = data.get("note").trim();
    const payload = {
      positionId: position.id,
      date: position.date,
      shift: position.shift,
      sector: position.sector,
      affectedEmployeeId,
      type,
      coverEmployeeId,
      note,
      updatedAt: new Date().toISOString(),
      updatedBy: { id: user.id || user.username, name: user.name, role: user.role },
    };
    const existing = week.exceptions.find((item) => item.id === exceptionId);
    if (existing) Object.assign(existing, payload);
    else week.exceptions.push({ id: crypto.randomUUID(), ...payload, createdAt: payload.updatedAt });
    audit(existing ? "Editó una excepción semanal" : "Registró una excepción semanal", `${formatIsoDate(position.date)} · ${position.label}`, exceptionTypes[type]);
    closeModal(); persistPlanningWeekLifecycle(week); toast(existing ? "Excepción actualizada" : "Excepción registrada");
  }
  if (event.target.id === "user-form") {
    if (!canManageEmployees(user.role)) return toast("Solo una encargada puede crear usuarios.", "error");
    const data = new FormData(event.target);
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
    if (state.users.some((item) => item.username === username && item.id !== userId)) return toast("Ese usuario ya existe.", "error");
    const existingUser = userId ? state.users.find((item) => item.id === userId) : null;
    let employee = employeeId ? state.employees.find((item) => item.id === employeeId) : null;
    if (!employee) {
      employee = {
        id: uniqueId("emp", name, state.employees),
        status: "active",
        francos: [],
        createdFromUser: username,
      };
      state.employees.push(employee);
    }
    Object.assign(employee, {
      name,
      initials: initials(name),
      role: companyRole,
      roleId: roleIdFor(companyRole),
      sector: sector || null,
      sectorId: sectorIdFor(sector),
      turno: turno || null,
      turnoId: turnoIdFor(turno),
      piso: data.get("piso") ? Number(data.get("piso")) : null,
      phone: data.get("phone").trim(),
      status: employee.status || "active",
      systemRole: systemRoleFor(companyRole, participaEnOperacion),
      participaEnOperacion,
      francos: Array.isArray(employee.francos) ? employee.francos : [],
    });
    const savedUser = existingUser || {
      id: uniqueId("user", username, state.users),
      employeeId: employee.id,
    };
    Object.assign(savedUser, {
      username,
      name,
      role,
      employeeId: employee.id,
    });
    if (password) savedUser.password = password;
    if (!existingUser) state.users.push(savedUser);
    if (userId && (savedUser.id === user.id || savedUser.username === user.username)) {
      user = savedUser;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
    }
    audit(existingUser ? "Editó un usuario y sus datos laborales" : "Creó un usuario y sus datos laborales", username, `${roleLabel[role] || role} · ${companyRole}`);
    closeModal(); persist(); toast(existingUser ? "Usuario actualizado en la base JSON" : "Usuario y datos laborales guardados en la base JSON");
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

document.addEventListener("click", (event) => {
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
  if (action === "logout") { endSession(); user = null; sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem("uzumaki-user-v4"); sessionStorage.removeItem("uzumaki-user-v3"); sessionStorage.removeItem("uzumaki-user-v2"); sessionStorage.removeItem("uzumaki-user"); sessionStorage.removeItem("turnia-user"); render(); }
  if (action === "menu") document.querySelector("#sidebar")?.classList.toggle("open");
  if (action === "export-state-json") exportStateJson();
  if (action === "import-state-json") importStateJson();
  if (action === "toggle-schedule") { scheduleMode = scheduleMode === "official" ? "draft" : "official"; render(); }
  if (action === "cycle-shift") { const item = state.draft.find((s) => s.id === button.dataset.id); const states = ["working", "off", "sick", "leave"]; item.state = states[(states.indexOf(item.state) + 1) % states.length]; state.hasDraftChanges = true; persist(); }
  if (action === "publish") { state.schedule = structuredClone(state.draft); state.scheduleVersion += 1; state.hasDraftChanges = false; state.notifications.unshift({ id: crypto.randomUUID(), title: "Nueva grilla publicada", text: `La versión ${state.scheduleVersion} ya está disponible.`, time: "Ahora", type: "schedule", read: false }); audit("Publicó la grilla", `Semana 49 · v${state.scheduleVersion}`, "Publicada"); scheduleMode = "official"; persist(); toast(`Grilla versión ${state.scheduleVersion} publicada`); }
  if (action === "new-request") newRequestModal();
  if (action === "view-request") requestDetailModal(button.dataset.id);
  if (action === "open-revoke-request") revokeRequestModal(button.dataset.id);
  if (action === "new-user") newUserModal();
  if (action === "edit-user") editUserModal(button.dataset.id);
  if (action === "create-user-for-employee") createUserForEmployeeModal(button.dataset.id);
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
    const before = week.assignments.length;
    week.assignments = week.assignments.filter((assignment) => assignment.positionId !== button.dataset.positionId);
    if (week.assignments.length === before) return toast("No había asignación para quitar.", "error");
    closeModal(); persistPlanningWeekLifecycle(week); toast("Asignación quitada");
  }
  if (action === "remove-planning-day-off") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    const before = week.daysOff?.length || 0;
    week.daysOff = (week.daysOff || []).filter((dayOff) => dayOff.id !== button.dataset.dayOffId);
    if (week.daysOff.length === before) return toast("No se encontró el franco para quitar.", "error");
    closeModal(); persistPlanningWeekLifecycle(week); toast("Franco quitado");
  }
  if (action === "remove-week-exception") {
    const week = state.planningWeek;
    if (!week || !["draft", "published", "paused"].includes(week.status) || !canEditSchedule(user.role)) return;
    const exception = (week.exceptions || []).find((item) => item.id === button.dataset.exceptionId);
    if (!exception) return toast("No se encontró la excepción.", "error");
    week.exceptions = (week.exceptions || []).filter((item) => item.id !== exception.id);
    audit("Eliminó una excepción semanal", exceptionTypes[exception.type] || "Excepción", "Eliminada");
    persistPlanningWeekLifecycle(week); toast("Excepción eliminada");
  }
  if (action === "save-planning-week") savePlanningWeekToJson();
  if (action === "generate-planning-proposal") generatePlanningProposal();
  if (action === "publish-planning-week") publishPlanningWeek();
  if (action === "pause-planning-week") pausePlanningWeek();
  if (action === "draft-planning-week") draftPlanningWeek();
  if (action === "delete-planning-week") deletePlanningWeek();
  if (action === "close-modal") { if (event.target === button || button.classList.contains("modal-close") || button.tagName === "BUTTON") closeModal(); }
  if (action === "filter-request") { requestFilter = button.dataset.filter; render(); }
  if (action === "partner-resolve") {
    const request = state.requests.find((r) => r.id === button.dataset.id);
    const normalizedRequest = request ? normalizeRequestForView(request) : null;
    if (!request || normalizedRequest.partnerEmployeeId !== user.employeeId || normalizedRequest.status !== "pendingPartner") return toast("No se puede resolver esta solicitud.", "error");
    const accepted = button.dataset.status === "partnerAccepted";
    request.partnerStatus = accepted ? "accepted" : "rejected";
    request.status = accepted ? "pendingManager" : "partnerRejected";
    state.notifications.unshift({ id: crypto.randomUUID(), title: statusText[request.status], text: `${request.id} · ${requestTypes[normalizeRequestForView(request).type]}.`, time: "Ahora", type: "request", read: false });
    audit(`${accepted ? "Aceptó" : "Rechazó"} una solicitud como compañero`, request.id, statusText[request.status]);
    closeModal(); persist(); toast(statusText[request.status]);
  }
  if (action === "resolve") {
    const request = state.requests.find((r) => r.id === button.dataset.id);
    const normalizedRequest = request ? normalizeRequestForView(request) : null;
    if (!request || !canManagerResolveRequest(normalizedRequest)) return toast("La solicitud no está lista para resolver.", "error");
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
  if (action === "delete-user") {
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
  if (action === "read-notification") { const notification = state.notifications.find((n) => n.id === button.dataset.id); notification.read = true; persist(); }
  if (action === "read-all") { state.notifications.forEach((n) => n.read = true); persist(); toast("Notificaciones marcadas como leídas"); }
  if (action === "reset-demo") { state = resetState(state.stateRevision); persist(); toast("Datos iniciales restablecidos"); }
});

render();
