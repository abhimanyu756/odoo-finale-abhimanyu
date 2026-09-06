import { prisma } from '../../lib/prisma.js';
import { isHr, isPayroll } from '../../middleware/auth.js';
import { drilldown } from '../dashboard/drilldown.js';
import { periodWindow } from '../../lib/dates.js';

/*
 * The tools the assistant may call.
 *
 * The model never sees the database and never writes a query - it chooses a
 * tool and its parameters, and the tool runs the same code the UI runs, scoped
 * to the requesting user. Authorization therefore needs no new rules: an
 * EMPLOYEE asking about "everyone's salary" gets their own record, because the
 * same `scope` that guards the REST endpoints guards this.
 *
 * Every tool is read-only. There is deliberately no way to approve, pay, edit
 * or delete anything from chat.
 */

// Fields that must never leave the server, whatever is asked.
const NEVER_EXPOSE = ['bankAccount', 'identificationNo', 'address', 'personalEmail', 'passwordHash'];

const strip = (row) => {
  const out = { ...row };
  for (const k of NEVER_EXPOSE) delete out[k];
  return out;
};

// Names, not ids: the model would otherwise have to invent uuids. Resolution is
// case-insensitive and returns null when nothing matches, so an unknown
// department produces "no match" rather than a silent unfiltered query.
async function resolve(model, name) {
  if (!name) return undefined;
  const row = await prisma[model].findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  return row?.id ?? '__no_match__';
}

// A period the model can express as a year and month, defaulting to the
// trailing 12 months so "this year" and "overall" both work.
const resolvePeriod = ({ year, month }) => {
  const w = periodWindow(year, month);
  if (w) return { periodStart: w.gte, periodEnd: new Date(w.lt.getTime() - 1) };
  const now = new Date();
  return {
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)),
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)),
  };
};

// Employees may only ever see themselves; HR and payroll roles see everyone.
const employeeScope = (user) => (isHr(user.role) ? {} : { userId: user.id });

export const TOOLS = {
  /* ---------------------------------------------------------------- people */
  find_employees: {
    declaration: {
      name: 'find_employees',
      description:
        'Find employees by department, job position, employment type, status, manager or '
        + 'HR responsible. Use for questions like "who works in Sales", "list the interns", '
        + '"who reports to Sara Khan".',
      parameters: {
        type: 'object',
        properties: {
          department: { type: 'string', description: 'Department name, e.g. Finance' },
          jobPosition: { type: 'string', description: 'Job position name, e.g. Data Analyst' },
          employeeType: { type: 'string', enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
          managerName: { type: 'string', description: 'Full name of the line manager' },
          search: { type: 'string', description: 'Free text on name or work email' },
          limit: { type: 'number', description: 'Max rows, default 25' },
        },
      },
    },
    async run(args, user) {
      const [departmentId, jobPositionId] = await Promise.all([
        resolve('department', args.department),
        resolve('jobPosition', args.jobPosition),
      ]);

      let managerId;
      if (args.managerName) {
        const [first, ...rest] = args.managerName.trim().split(/\s+/);
        const m = await prisma.employee.findFirst({
          where: {
            firstName: { equals: first, mode: 'insensitive' },
            ...(rest.length ? { lastName: { equals: rest.join(' '), mode: 'insensitive' } } : {}),
          },
          select: { id: true },
        });
        managerId = m?.id ?? '__no_match__';
      }

      const rows = await prisma.employee.findMany({
        where: {
          ...employeeScope(user),
          ...(departmentId ? { departmentId } : {}),
          ...(jobPositionId ? { jobPositionId } : {}),
          ...(managerId ? { managerId } : {}),
          ...(args.employeeType ? { employeeType: args.employeeType } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.search
            ? {
                OR: [
                  { firstName: { contains: args.search, mode: 'insensitive' } },
                  { lastName: { contains: args.search, mode: 'insensitive' } },
                  { workEmail: { contains: args.search, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        take: Math.min(args.limit ?? 25, 100),
        orderBy: { firstName: 'asc' },
        select: {
          id: true, firstName: true, lastName: true, workEmail: true,
          employeeType: true, status: true, workLocation: true,
          department: { select: { name: true } },
          jobPosition: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true } },
        },
      });

      return {
        columns: ['Employee', 'Work Email', 'Department', 'Job Position', 'Type', 'Status'],
        rows: rows.map((e) => ({
          id: e.id,
          Employee: `${e.firstName} ${e.lastName}`,
          'Work Email': e.workEmail,
          Department: e.department?.name ?? '—',
          'Job Position': e.jobPosition?.name ?? '—',
          Type: e.employeeType,
          Status: e.status,
        })),
      };
    },
  },

  /* ------------------------------------------------------------- analytics */
  analytics: {
    declaration: {
      name: 'analytics',
      description:
        'Aggregate salary, attendance or time off, grouped by any axis. This answers most '
        + '"how much / how many / who is worst" questions, e.g. "attendance below 80% in '
        + 'Finance this month", "which department took the most leave", "salary cost by job '
        + 'position". Set dimension to "employee" to name individual people.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['salary', 'attendance', 'leave'] },
          dimension: {
            type: 'string',
            enum: ['department', 'jobPosition', 'employeeType', 'workLocation', 'leaveType', 'employee'],
          },
          department: { type: 'string' },
          jobPosition: { type: 'string' },
          employeeType: { type: 'string', enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] },
          year: { type: 'number' },
          month: { type: 'number', description: '1-12; omit for the whole year' },
          maxAttendanceHealth: {
            type: 'number',
            description: 'Keep only rows whose on-time attendance percentage is below this',
          },
          minAttendanceHealth: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['metric', 'dimension'],
      },
    },
    async run(args, user) {
      // A plain employee cannot aggregate over other people.
      if (!isPayroll(user.role) && !isHr(user.role)) {
        const me = await prisma.employee.findFirst({
          where: { userId: user.id }, select: { id: true },
        });
        if (!me) return { columns: [], rows: [], note: 'You have no employee record.' };
        args = { ...args, dimension: 'employee', employeeId: me.id };
      }

      const [departmentId, jobPositionId] = await Promise.all([
        resolve('department', args.department),
        resolve('jobPosition', args.jobPosition),
      ]);

      const result = await drilldown({
        metric: args.metric,
        dimension: args.dimension,
        departmentId: departmentId === '__no_match__' ? undefined : departmentId,
        jobPositionId: jobPositionId === '__no_match__' ? undefined : jobPositionId,
        employeeType: args.employeeType,
        employeeId: args.employeeId,
        limit: Math.min(args.limit ?? 25, 100),
        ...resolvePeriod(args),
      });

      let rows = result.rows;
      if (args.maxAttendanceHealth != null) {
        rows = rows.filter((r) => r.health != null && r.health < args.maxAttendanceHealth);
      }
      if (args.minAttendanceHealth != null) {
        rows = rows.filter((r) => r.health != null && r.health > args.minAttendanceHealth);
      }

      const shape = {
        salary: {
          columns: [result.dimensionLabel, 'Net Salary', 'Employees', 'Avg / Employee'],
          map: (r) => ({
            [result.dimensionLabel]: r.label,
            'Net Salary': r.net,
            Employees: r.headcount,
            'Avg / Employee': r.avgNet,
          }),
        },
        attendance: {
          columns: [result.dimensionLabel, 'Records', 'On time', 'Late', 'Attendance %'],
          map: (r) => ({
            [result.dimensionLabel]: r.label,
            Records: r.attendance,
            'On time': r.present,
            Late: r.late,
            'Attendance %': r.health,
          }),
        },
        leave: {
          columns: [result.dimensionLabel, 'Leave Days', 'Requests', 'Employees'],
          map: (r) => ({
            [result.dimensionLabel]: r.label,
            'Leave Days': r.leaveDays,
            Requests: r.leaveRequests,
            Employees: r.headcount,
          }),
        },
      }[args.metric];

      return { columns: shape.columns, rows: rows.map(shape.map), dimensionLabel: result.dimensionLabel };
    },
  },

  /* -------------------------------------------------------------- payslips */
  find_payslips: {
    declaration: {
      name: 'find_payslips',
      description:
        'Look up individual payslips for an employee, a period or a status. Use for '
        + '"show me a person\'s payslips", "which payslips are still draft".',
      parameters: {
        type: 'object',
        properties: {
          employeeName: { type: 'string' },
          year: { type: 'number' },
          month: { type: 'number' },
          status: { type: 'string', enum: ['DRAFT', 'COMPUTED', 'VALIDATED', 'PAID', 'CANCELLED'] },
          limit: { type: 'number' },
        },
      },
    },
    async run(args, user) {
      const window = periodWindow(args.year, args.month);
      let employeeFilter;
      if (args.employeeName) {
        const [first, ...rest] = args.employeeName.trim().split(/\s+/);
        employeeFilter = {
          firstName: { contains: first, mode: 'insensitive' },
          ...(rest.length ? { lastName: { contains: rest.join(' '), mode: 'insensitive' } } : {}),
        };
      }

      const rows = await prisma.payslip.findMany({
        where: {
          ...(isPayroll(user.role) ? {} : { employee: { userId: user.id } }),
          ...(employeeFilter ? { employee: employeeFilter } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(window ? { periodStart: window } : {}),
        },
        take: Math.min(args.limit ?? 25, 100),
        orderBy: { periodStart: 'desc' },
        include: {
          employee: { select: { firstName: true, lastName: true } },
          payrun: { select: { name: true } },
        },
      });

      return {
        columns: ['Payslip', 'Employee', 'Payrun', 'Gross', 'Net', 'Status'],
        rows: rows.map((s) => ({
          id: s.id,
          Payslip: s.number,
          Employee: `${s.employee.firstName} ${s.employee.lastName}`,
          Payrun: s.payrun?.name,
          Gross: Number(s.gross),
          Net: Number(s.net),
          Status: s.status,
        })),
      };
    },
  },

  /* ------------------------------------------------------------- time off  */
  find_leave_requests: {
    declaration: {
      name: 'find_leave_requests',
      description:
        'List time off requests by status, type, employee or period. Use for "what is '
        + 'pending approval", "who is on leave in September".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['DRAFT', 'TO_APPROVE', 'APPROVED', 'REFUSED', 'CANCELLED'] },
          leaveType: { type: 'string', description: 'Time off type name, e.g. Sick Leave' },
          employeeName: { type: 'string' },
          department: { type: 'string' },
          year: { type: 'number' },
          month: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
    async run(args, user) {
      const window = periodWindow(args.year, args.month);
      const [typeId, departmentId] = await Promise.all([
        resolve('timeOffType', args.leaveType),
        resolve('department', args.department),
      ]);
      let employeeFilter;
      if (args.employeeName) {
        const [first, ...rest] = args.employeeName.trim().split(/\s+/);
        employeeFilter = {
          firstName: { contains: first, mode: 'insensitive' },
          ...(rest.length ? { lastName: { contains: rest.join(' '), mode: 'insensitive' } } : {}),
        };
      }

      const rows = await prisma.leaveRequest.findMany({
        where: {
          ...(isHr(user.role) ? {} : { employee: { userId: user.id } }),
          ...(args.status ? { status: args.status } : {}),
          ...(typeId && typeId !== '__no_match__' ? { timeOffTypeId: typeId } : {}),
          ...(window ? { dateFrom: window } : {}),
          ...(employeeFilter || (departmentId && departmentId !== '__no_match__')
            ? { employee: { ...(employeeFilter ?? {}), ...(departmentId && departmentId !== '__no_match__' ? { departmentId } : {}) } }
            : {}),
        },
        take: Math.min(args.limit ?? 25, 100),
        orderBy: { dateFrom: 'desc' },
        include: {
          employee: { select: { firstName: true, lastName: true, department: { select: { name: true } } } },
          timeOffType: { select: { name: true } },
        },
      });

      return {
        columns: ['Employee', 'Department', 'Type', 'From', 'To', 'Days', 'Status'],
        rows: rows.map((r) => ({
          id: r.id,
          Employee: `${r.employee.firstName} ${r.employee.lastName}`,
          Department: r.employee.department?.name ?? '—',
          Type: r.timeOffType.name,
          From: r.dateFrom.toISOString().slice(0, 10),
          To: r.dateTo.toISOString().slice(0, 10),
          Days: Number(r.duration),
          Status: r.status,
        })),
      };
    },
  },

  /* ------------------------------------------------------------ reference  */
  list_reference: {
    declaration: {
      name: 'list_reference',
      description:
        'List the available departments, job positions, salary structures or time off types. '
        + 'Call this first when unsure whether a name the user mentioned exists.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['departments', 'jobPositions', 'salaryStructures', 'timeOffTypes'],
          },
        },
        required: ['kind'],
      },
    },
    async run(args) {
      const source = {
        departments: () => prisma.department.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
        jobPositions: () => prisma.jobPosition.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
        salaryStructures: () => prisma.salaryStructure.findMany({ orderBy: { name: 'asc' }, select: { name: true, code: true } }),
        timeOffTypes: () => prisma.timeOffType.findMany({ orderBy: { name: 'asc' }, select: { name: true, code: true } }),
      }[args.kind];

      const rows = await source();
      return { columns: ['Name'], rows: rows.map((r) => ({ Name: r.name + (r.code ? ` (${r.code})` : '') })) };
    },
  },
};

export const declarations = Object.values(TOOLS).map((t) => t.declaration);

// What the model is allowed to see of a result: shape and a sample, never the
// full table. The complete rows are rendered by the client from this same
// response, so the answer text can never disagree with the table beside it.
export function summariseForModel(result) {
  // Totals are computed here, over every row, and handed to the model as facts.
  // Without them a "how much in total" question could only be answered by the
  // model adding up the 8-row sample - which would be quietly wrong.
  const totals = {};
  for (const col of result.columns) {
    const nums = result.rows
      .map((r) => r[col])
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    // A percentage or a rate must not be summed; only additive counts are.
    if (nums.length !== result.rows.length || /%|avg|average|rate/i.test(col)) continue;
    totals[col] = Number(nums.reduce((a, b) => a + b, 0).toFixed(2));
  }

  return {
    rowCount: result.rows.length,
    columns: result.columns,
    // Every row is represented in `totals`; `sample` is only for naming examples.
    totals,
    sample: result.rows.slice(0, 8).map(strip),
    sampleIsPartial: result.rows.length > 8,
    note: result.note,
  };
}
