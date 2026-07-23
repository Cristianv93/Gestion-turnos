/**
 * Mock Data - Base de datos simulada para Uzumaki
 * Estructura simple, limpia y sin lógica de negocio.
 * Todos los datos responden a las reglas definidas en Directivas.md
 */

// ============================================================================
// CATÁLOGOS
// ============================================================================

export const rolesOperativos = {
  cocinero: {
    id: "rol-cocinero",
    nombre: "Personal de cocina",
    sector: "Cocina",
  },
  peonCocina: {
    id: "rol-peon-cocina",
    nombre: "Ayudante de cocina",
    sector: "Cocina",
  },
  camarera: {
    id: "rol-camarera",
    nombre: "Personal de camarería",
    sector: "Pisos",
  },
  franquera: {
    id: "rol-franquera",
    nombre: "Personal franquero",
    sectores: ["Pisos", "Cocina"],
  },
  nutricionista: {
    id: "rol-nutricionista",
    nombre: "Nutricionista",
  },
};

export const rolesSistema = {
  admin: {
    id: "sys-admin",
    nombre: "Administración",
  },
  encargada: {
    id: "sys-encargada",
    nombre: "Encargada",
  },
  supervisora: {
    id: "sys-supervisora",
    nombre: "Supervisión",
  },
  personal: {
    id: "sys-personal",
    nombre: "Personal",
  },
};

export const sectores = {
  cocina: {
    id: "sec-cocina",
    nombre: "Cocina",
  },
  pisos: {
    id: "sec-pisos",
    nombre: "Pisos",
  },
};

export const turnos = {
  manana: {
    id: "turno-manana",
    nombre: "Mañana",
    horaInicio: "06:00",
    horaFin: "14:00",
  },
  tarde: {
    id: "turno-tarde",
    nombre: "Tarde",
    horaInicio: "14:00",
    horaFin: "21:30",
  },
};

export const pisos = {
  piso1: {
    id: "piso-1",
    numero: 1,
  },
  piso2: {
    id: "piso-2",
    numero: 2,
  },
  piso3: {
    id: "piso-3",
    numero: 3,
  },
};

// ============================================================================
// MÓDULOS DEL MVP
// ============================================================================

// Dotación oficial: 13 empleados operativos y 3 perfiles administrativos.
// Cocina: 2 cocineros y 1 peón de mañana; 1 cocinero y 1 peón de tarde.
// Pisos: 6 camareras fijas y 2 franqueras.
// La cobertura de Julio por Gustavo es una excepción documentada, no automática.

export const employees = [
  {
    id: "emp-cocinero-manana-1",
    name: "Gustavo",
    initials: "GU",
    role: "Personal de cocina",
    roleId: "rol-cocinero",
    sector: "Cocina",
    sectorId: "sec-cocina",
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-06", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: "kitchen-cook-morning-2",
    francos: [],
  },
  {
    id: "emp-cocinero-manana-2",
    name: "Mario",
    initials: "MA",
    role: "Personal de cocina",
    roleId: "rol-cocinero",
    sector: "Cocina",
    sectorId: "sec-cocina",
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-02", anchorType: "F2", cycleLengthDays: 15 },
    habitualPositionTemplateId: "kitchen-cook-morning-1",
    francos: [],
  },
  {
    id: "emp-peon-veronica",
    name: "Verónica",
    initials: "VE",
    role: "Ayudante de cocina",
    roleId: "rol-peon-cocina",
    sector: "Cocina",
    sectorId: "sec-cocina",
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-05-31", anchorType: "F2", cycleLengthDays: 15 },
    habitualPositionTemplateId: "kitchen-assistant-morning",
    francos: [],
  },
  {
    id: "emp-cocinero-julio",
    name: "Julio",
    initials: "JU",
    role: "Personal de cocina",
    roleId: "rol-cocinero",
    sector: "Cocina",
    sectorId: "sec-cocina",
    turno: "Tarde",
    turnoId: "turno-tarde",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-04", anchorType: "F2", cycleLengthDays: 15 },
    habitualPositionTemplateId: "kitchen-cook-afternoon",
    francos: [],
  },
  {
    id: "emp-peon-tarde-1",
    name: "Víctor",
    initials: "VI",
    role: "Ayudante de cocina",
    roleId: "rol-peon-cocina",
    sector: "Cocina",
    sectorId: "sec-cocina",
    turno: "Tarde",
    turnoId: "turno-tarde",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-03", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: "kitchen-assistant-afternoon",
    francos: [],
  },
  {
    id: "emp-camarera-yesica",
    name: "Yesica",
    initials: "YE",
    role: "Personal de camarería",
    roleId: "rol-camarera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: "Tarde",
    turnoId: "turno-tarde",
    piso: 3,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-02", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: "floor-3-afternoon",
    francos: [],
  },
  {
    id: "emp-camarera-loly",
    name: "Loly",
    initials: "LO",
    role: "Personal de camarería",
    roleId: "rol-camarera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: 2,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-05-31", anchorType: "F2", cycleLengthDays: 15 },
    habitualPositionTemplateId: "floor-2-morning",
    francos: [],
  },
  {
    id: "emp-camarera-estela",
    name: "Estela",
    initials: "ES",
    role: "Personal de camarería",
    roleId: "rol-camarera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: 1,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-07", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: "floor-1-morning",
    francos: [],
  },
  {
    id: "emp-camarera-romina",
    name: "Romina",
    initials: "RO",
    role: "Personal de camarería",
    roleId: "rol-camarera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: "Tarde",
    turnoId: "turno-tarde",
    piso: 2,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-05", anchorType: "F2", cycleLengthDays: 15 },
    habitualPositionTemplateId: "floor-2-afternoon",
    francos: [],
  },
  {
    id: "emp-camarera-cintia",
    name: "Cintia",
    initials: "CI",
    role: "Personal de camarería",
    roleId: "rol-camarera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: 3,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-03", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: "floor-3-morning",
    francos: [],
  },
  {
    id: "emp-camarera-milagros",
    name: "Milagros",
    initials: "MI",
    role: "Personal de camarería",
    roleId: "rol-camarera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: "Tarde",
    turnoId: "turno-tarde",
    piso: 1,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-06", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: "floor-1-afternoon",
    francos: [],
  },
  {
    id: "emp-franquera-debora",
    name: "Débora",
    initials: "DE",
    role: "Personal franquero",
    roleId: "rol-franquera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: null,
    turnoId: null,
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-04", anchorType: "F2", cycleLengthDays: 15 },
    habitualPositionTemplateId: null,
    francos: [],
  },
  {
    id: "emp-franquera-lucila",
    name: "Lucila",
    initials: "LU",
    role: "Personal franquero",
    roleId: "rol-franquera",
    sector: "Pisos",
    sectorId: "sec-pisos",
    turno: null,
    turnoId: null,
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Personal",
    participaEnOperacion: true,
    francoCycle: { anchorDate: "2026-06-04", anchorType: "F1", cycleLengthDays: 15 },
    habitualPositionTemplateId: null,
    francos: [],
  },
  {
    id: "emp-encargada-manana",
    name: "Encargada Nutricionista Mañana",
    initials: "ENM",
    role: "Encargada/Nutrición",
    roleId: "rol-nutricionista",
    sector: null,
    sectorId: null,
    turno: "Mañana",
    turnoId: "turno-manana",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Encargada",
    participaEnOperacion: false,
    francos: [],
    jornadaAdministrativa: {
      diasHabituales: ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"],
      horaInicio: "07:00",
      horaFin: "14:00",
      guardiaSabado: {
        participa: true,
        modalidad: "Alternada semana por medio",
        horaInicio: "08:00",
        horaFin: "13:00",
      },
    },
  },
  {
    id: "emp-encargada-tarde",
    name: "Encargada Nutricionista Tarde",
    initials: "ENT",
    role: "Encargada/Nutrición",
    roleId: "rol-nutricionista",
    sector: null,
    sectorId: null,
    turno: "Tarde",
    turnoId: "turno-tarde",
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Encargada",
    participaEnOperacion: false,
    francos: [],
    jornadaAdministrativa: {
      diasHabituales: ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"],
      horaInicio: "14:00",
      horaFin: "21:00",
      guardiaSabado: {
        participa: true,
        modalidad: "Alternada semana por medio",
        horaInicio: "08:00",
        horaFin: "13:00",
      },
    },
  },
  {
    id: "emp-supervisora-general",
    name: "Supervisión General",
    initials: "SG",
    role: "Supervisión",
    roleId: null,
    sector: null,
    sectorId: null,
    turno: null,
    turnoId: null,
    piso: null,
    phone: "",
    status: "active",
    systemRole: "Supervisión",
    participaEnOperacion: false,
    francos: [],
  },
];

export const rotacionPisosProgramada = {
  periodo: "Septiembre",
  estado: "Planificada",
  asignaciones: [
    { employeeId: "emp-camarera-cintia", name: "Cintia", turno: "Mañana", piso: 1 },
    { employeeId: "emp-camarera-estela", name: "Estela", turno: "Mañana", piso: 2 },
    { employeeId: "emp-camarera-loly", name: "Loly", turno: "Mañana", piso: 3 },
    { employeeId: "emp-camarera-yesica", name: "Yesica", turno: "Tarde", piso: 1 },
    { employeeId: "emp-camarera-milagros", name: "Milagros", turno: "Tarde", piso: 2 },
    { employeeId: "emp-camarera-romina", name: "Romina", turno: "Tarde", piso: 3 },
  ],
};

// Semana real cargada exclusivamente como referencia visual y funcional.
// No fue calculada, no define recurrencias y no debe alimentar futuras grillas.
export const referenceSchedule = {
  id: "grilla-referencia-2026-06-29",
  type: "reference",
  calculated: false,
  startDate: "2026-06-29",
  endDate: "2026-07-05",
  label: "29 de junio al 5 de julio de 2026",
  days: [
    {
      id: "2026-06-29",
      label: "Lunes",
      shortLabel: "Lun",
      displayDate: "29/06",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
          { employeeId: "emp-peon-veronica", name: "Verónica" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-franquera-lucila", name: "Lucila", kind: "coverage", note: "Cobertura" },
          2: { employeeId: "emp-camarera-loly", name: "Loly" },
          3: { employeeId: "emp-camarera-cintia", name: "Cintia" },
        },
        tarde: {
          1: { employeeId: "emp-franquera-debora", name: "Débora", kind: "coverage", note: "Cobertura" },
          2: { employeeId: "emp-camarera-romina", name: "Romina" },
          3: { employeeId: "emp-camarera-yesica", name: "Yesica" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo" },
        ],
        pisos: [
          { employeeId: "emp-camarera-estela", name: "Estela" },
          { employeeId: "emp-camarera-milagros", name: "Milagros" },
        ],
      },
    },
    {
      id: "2026-06-30",
      label: "Martes",
      shortLabel: "Mar",
      displayDate: "30/06",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-franquera-debora", name: "Débora", kind: "coverage", note: "Cobertura" },
          2: { employeeId: "emp-franquera-lucila", name: "Lucila", kind: "coverage", note: "Cobertura" },
          3: { employeeId: "emp-camarera-cintia", name: "Cintia" },
        },
        tarde: {
          1: { employeeId: "emp-camarera-milagros", name: "Milagros" },
          2: { employeeId: "emp-camarera-romina", name: "Romina" },
          3: { employeeId: "emp-camarera-yesica", name: "Yesica" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-peon-veronica", name: "Verónica" },
        ],
        pisos: [
          { employeeId: "emp-camarera-loly", name: "Loly" },
          { employeeId: "emp-camarera-estela", name: "Estela" },
        ],
      },
    },
    {
      id: "2026-07-01",
      label: "Miércoles",
      shortLabel: "Mié",
      displayDate: "01/07",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo" },
          { employeeId: "emp-franquera-debora", name: "Débora", kind: "collaboration", note: "Cobertura en Cocina" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-camarera-estela", name: "Estela" },
          2: { employeeId: "emp-franquera-lucila", name: "Lucila", kind: "coverage", note: "Cobertura" },
          3: { employeeId: "emp-camarera-cintia", name: "Cintia" },
        },
        tarde: {
          1: { employeeId: "emp-camarera-milagros", name: "Milagros" },
          2: { employeeId: "emp-camarera-romina", name: "Romina" },
          3: { employeeId: "emp-camarera-yesica", name: "Yesica" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-peon-veronica", name: "Verónica" },
        ],
        pisos: [
          { employeeId: "emp-camarera-loly", name: "Loly" },
        ],
      },
    },
    {
      id: "2026-07-02",
      label: "Jueves",
      shortLabel: "Jue",
      displayDate: "02/07",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo" },
          { employeeId: "emp-peon-veronica", name: "Verónica" },
          { employeeId: "emp-franquera-lucila", name: "Lucila", kind: "collaboration", note: "Cobertura en Cocina" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-camarera-estela", name: "Estela" },
          2: { employeeId: "emp-camarera-loly", name: "Loly" },
          3: { employeeId: "emp-camarera-cintia", name: "Cintia" },
        },
        tarde: {
          1: { employeeId: "emp-camarera-milagros", name: "Milagros" },
          2: { employeeId: "emp-camarera-romina", name: "Romina" },
          3: { employeeId: "emp-franquera-debora", name: "Débora", kind: "coverage", note: "Cobertura" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
        ],
        pisos: [
          { employeeId: "emp-camarera-yesica", name: "Yesica" },
        ],
      },
    },
    {
      id: "2026-07-03",
      label: "Viernes",
      shortLabel: "Vie",
      displayDate: "03/07",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo" },
          { employeeId: "emp-peon-veronica", name: "Verónica" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
          { employeeId: "emp-franquera-debora", name: "Débora", kind: "coverage", note: "Cubriendo" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-camarera-estela", name: "Estela" },
          2: { employeeId: "emp-camarera-loly", name: "Loly" },
          3: { employeeId: "emp-franquera-lucila", name: "Lucila", kind: "coverage", note: "Cobertura" },
        },
        tarde: {
          1: { employeeId: "emp-camarera-milagros", name: "Milagros" },
          2: { employeeId: "emp-camarera-romina", name: "Romina" },
          3: { employeeId: "emp-camarera-yesica", name: "Yesica" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
        pisos: [
          { employeeId: "emp-camarera-cintia", name: "Cintia" },
        ],
      },
    },
    {
      id: "2026-07-04",
      label: "Sábado",
      shortLabel: "Sáb",
      displayDate: "04/07",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
          { employeeId: "emp-peon-veronica", name: "Verónica" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo", kind: "exception", note: "Cubre franco de Julio" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-camarera-estela", name: "Estela" },
          2: { employeeId: "emp-camarera-loly", name: "Loly" },
          3: { employeeId: "emp-camarera-cintia", name: "Cintia" },
        },
        tarde: {
          1: { employeeId: "emp-camarera-milagros", name: "Milagros" },
          2: { employeeId: "emp-camarera-romina", name: "Romina" },
          3: { employeeId: "emp-camarera-yesica", name: "Yesica" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
        ],
        pisos: [
          { employeeId: "emp-franquera-debora", name: "Débora" },
          { employeeId: "emp-franquera-lucila", name: "Lucila" },
        ],
      },
    },
    {
      id: "2026-07-05",
      label: "Domingo",
      shortLabel: "Dom",
      displayDate: "05/07",
      cocina: {
        manana: [
          { employeeId: "emp-cocinero-manana-2", name: "Mario" },
          { employeeId: "emp-peon-veronica", name: "Verónica" },
        ],
        tarde: [
          { employeeId: "emp-cocinero-manana-1", name: "Gustavo", kind: "exception", note: "Cubre franco de Julio" },
          { employeeId: "emp-peon-tarde-1", name: "Víctor" },
        ],
      },
      pisos: {
        manana: {
          1: { employeeId: "emp-camarera-estela", name: "Estela" },
          2: { employeeId: "emp-camarera-loly", name: "Loly" },
          3: { employeeId: "emp-camarera-cintia", name: "Cintia" },
        },
        tarde: {
          1: { employeeId: "emp-camarera-milagros", name: "Milagros" },
          2: { employeeId: "emp-franquera-lucila", name: "Lucila", kind: "coverage", note: "Cobertura" },
          3: { employeeId: "emp-camarera-yesica", name: "Yesica" },
        },
      },
      francos: {
        cocina: [
          { employeeId: "emp-cocinero-julio", name: "Julio" },
        ],
        pisos: [
          { employeeId: "emp-franquera-debora", name: "Débora" },
          { employeeId: "emp-camarera-romina", name: "Romina" },
        ],
      },
    },
  ],
};

export const weeklySchedules = [];
export const requests = [];
export const notifications = [];
export const auditLogs = [];
export const incidents = [];

export const initialSchedule = weeklySchedules;
export const initialRequests = requests;
export const initialNotifications = notifications;
export const initialAudit = auditLogs;

// ============================================================================
// IDENTIDADES SEMILLA PARA VINCULAR EMPLEADOS
// ============================================================================

export const demoUsers = [
  {
    id: "user-maqui",
    username: "maqui",
    name: "Maqui Uzumaki",
    role: "manager",
    employeeId: "emp-encargada-tarde",
  },
  {
    id: "user-encargada-manana",
    username: "encargada-manana",
    name: "Encargada Nutricionista Mañana",
    role: "manager",
    employeeId: "emp-encargada-manana",
  },
  {
    id: "user-supervisora",
    username: "supervisora",
    name: "Supervisión",
    role: "supervisor",
    employeeId: "emp-supervisora-general",
  },
  {
    id: "user-debora",
    username: "debora",
    name: "Débora",
    role: "staff",
    employeeId: "emp-franquera-debora",
  },
  {
    id: "user-lucila",
    username: "lucila",
    name: "Lucila",
    role: "staff",
    employeeId: "emp-franquera-lucila",
  },
];

// Alias para compatibilidad
export const DAYS = ["Lun 29", "Mar 30", "Mié 1", "Jue 2", "Vie 3", "Sáb 4", "Dom 5"];
