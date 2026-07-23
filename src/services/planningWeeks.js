const OPERATIONAL_POSITION_TEMPLATES = [
  { id: "kitchen-cook-morning-1", sector: "Cocina", shift: "Mañana", label: "Cocina Mañana · Puesto 1", slot: 1, floor: null, optional: true },
  { id: "kitchen-cook-morning-2", sector: "Cocina", shift: "Mañana", label: "Cocina Mañana · Puesto 2", slot: 2, floor: null, optional: true },
  { id: "kitchen-assistant-morning", sector: "Cocina", shift: "Mañana", label: "Cocina Mañana · Puesto 3", slot: 3, floor: null, optional: true },
  { id: "kitchen-extra-morning", sector: "Cocina", shift: "Mañana", label: "Cocina Mañana · Apoyo", slot: 4, floor: null, optional: true },
  { id: "kitchen-cook-afternoon", sector: "Cocina", shift: "Tarde", label: "Cocina Tarde · Puesto 1", slot: 1, floor: null, optional: true },
  { id: "kitchen-assistant-afternoon", sector: "Cocina", shift: "Tarde", label: "Cocina Tarde · Puesto 2", slot: 2, floor: null, optional: true },
  { id: "kitchen-extra-afternoon", sector: "Cocina", shift: "Tarde", label: "Cocina Tarde · Puesto 3", slot: 3, floor: null, optional: true },
  { id: "floor-1-morning", sector: "Pisos", shift: "Mañana", label: "Piso 1 Mañana", slot: null, floor: 1 },
  { id: "floor-2-morning", sector: "Pisos", shift: "Mañana", label: "Piso 2 Mañana", slot: null, floor: 2 },
  { id: "floor-3-morning", sector: "Pisos", shift: "Mañana", label: "Piso 3 Mañana", slot: null, floor: 3 },
  { id: "floor-1-afternoon", sector: "Pisos", shift: "Tarde", label: "Piso 1 Tarde", slot: null, floor: 1 },
  { id: "floor-2-afternoon", sector: "Pisos", shift: "Tarde", label: "Piso 2 Tarde", slot: null, floor: 2 },
  { id: "floor-3-afternoon", sector: "Pisos", shift: "Tarde", label: "Piso 3 Tarde", slot: null, floor: 3 },
];

function addDays(isoDate, amount) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function createOperationalPositions(weekId, startDate) {
  return Array.from({ length: 7 }, (_, dayIndex) => {
    const date = addDays(startDate, dayIndex);
    return OPERATIONAL_POSITION_TEMPLATES.map((template) => ({
      id: `${weekId}:${date}:${template.id}`,
      templateId: template.id,
      date,
      dayIndex,
      sector: template.sector,
      shift: template.shift,
      label: template.label,
      slot: template.slot,
      floor: template.floor,
      optional: Boolean(template.optional),
    }));
  }).flat();
}

export function ensureKitchenPlanningSlots(week) {
  if (!week?.operationalPositions?.length) return week;
  const kitchenTemplates = OPERATIONAL_POSITION_TEMPLATES.filter((template) => template.sector === "Cocina");
  const dates = [...new Set(week.operationalPositions.map((position) => position.date))];
  dates.forEach((date) => {
    const dayIndex = week.operationalPositions.find((position) => position.date === date)?.dayIndex || 0;
    kitchenTemplates.forEach((template) => {
      const existing = week.operationalPositions.find((position) => position.date === date && position.templateId === template.id);
      if (existing) {
        existing.label = template.label;
        existing.slot = template.slot;
        existing.optional = true;
      } else {
        week.operationalPositions.push({
          id: `${week.id}:${date}:${template.id}`,
          templateId: template.id,
          date,
          dayIndex,
          sector: template.sector,
          shift: template.shift,
          label: template.label,
          slot: template.slot,
          floor: template.floor,
          optional: true,
        });
      }
    });
  });
  return week;
}

export function createDraftPlanningWeek({ id, name, startDate, endDate }) {
  return {
    id,
    name,
    startDate,
    endDate,
    status: "draft",
    operationalPositions: createOperationalPositions(id, startDate),
    assignments: [],
    daysOff: [],
    coverages: [],
    exceptions: [],
  };
}
