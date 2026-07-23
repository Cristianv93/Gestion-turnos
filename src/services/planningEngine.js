const requestTypeToException = {
  absence: "absence",
  leave: "leave",
};

const CYCLE_LENGTH_DAYS = 15;
const APPROVED_REQUEST_STATUSES = ["approved"];
const LEAVE_REQUEST_TYPES = ["absence", "leave", "vacation", "vacations"];
const ACTIVE_EXCEPTION_STATUSES = ["approved", "active", "covered"];
const FLOOR_COVERAGE_TEMPLATE_IDS = new Set([
  "floor-1-morning",
  "floor-2-morning",
  "floor-3-morning",
  "floor-1-afternoon",
  "floor-2-afternoon",
  "floor-3-afternoon",
]);
const FLOOR_COVERER_EMPLOYEE_IDS = ["emp-franquera-debora", "emp-franquera-lucila"];
const KITCHEN_MORNING_COLLABORATION_TEMPLATE_ID = "kitchen-extra-morning";
const FRANQUERA_PRIORITY_ANCHOR_WEEK_START = "2026-07-20";
const FRANQUERA_PRIORITY_ANCHOR_PATTERN = {
  morningEmployeeId: "emp-franquera-debora",
  afternoonEmployeeId: "emp-franquera-lucila",
};
const FRANQUERA_PRIORITY_ALTERNATION_PERIOD_WEEKS = 1;
const GUSTAVO_EMPLOYEE_ID = "emp-cocinero-manana-1";
const JULIO_EMPLOYEE_ID = "emp-cocinero-julio";
const GUSTAVO_MORNING_TEMPLATE_ID = "kitchen-cook-morning-2";
const JULIO_AFTERNOON_TEMPLATE_ID = "kitchen-cook-afternoon";

function isoDayNumber(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function dateInRange(date, startDate, endDate = startDate) {
  return Boolean(startDate && date >= startDate && date <= endDate);
}

function availabilityResult(employeeId, date, values = {}) {
  return {
    employeeId,
    date,
    available: true,
    reason: "available",
    dayOffType: null,
    source: "planningEngine",
    relatedRequestId: null,
    relatedExceptionId: null,
    ...values,
  };
}

function cycleConfiguration(employee) {
  const cycle = employee?.francoCycle;
  if (!cycle || !isIsoDate(cycle.anchorDate) || !["F1", "F2"].includes(cycle.anchorType) || cycle.cycleLengthDays !== CYCLE_LENGTH_DAYS) {
    return { configured: false, reason: "cycleNotConfigured" };
  }
  return { configured: true, ...cycle };
}

export function getCycleDayOff(employee, date) {
  const cycle = cycleConfiguration(employee);
  if (!cycle.configured || !isIsoDate(date)) {
    return { isDayOff: false, type: null, source: "calculatedCycle", reason: "cycleNotConfigured" };
  }
  const phase = ((isoDayNumber(date) - isoDayNumber(cycle.anchorDate)) % CYCLE_LENGTH_DAYS + CYCLE_LENGTH_DAYS) % CYCLE_LENGTH_DAYS;
  const type = cycle.anchorType === "F1"
    ? phase === 0 ? "F1" : [7, 8].includes(phase) ? "F2" : null
    : [0, 1].includes(phase) ? "F2" : phase === 8 ? "F1" : null;
  return { isDayOff: Boolean(type), type, source: "calculatedCycle" };
}

function calculatedCycleAvailability(employee, date) {
  const dayOff = getCycleDayOff(employee, date);
  if (dayOff.reason === "cycleNotConfigured") {
    return availabilityResult(employee?.id, date, { reason: "cycleNotConfigured", source: "calculatedCycle" });
  }
  return availabilityResult(employee.id, date, {
    available: !dayOff.isDayOff,
    reason: dayOff.isDayOff ? "dayOff" : "available",
    dayOffType: dayOff.type,
    source: "calculatedCycle",
  });
}

function manualDayOffAvailability(week, employeeId, date) {
  const dayOff = (week?.daysOff || []).find((item) => item.employeeId === employeeId && item.date === date);
  if (!dayOff) return null;
  return availabilityResult(employeeId, date, {
    available: false,
    reason: "dayOff",
    dayOffType: dayOff.tipo || null,
    source: "manualDayOff",
    dayOffId: dayOff.id,
  });
}

function requestDates(request) {
  const impact = request?.scheduleImpact || {};
  const target = impact.target || {};
  const proposed = impact.proposed || {};
  return {
    targetDate: target.date || request.targetDate || request.date,
    proposedDate: proposed.date || request.proposedDate,
    startDate: request.startDate || target.startDate || target.date || request.targetDate,
    endDate: request.endDate || target.endDate || target.date || request.targetDate,
  };
}

function approvedLeaveAvailability(requests, employeeId, date) {
  const request = (requests || []).find((item) => {
    if (!item || item.employeeId !== employeeId || !APPROVED_REQUEST_STATUSES.includes(item.status)) return false;
    if (!LEAVE_REQUEST_TYPES.includes(item.type)) return false;
    const dates = requestDates(item);
    return dateInRange(date, dates.startDate, dates.endDate);
  });
  if (!request) return null;
  return availabilityResult(employeeId, date, {
    available: false,
    reason: request.type === "vacations" ? "vacation" : request.type,
    source: "approvedRequest",
    relatedRequestId: request.id,
    requestType: request.type,
  });
}

function approvedAvailabilityRequest(requests, employeeId, date) {
  const request = (requests || []).find((item) => {
    if (!item || item.employeeId !== employeeId || !APPROVED_REQUEST_STATUSES.includes(item.status) || item.type !== "dayOffChange") return false;
    return requestDates(item).proposedDate === date;
  });
  if (!request) return null;
  return availabilityResult(employeeId, date, {
    available: false,
    reason: "dayOff",
    source: "approvedRequest",
    relatedRequestId: request.id,
    requestType: request.type,
  });
}

function employeeVacationAvailability(employee, date) {
  const vacation = (employee?.vacations || employee?.vacaciones || []).find((item) => dateInRange(date, item.startDate || item.inicio || item.fecha, item.endDate || item.fin || item.fecha));
  if (!vacation) return null;
  return availabilityResult(employee.id, date, {
    available: false,
    reason: "vacation",
    source: "employeeVacation",
    vacationId: vacation.id,
  });
}

function weeklyExceptionAvailability(week, employeeId, date) {
  const exception = (week?.exceptions || []).find((item) => {
    const isApproved = !item.status || ACTIVE_EXCEPTION_STATUSES.includes(item.status);
    return isApproved && item.affectedEmployeeId === employeeId && item.date === date;
  });
  if (!exception) return null;
  return availabilityResult(employeeId, date, {
    available: false,
    reason: exception.type || "exception",
    source: "weeklyException",
    relatedExceptionId: exception.id,
    relatedRequestId: exception.sourceRequestId || null,
  });
}

export function getEmployeeAvailability({ employee, date, week = null, requests = [] }) {
  if (!employee?.id || !date) {
    return availabilityResult(employee?.id, date, { available: false, reason: "invalidInput" });
  }
  if (employee.status !== "active" || employee.participaEnOperacion === false) {
    return availabilityResult(employee.id, date, { available: false, reason: "notOperational", source: "employeeStatus" });
  }
  return employeeVacationAvailability(employee, date)
    || approvedLeaveAvailability(requests, employee.id, date)
    || weeklyExceptionAvailability(week, employee.id, date)
    || approvedAvailabilityRequest(requests, employee.id, date)
    || manualDayOffAvailability(week, employee.id, date)
    || calculatedCycleAvailability(employee, date);
}

export function buildAvailabilityMap({ employees = [], dates = [], week = null, requests = [] }) {
  return employees.reduce((map, employee) => {
    map[employee.id] = dates.reduce((employeeMap, date) => {
      employeeMap[date] = getEmployeeAvailability({ employee, date, week, requests });
      return employeeMap;
    }, {});
    return map;
  }, {});
}

export function buildWeeklyAvailabilityMap(employees = [], week = null, context = {}) {
  const dates = [...new Set((week?.operationalPositions || []).map((position) => position.date).filter(Boolean))].sort();
  return buildAvailabilityMap({ employees, dates, week, requests: context.requests || [] });
}

export function buildDailyDaysOffSummary({ employees = [], week = null, availabilityMap = {} } = {}) {
  const dates = [...new Set((week?.operationalPositions || []).map((position) => position.date).filter(Boolean))].sort();
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const summary = ["Cocina", "Pisos"].reduce((map, sector) => {
    map[sector] = dates.reduce((dateMap, date) => {
      dateMap[date] = [];
      return dateMap;
    }, {});
    return map;
  }, {});
  const manualKeys = new Set();

  (week?.daysOff || []).forEach((dayOff) => {
    const employee = employeesById.get(dayOff.employeeId);
    const sector = dayOff.sector || employee?.sector;
    if (!employee || !["Cocina", "Pisos"].includes(sector) || !summary[sector]?.[dayOff.date]) return;
    const key = `${dayOff.employeeId}:${dayOff.date}`;
    if (manualKeys.has(key)) return;
    manualKeys.add(key);
    summary[sector][dayOff.date].push({
      employeeId: employee.id,
      name: employee.name,
      sector,
      date: dayOff.date,
      type: dayOff.tipo || null,
      source: "manualDayOff",
      dayOffId: dayOff.id,
    });
  });

  employees.forEach((employee) => {
    if (!employee?.id || employee.status !== "active" || employee.participaEnOperacion === false || !["Cocina", "Pisos"].includes(employee.sector)) return;
    dates.forEach((date) => {
      const key = `${employee.id}:${date}`;
      if (manualKeys.has(key)) return;
      const availability = availabilityMap[employee.id]?.[date];
      if (availability?.available === false && availability.reason === "dayOff" && availability.source === "calculatedCycle" && availability.dayOffType) {
        summary[employee.sector][date].push({
          employeeId: employee.id,
          name: employee.name,
          sector: employee.sector,
          date,
          type: availability.dayOffType,
          source: "calculatedCycle",
        });
      }
    });
  });

  Object.values(summary).forEach((sectorMap) => {
    Object.values(sectorMap).forEach((records) => records.sort((a, b) => a.name.localeCompare(b.name)));
  });

  return summary;
}

export function getHabitualEmployeeForPosition(employees = [], position = null) {
  if (!position?.templateId) return null;
  return employees.find((employee) => employee.habitualPositionTemplateId === position.templateId) || null;
}

export function generateHabitualAssignments({ week = null, employees = [], availabilityMap = {} } = {}) {
  if (!week || !Array.isArray(week.operationalPositions)) return [];
  const positionsById = new Map(week.operationalPositions.map((position) => [position.id, position]));
  const occupiedPositions = new Set((week.assignments || []).map((assignment) => assignment.positionId));
  const assignedByDay = new Set((week.assignments || []).flatMap((assignment) => {
    const position = positionsById.get(assignment.positionId);
    return position?.date ? [`${position.date}:${assignment.employeeId}`] : [];
  }));
  const proposals = [];

  week.operationalPositions.forEach((position) => {
    if (occupiedPositions.has(position.id)) return;
    const employee = getHabitualEmployeeForPosition(employees, position);
    if (!employee || employee.status !== "active" || employee.participaEnOperacion === false) return;
    if (availabilityMap[employee.id]?.[position.date]?.available !== true) return;
    const dailyKey = `${position.date}:${employee.id}`;
    if (assignedByDay.has(dailyKey)) return;
    proposals.push({
      positionId: position.id,
      employeeId: employee.id,
      generated: true,
      generationReason: "habitualPosition",
    });
    occupiedPositions.add(position.id);
    assignedByDay.add(dailyKey);
  });

  return proposals;
}

export function applyGustavoJulioException({
  week = null,
  employees = [],
  availabilityMap = {},
  pendingAssignments = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!week || !Array.isArray(week.operationalPositions)) {
    return { assignments: pendingAssignments, coverages: [], removedAssignments: [], skipped: [] };
  }
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const gustavo = employeesById.get(GUSTAVO_EMPLOYEE_ID);
  const adjustedAssignments = [...pendingAssignments];
  const coverages = [];
  const removedAssignments = [];
  const skipped = [];
  const dates = [...new Set(week.operationalPositions.map((position) => position.date).filter(Boolean))].sort();

  dates.forEach((date) => {
    const targetPosition = week.operationalPositions.find((position) => position.date === date && position.templateId === JULIO_AFTERNOON_TEMPLATE_ID);
    const sourcePosition = week.operationalPositions.find((position) => position.date === date && position.templateId === GUSTAVO_MORNING_TEMPLATE_ID);
    if (!targetPosition || !sourcePosition) return;
    if (availabilityMap[JULIO_EMPLOYEE_ID]?.[date]?.available === true) {
      skipped.push({ date, reason: "julioAvailable" });
      return;
    }
    if (!gustavo || gustavo.status !== "active" || gustavo.participaEnOperacion === false || availabilityMap[GUSTAVO_EMPLOYEE_ID]?.[date]?.available !== true) {
      skipped.push({ date, reason: "gustavoUnavailable" });
      return;
    }
    const existingRecords = assignmentRecordsForWeek(week);
    const existingTarget = existingRecords.find(({ position }) => position.id === targetPosition.id);
    if (existingTarget) {
      skipped.push({ date, reason: "julioPositionAlreadyAssigned" });
      return;
    }
    const existingGustavoAssignment = existingRecords.find(({ assignment, position }) => assignment.employeeId === GUSTAVO_EMPLOYEE_ID && position.date === date);
    if (existingGustavoAssignment) {
      skipped.push({ date, reason: "gustavoManualAssignment" });
      return;
    }
    const morningProposalIndex = adjustedAssignments.findIndex((assignment) => {
      if (assignment.employeeId !== GUSTAVO_EMPLOYEE_ID || assignment.generationReason !== "habitualPosition") return false;
      const position = week.operationalPositions.find((item) => item.id === assignment.positionId);
      return position?.date === date && position.templateId === GUSTAVO_MORNING_TEMPLATE_ID;
    });
    if (morningProposalIndex >= 0) {
      const [removed] = adjustedAssignments.splice(morningProposalIndex, 1);
      removedAssignments.push({ ...removed, removedReason: "gustavoCoversJulio" });
    }
    const indexes = assignmentIndexes(week, adjustedAssignments);
    if (indexes.occupiedPositions.has(targetPosition.id) || indexes.assignedByDay.has(`${date}:${GUSTAVO_EMPLOYEE_ID}`)) {
      skipped.push({ date, reason: "targetOccupiedOrDuplicate" });
      return;
    }
    const proposal = {
      positionId: targetPosition.id,
      employeeId: GUSTAVO_EMPLOYEE_ID,
      generated: true,
      generationReason: "gustavoCoversJulio",
      assignmentType: "coverage",
      coverageReason: "gustavoCoversJulio",
      coveredEmployeeId: JULIO_EMPLOYEE_ID,
      sourcePositionTemplateId: GUSTAVO_MORNING_TEMPLATE_ID,
      targetPositionTemplateId: JULIO_AFTERNOON_TEMPLATE_ID,
      generatedByPlanningEngine: true,
      generatedAt,
    };
    adjustedAssignments.push(proposal);
    coverages.push(proposal);
  });

  return { assignments: adjustedAssignments, coverages, removedAssignments, skipped };
}

function assignmentRecordsForWeek(week = null, extraAssignments = []) {
  const positionsById = new Map((week?.operationalPositions || []).map((position) => [position.id, position]));
  return [...(week?.assignments || []), ...extraAssignments]
    .map((assignment) => ({ assignment, position: positionsById.get(assignment.positionId) }))
    .filter(({ assignment, position }) => assignment?.employeeId && position?.id);
}

function assignmentIndexes(week = null, extraAssignments = []) {
  const records = assignmentRecordsForWeek(week, extraAssignments);
  return records.reduce((indexes, { assignment, position }) => {
    indexes.occupiedPositions.add(position.id);
    if (position.date) indexes.assignedByDay.add(`${position.date}:${assignment.employeeId}`);
    return indexes;
  }, { occupiedPositions: new Set(), assignedByDay: new Set() });
}

function floorCoverageHistoryScore(weeklySchedules = [], employeeId, position) {
  return (weeklySchedules || []).reduce((score, schedule) => {
    return score + (schedule.assignments || []).reduce((weekScore, assignment) => {
      if (assignment.employeeId !== employeeId) return weekScore;
      const assignedPosition = (schedule.operationalPositions || []).find((item) => item.id === assignment.positionId);
      if (!assignedPosition || assignedPosition.sector !== "Pisos") return weekScore;
      if (assignedPosition.templateId === position.templateId) return weekScore + 3;
      if (assignedPosition.shift === position.shift) return weekScore + 1;
      return weekScore;
    }, 0);
  }, 0);
}

export function getWeeklyFranqueraPriority(weekStartDate) {
  if (!isIsoDate(weekStartDate)) {
    return {
      morningEmployeeId: FRANQUERA_PRIORITY_ANCHOR_PATTERN.morningEmployeeId,
      afternoonEmployeeId: FRANQUERA_PRIORITY_ANCHOR_PATTERN.afternoonEmployeeId,
      anchorWeekStart: FRANQUERA_PRIORITY_ANCHOR_WEEK_START,
      weekOffset: 0,
      pattern: "anchor",
      source: "weeklyAlternation",
    };
  }
  const weekOffset = Math.floor((isoDayNumber(weekStartDate) - isoDayNumber(FRANQUERA_PRIORITY_ANCHOR_WEEK_START)) / 7);
  const isAnchorPattern = ((weekOffset % 2) + 2) % 2 === 0;
  return {
    morningEmployeeId: isAnchorPattern ? FRANQUERA_PRIORITY_ANCHOR_PATTERN.morningEmployeeId : FRANQUERA_PRIORITY_ANCHOR_PATTERN.afternoonEmployeeId,
    afternoonEmployeeId: isAnchorPattern ? FRANQUERA_PRIORITY_ANCHOR_PATTERN.afternoonEmployeeId : FRANQUERA_PRIORITY_ANCHOR_PATTERN.morningEmployeeId,
    anchorWeekStart: FRANQUERA_PRIORITY_ANCHOR_WEEK_START,
    weekOffset,
    pattern: isAnchorPattern ? "anchor" : "inverted",
    alternationPeriodWeeks: FRANQUERA_PRIORITY_ALTERNATION_PERIOD_WEEKS,
    source: "weeklyAlternation",
  };
}

function floorPriorityEmployeeId(priority, shift) {
  return shift === "Mañana" ? priority.morningEmployeeId : shift === "Tarde" ? priority.afternoonEmployeeId : null;
}

function chooseFloorCoverer({ candidates = [], position = null, weeklySchedules = [], priority = null } = {}) {
  const priorityEmployeeId = floorPriorityEmployeeId(priority || {}, position?.shift);
  return [...candidates].sort((left, right) => {
    const priorityDiff = Number(right.id === priorityEmployeeId) - Number(left.id === priorityEmployeeId);
    if (priorityDiff !== 0) return priorityDiff;
    const scoreDiff = floorCoverageHistoryScore(weeklySchedules, right.id, position) - floorCoverageHistoryScore(weeklySchedules, left.id, position);
    if (scoreDiff !== 0) return scoreDiff;
    return left.id.localeCompare(right.id);
  })[0] || null;
}

export function generateFloorCoverageAssignments({
  week = null,
  employees = [],
  availabilityMap = {},
  weeklySchedules = [],
  pendingAssignments = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!week || !Array.isArray(week.operationalPositions)) return { assignments: [], uncovered: [] };
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const coverers = FLOOR_COVERER_EMPLOYEE_IDS.map((id) => employeesById.get(id)).filter(Boolean);
  const indexes = assignmentIndexes(week, pendingAssignments);
  const priority = getWeeklyFranqueraPriority(week.startDate);
  const assignments = [];
  const uncovered = [];

  week.operationalPositions.forEach((position) => {
    if (!FLOOR_COVERAGE_TEMPLATE_IDS.has(position.templateId)) return;
    if (indexes.occupiedPositions.has(position.id)) return;
    const candidates = coverers.filter((employee) => {
      if (employee.status !== "active" || employee.participaEnOperacion === false) return false;
      if (availabilityMap[employee.id]?.[position.date]?.available !== true) return false;
      return !indexes.assignedByDay.has(`${position.date}:${employee.id}`);
    });
    const coverer = chooseFloorCoverer({ candidates, position, weeklySchedules, priority });
    if (!coverer) {
      uncovered.push({
        positionId: position.id,
        date: position.date,
        shift: position.shift,
        templateId: position.templateId,
        label: position.label,
        reason: "noAvailableFloorCoverer",
      });
      return;
    }
    const habitualEmployee = getHabitualEmployeeForPosition(employees, position);
    const proposal = {
      positionId: position.id,
      employeeId: coverer.id,
      generated: true,
      generationReason: "floorCoverage",
      assignmentType: "coverage",
      coverageReason: "habitualEmployeeUnavailable",
      coveredPositionTemplateId: position.templateId,
      coveredEmployeeId: habitualEmployee?.id || null,
      generatedByPlanningEngine: true,
      generatedAt,
    };
    assignments.push(proposal);
    indexes.occupiedPositions.add(position.id);
    indexes.assignedByDay.add(`${position.date}:${coverer.id}`);
  });

  return { assignments, uncovered };
}

function kitchenCollaborationHistoryScore(weeklySchedules = [], employeeId) {
  return (weeklySchedules || []).reduce((score, schedule) => {
    return score + (schedule.assignments || []).reduce((weekScore, assignment) => {
      if (assignment.employeeId !== employeeId) return weekScore;
      const assignedPosition = (schedule.operationalPositions || []).find((item) => item.id === assignment.positionId);
      if (assignedPosition?.sector === "Cocina" && assignedPosition.shift === "Mañana") return weekScore + 1;
      return weekScore;
    }, 0);
  }, 0);
}

function chooseKitchenCollaborator({ candidates = [], weeklySchedules = [] } = {}) {
  return [...candidates].sort((left, right) => {
    const scoreDiff = kitchenCollaborationHistoryScore(weeklySchedules, right.id) - kitchenCollaborationHistoryScore(weeklySchedules, left.id);
    if (scoreDiff !== 0) return scoreDiff;
    return left.id.localeCompare(right.id);
  })[0] || null;
}

function floorIsFullyCoveredForDate(week, date, occupiedPositions) {
  const floorPositions = (week?.operationalPositions || []).filter((position) => position.date === date && FLOOR_COVERAGE_TEMPLATE_IDS.has(position.templateId));
  return floorPositions.length > 0 && floorPositions.every((position) => occupiedPositions.has(position.id));
}

export function generateKitchenMorningCollaborationAssignments({
  week = null,
  employees = [],
  availabilityMap = {},
  weeklySchedules = [],
  pendingAssignments = [],
  floorCoverageGaps = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!week || !Array.isArray(week.operationalPositions)) return [];
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const coverers = FLOOR_COVERER_EMPLOYEE_IDS.map((id) => employeesById.get(id)).filter(Boolean);
  const indexes = assignmentIndexes(week, pendingAssignments);
  const gapDates = new Set((floorCoverageGaps || []).map((gap) => gap.date).filter(Boolean));
  const assignments = [];
  const dates = [...new Set(week.operationalPositions.map((position) => position.date).filter(Boolean))].sort();

  dates.forEach((date) => {
    if (gapDates.has(date)) return;
    if (!floorIsFullyCoveredForDate(week, date, indexes.occupiedPositions)) return;
    const position = week.operationalPositions.find((item) => item.date === date && item.templateId === KITCHEN_MORNING_COLLABORATION_TEMPLATE_ID);
    if (!position || indexes.occupiedPositions.has(position.id)) return;
    const candidates = coverers.filter((employee) => {
      if (employee.status !== "active" || employee.participaEnOperacion === false) return false;
      if (availabilityMap[employee.id]?.[date]?.available !== true) return false;
      return !indexes.assignedByDay.has(`${date}:${employee.id}`);
    });
    const collaborator = chooseKitchenCollaborator({ candidates, weeklySchedules });
    if (!collaborator) return;
    const proposal = {
      positionId: position.id,
      employeeId: collaborator.id,
      generated: true,
      generationReason: "kitchenMorningCollaboration",
      assignmentType: "collaboration",
      collaborationArea: "kitchen",
      collaborationShift: "morning",
      generatedByPlanningEngine: true,
      generatedAt,
    };
    assignments.push(proposal);
    indexes.occupiedPositions.add(position.id);
    indexes.assignedByDay.add(`${date}:${collaborator.id}`);
  });

  return assignments;
}

function sameDayDuplicate(week, position, employeeId) {
  return (week.assignments || []).some((assignment) => {
    if (assignment.positionId === position.id || assignment.employeeId !== employeeId) return false;
    const assignedPosition = week.operationalPositions.find((item) => item.id === assignment.positionId);
    return assignedPosition?.date === position.date;
  });
}

function employeeIsAvailable(employees, employeeId) {
  return employees.some((employee) => employee.id === employeeId && employee.status === "active" && employee.participaEnOperacion !== false);
}

function findAssignmentRecord(week, employeeId, date, shift) {
  return (week.assignments || [])
    .map((assignment) => ({
      assignment,
      position: week.operationalPositions.find((position) => position.id === assignment.positionId),
    }))
    .find(({ assignment, position }) => assignment.employeeId === employeeId && position?.date === date && position.shift === shift);
}

function hasDuplicateAfterChange(week, position, employeeId, excludedPositionIds = []) {
  return (week.assignments || []).some((assignment) => {
    if (assignment.employeeId !== employeeId || excludedPositionIds.includes(assignment.positionId)) return false;
    const assignedPosition = week.operationalPositions.find((item) => item.id === assignment.positionId);
    return assignedPosition?.date === position.date;
  });
}

function manualReview(message, trace = {}) {
  return { ok: true, reverted: false, requiresManualReview: true, message, trace };
}

export function applyApprovedAbsenceOrLeave({ week, request, coverEmployeeId, approvedBy, employees, createId, now }) {
  if (!week || !["draft", "published"].includes(week.status)) {
    return { ok: false, message: "No hay una planificación semanal editable para aplicar la solicitud." };
  }
  if (!["absence", "leave"].includes(request.type)) {
    return { ok: false, message: "El Motor de Planificación sólo aplica licencias y ausencias en esta etapa." };
  }
  const target = request.scheduleImpact?.target;
  if (!target?.date || !target?.shift || !request.employeeId) {
    return { ok: false, message: "No hay información suficiente para calcular el impacto." };
  }
  if (!employeeIsAvailable(employees, coverEmployeeId)) {
    return { ok: false, message: "Seleccioná una persona válida para cubrir el puesto." };
  }
  if (coverEmployeeId === request.employeeId) {
    return { ok: false, message: "La persona afectada no puede cubrir su propia licencia o ausencia." };
  }

  const sourceRecord = (week.assignments || [])
    .map((assignment) => ({
      assignment,
      position: week.operationalPositions.find((position) => position.id === assignment.positionId),
    }))
    .find(({ assignment, position }) => assignment.employeeId === request.employeeId && position?.date === target.date && position.shift === target.shift);

  if (!sourceRecord?.assignment || !sourceRecord.position) {
    return { ok: false, message: "No se encontró el puesto original afectado en la planificación." };
  }
  if (sameDayDuplicate(week, sourceRecord.position, coverEmployeeId)) {
    return { ok: false, message: "La persona reemplazante ya está asignada ese mismo día." };
  }

  const appliedAt = now();
  if (!Array.isArray(week.exceptions)) week.exceptions = [];
  sourceRecord.assignment.employeeId = coverEmployeeId;
  sourceRecord.assignment.coverageType = "replacement";
  sourceRecord.assignment.sourceRequestId = request.id;
  sourceRecord.assignment.replacedEmployeeId = request.employeeId;
  sourceRecord.assignment.appliedByPlanningEngine = true;
  sourceRecord.assignment.appliedAt = appliedAt;
  sourceRecord.assignment.appliedBy = approvedBy;
  const exception = {
    id: createId(),
    positionId: sourceRecord.position.id,
    date: sourceRecord.position.date,
    shift: sourceRecord.position.shift,
    sector: sourceRecord.position.sector,
    affectedEmployeeId: request.employeeId,
    type: requestTypeToException[request.type],
    coverEmployeeId,
    note: `Aplicada automáticamente desde la solicitud ${request.id}.`,
    coverageType: "replacement",
    status: "covered",
    sourceRequestId: request.id,
    sourceRequestType: request.type,
    appliedBy: approvedBy,
    appliedAt,
    updatedAt: appliedAt,
    updatedBy: approvedBy,
    createdAt: appliedAt,
    appliedByPlanningEngine: true,
  };
  week.exceptions.push(exception);

  return {
    ok: true,
    exception,
    assignment: sourceRecord.assignment,
    position: sourceRecord.position,
    trace: {
      sourceRequestId: request.id,
      affectedEmployeeId: request.employeeId,
      coverEmployeeId,
      positionId: sourceRecord.position.id,
      date: sourceRecord.position.date,
      shift: sourceRecord.position.shift,
      approvedBy,
      appliedAt,
    },
  };
}

export function applyApprovedShiftChange({ week, request, approvedBy, employees, now }) {
  if (!week || !["draft", "published"].includes(week.status)) {
    return { ok: false, message: "No hay una planificación semanal editable para aplicar la solicitud." };
  }
  if (request.type !== "shiftChange") {
    return { ok: false, message: "El Motor de Planificación sólo aplica cambios de turno en esta regla." };
  }
  if (request.partnerStatus !== "accepted" && request.status !== "partnerAccepted") {
    return { ok: false, message: "El compañero debe aceptar la solicitud antes de aplicarla." };
  }

  const original = request.scheduleImpact?.original;
  const proposed = request.scheduleImpact?.proposed;
  if (!original?.date || !original?.shift || !proposed?.date || !proposed?.shift || !request.employeeId || !request.partnerEmployeeId) {
    return { ok: false, message: "No hay información suficiente para aplicar el cambio de turno." };
  }
  if (request.employeeId === request.partnerEmployeeId) {
    return { ok: false, message: "La persona solicitante y el compañero no pueden ser la misma persona." };
  }
  if (!employeeIsAvailable(employees, request.employeeId) || !employeeIsAvailable(employees, request.partnerEmployeeId)) {
    return { ok: false, message: "La solicitud incluye una persona no disponible para operación." };
  }

  const requesterRecord = findAssignmentRecord(week, request.employeeId, original.date, original.shift);
  const partnerRecord = findAssignmentRecord(week, request.partnerEmployeeId, proposed.date, proposed.shift);
  if (!requesterRecord?.assignment || !requesterRecord.position) {
    return { ok: false, message: "No se encontró el puesto original de la persona solicitante." };
  }
  if (!partnerRecord?.assignment || !partnerRecord.position) {
    return { ok: false, message: "No se encontró el puesto original del compañero involucrado." };
  }

  const excludedPositionIds = [requesterRecord.position.id, partnerRecord.position.id];
  if (hasDuplicateAfterChange(week, partnerRecord.position, request.employeeId, excludedPositionIds)) {
    return { ok: false, message: "La persona solicitante quedaría duplicada ese día." };
  }
  if (hasDuplicateAfterChange(week, requesterRecord.position, request.partnerEmployeeId, excludedPositionIds)) {
    return { ok: false, message: "El compañero quedaría duplicado ese día." };
  }

  const appliedAt = now();
  requesterRecord.assignment.employeeId = request.partnerEmployeeId;
  requesterRecord.assignment.swapType = "shiftChange";
  requesterRecord.assignment.sourceRequestId = request.id;
  requesterRecord.assignment.swappedWithEmployeeId = request.employeeId;
  requesterRecord.assignment.appliedByPlanningEngine = true;
  requesterRecord.assignment.appliedAt = appliedAt;
  requesterRecord.assignment.appliedBy = approvedBy;

  partnerRecord.assignment.employeeId = request.employeeId;
  partnerRecord.assignment.swapType = "shiftChange";
  partnerRecord.assignment.sourceRequestId = request.id;
  partnerRecord.assignment.swappedWithEmployeeId = request.partnerEmployeeId;
  partnerRecord.assignment.appliedByPlanningEngine = true;
  partnerRecord.assignment.appliedAt = appliedAt;
  partnerRecord.assignment.appliedBy = approvedBy;

  return {
    ok: true,
    assignments: [requesterRecord.assignment, partnerRecord.assignment],
    positions: [requesterRecord.position, partnerRecord.position],
    trace: {
      sourceRequestId: request.id,
      requesterEmployeeId: request.employeeId,
      partnerEmployeeId: request.partnerEmployeeId,
      original: {
        date: original.date,
        shift: original.shift,
        positionId: requesterRecord.position.id,
        assignedEmployeeId: request.partnerEmployeeId,
      },
      proposed: {
        date: proposed.date,
        shift: proposed.shift,
        positionId: partnerRecord.position.id,
        assignedEmployeeId: request.employeeId,
      },
      affectedPositionIds: [requesterRecord.position.id, partnerRecord.position.id],
      approvedBy,
      appliedAt,
      appliedByPlanningEngine: true,
    },
  };
}

function revokeAbsenceOrLeave({ week, request, revokedBy, reason, now }) {
  const trace = request.planningApplication || {};
  const position = week.operationalPositions.find((item) => item.id === trace.positionId);
  const assignment = (week.assignments || []).find((item) => item.positionId === trace.positionId && item.sourceRequestId === request.id);
  if (!position || !assignment) {
    return manualReview("No se encontró la asignación aplicada por el Motor de Planificación.", { sourceRequestId: request.id });
  }
  if (assignment.employeeId !== trace.coverEmployeeId || assignment.replacedEmployeeId !== trace.affectedEmployeeId) {
    return manualReview("La asignación fue modificada luego de la aprobación. Revisar la grilla manualmente.", { sourceRequestId: request.id, positionId: position.id });
  }
  if (sameDayDuplicate(week, position, trace.affectedEmployeeId)) {
    return manualReview("La persona original ya está asignada ese día. Revisar la grilla manualmente.", { sourceRequestId: request.id, positionId: position.id });
  }

  const revokedAt = now();
  assignment.employeeId = trace.affectedEmployeeId;
  assignment.revokedSourceRequestId = request.id;
  assignment.revokedByPlanningEngine = true;
  assignment.revokedAt = revokedAt;
  assignment.revokedBy = revokedBy;
  assignment.revocationReason = reason;
  delete assignment.coverageType;
  delete assignment.sourceRequestId;
  delete assignment.replacedEmployeeId;
  delete assignment.appliedByPlanningEngine;

  const exception = (week.exceptions || []).find((item) => item.sourceRequestId === request.id && item.appliedByPlanningEngine);
  if (exception) {
    exception.status = "revoked";
    exception.revokedAt = revokedAt;
    exception.revokedBy = revokedBy;
    exception.revocationReason = reason;
    exception.updatedAt = revokedAt;
    exception.updatedBy = revokedBy;
  }

  return {
    ok: true,
    reverted: true,
    requiresManualReview: false,
    message: "Revocación aplicada automáticamente.",
    trace: {
      sourceRequestId: request.id,
      revokedChangeType: request.type,
      positionId: position.id,
      affectedEmployeeId: trace.affectedEmployeeId,
      coverEmployeeId: trace.coverEmployeeId,
      revokedBy,
      revokedAt,
      reason,
      changesReverted: [{ positionId: position.id, restoredEmployeeId: trace.affectedEmployeeId }],
      automatic: true,
    },
  };
}

function revokeShiftChange({ week, request, revokedBy, reason, now }) {
  const trace = request.planningApplication || {};
  const originalPositionId = trace.original?.positionId;
  const proposedPositionId = trace.proposed?.positionId;
  const requesterEmployeeId = trace.requesterEmployeeId;
  const partnerEmployeeId = trace.partnerEmployeeId;
  const originalPosition = week.operationalPositions.find((item) => item.id === originalPositionId);
  const proposedPosition = week.operationalPositions.find((item) => item.id === proposedPositionId);
  const originalAssignment = (week.assignments || []).find((item) => item.positionId === originalPositionId && item.sourceRequestId === request.id);
  const proposedAssignment = (week.assignments || []).find((item) => item.positionId === proposedPositionId && item.sourceRequestId === request.id);
  if (!originalPosition || !proposedPosition || !originalAssignment || !proposedAssignment) {
    return manualReview("No se encontraron las dos asignaciones aplicadas por el cambio de turno.", { sourceRequestId: request.id });
  }
  if (originalAssignment.employeeId !== partnerEmployeeId || proposedAssignment.employeeId !== requesterEmployeeId) {
    return manualReview("El cambio de turno fue modificado luego de la aprobación. Revisar la grilla manualmente.", { sourceRequestId: request.id, affectedPositionIds: [originalPositionId, proposedPositionId] });
  }

  const excludedPositionIds = [originalPositionId, proposedPositionId];
  if (hasDuplicateAfterChange(week, originalPosition, requesterEmployeeId, excludedPositionIds)) {
    return manualReview("La persona solicitante ya está asignada ese día. Revisar la grilla manualmente.", { sourceRequestId: request.id, positionId: originalPositionId });
  }
  if (hasDuplicateAfterChange(week, proposedPosition, partnerEmployeeId, excludedPositionIds)) {
    return manualReview("El compañero ya está asignado ese día. Revisar la grilla manualmente.", { sourceRequestId: request.id, positionId: proposedPositionId });
  }

  const revokedAt = now();
  originalAssignment.employeeId = requesterEmployeeId;
  proposedAssignment.employeeId = partnerEmployeeId;
  [originalAssignment, proposedAssignment].forEach((assignment) => {
    assignment.revokedSourceRequestId = request.id;
    assignment.revokedByPlanningEngine = true;
    assignment.revokedAt = revokedAt;
    assignment.revokedBy = revokedBy;
    assignment.revocationReason = reason;
    delete assignment.swapType;
    delete assignment.sourceRequestId;
    delete assignment.swappedWithEmployeeId;
    delete assignment.appliedByPlanningEngine;
  });

  return {
    ok: true,
    reverted: true,
    requiresManualReview: false,
    message: "Revocación aplicada automáticamente.",
    trace: {
      sourceRequestId: request.id,
      revokedChangeType: request.type,
      requesterEmployeeId,
      partnerEmployeeId,
      original: { positionId: originalPositionId, restoredEmployeeId: requesterEmployeeId, date: originalPosition.date, shift: originalPosition.shift },
      proposed: { positionId: proposedPositionId, restoredEmployeeId: partnerEmployeeId, date: proposedPosition.date, shift: proposedPosition.shift },
      affectedPositionIds: excludedPositionIds,
      revokedBy,
      revokedAt,
      reason,
      changesReverted: [
        { positionId: originalPositionId, restoredEmployeeId: requesterEmployeeId },
        { positionId: proposedPositionId, restoredEmployeeId: partnerEmployeeId },
      ],
      automatic: true,
    },
  };
}

export function revokePlanningApplication({ week, request, revokedBy, reason, now }) {
  if (!week || !["draft", "published"].includes(week.status)) {
    return manualReview("No hay una planificación semanal editable para revertir automáticamente.", { sourceRequestId: request?.id });
  }
  if (!reason?.trim()) {
    return { ok: false, message: "Indicá un motivo de revocación." };
  }
  if (!request?.planningApplication?.sourceRequestId) {
    return manualReview("La solicitud no tiene trazabilidad suficiente para revertir automáticamente.", { sourceRequestId: request?.id });
  }
  if (["absence", "leave"].includes(request.type)) {
    return revokeAbsenceOrLeave({ week, request, revokedBy, reason: reason.trim(), now });
  }
  if (request.type === "shiftChange") {
    return revokeShiftChange({ week, request, revokedBy, reason: reason.trim(), now });
  }
  return { ok: false, message: "Este tipo de solicitud todavía no admite revocación automática." };
}
