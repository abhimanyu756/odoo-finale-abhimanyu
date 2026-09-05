import { prisma } from '../../lib/prisma.js';
import { startOfDay, endOfDay } from '../../lib/dates.js';

const n = (v) => Number(v ?? 0);
const round = (v) => Number(n(v).toFixed(2));
const titleCase = (s) =>
  String(s).toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// The axes a metric can be sliced along. `key` is what the client sends back to
// narrow the next level down, so it is an id wherever one exists.
export const DIMENSIONS = {
  department: {
    label: 'Department',
    key: (e) => e.departmentId ?? 'none',
    name: (e) => e.department?.name ?? 'Unassigned',
    filter: 'departmentId',
  },
  jobPosition: {
    label: 'Job Position',
    key: (e) => e.jobPositionId ?? 'none',
    name: (e) => e.jobPosition?.name ?? 'Unassigned',
    filter: 'jobPositionId',
  },
  employeeType: {
    label: 'Employee Type',
    key: (e) => e.employeeType,
    name: (e) => titleCase(e.employeeType),
    filter: 'employeeType',
  },
  workLocation: {
    label: 'Work Location',
    key: (e) => e.workLocation || 'none',
    name: (e) => e.workLocation || 'Unspecified',
    filter: 'workLocation',
  },
  employee: {
    label: 'Employee',
    key: (e) => e.id,
    name: (e) => `${e.firstName} ${e.lastName}`,
    filter: 'employeeId',
  },
};

// Resolves the employee population a drill-down question is asked about. Every
// narrowing filter the client can click on is applied here, so each level down
// is just the same query with one more constraint.
export async function scopeEmployees(f) {
  return prisma.employee.findMany({
    where: {
      status: 'ACTIVE',
      ...(f.companyId ? { companyId: f.companyId } : {}),
      ...(f.departmentId ? { departmentId: f.departmentId } : {}),
      ...(f.jobPositionId ? { jobPositionId: f.jobPositionId } : {}),
      ...(f.employeeType ? { employeeType: f.employeeType } : {}),
      ...(f.workLocation ? { workLocation: f.workLocation } : {}),
      ...(f.employeeId ? { id: f.employeeId } : {}),
    },
    select: {
      id: true, firstName: true, lastName: true, employeeType: true, workLocation: true,
      departmentId: true, department: { select: { name: true } },
      jobPositionId: true, jobPosition: { select: { name: true } },
    },
  });
}

const emptyRow = (key, label) => ({
  key, label,
  net: 0, gross: 0, deduction: 0, payslips: 0, headcount: 0,
  attendance: 0, present: 0, late: 0, absent: 0, overtimeHours: 0,
  leaveDays: 0, leaveRequests: 0,
});

// One pass over payslips, attendance and leave, folded onto whichever axis the
// caller asked for. Returning every metric per row costs nothing extra here and
// lets one request drive a whole drill-down panel.
export async function drilldown(f) {
  const dim = DIMENSIONS[f.dimension] ?? DIMENSIONS.department;
  const employees = await scopeEmployees(f);
  const ids = employees.map((e) => e.id);

  const rows = new Map();
  const rowFor = (key, label) => {
    if (!rows.has(key)) rows.set(key, emptyRow(key, label));
    return rows.get(key);
  };
  const bucketOf = new Map();
  for (const e of employees) {
    const key = dim.key(e);
    bucketOf.set(e.id, key);
    rowFor(key, dim.name(e)).headcount += 1;
  }

  if (!ids.length) {
    return { dimension: f.dimension, dimensionLabel: dim.label, filterKey: dim.filter, rows: [] };
  }

  const gte = startOfDay(f.periodStart);
  const lte = endOfDay(f.periodEnd);

  const [payslips, attendance, leaves] = await Promise.all([
    prisma.payslip.findMany({
      where: {
        employeeId: { in: ids },
        periodStart: { gte }, periodEnd: { lte },
        status: { not: 'CANCELLED' },
      },
      select: { employeeId: true, net: true, gross: true, deduction: true },
    }),
    prisma.attendance.findMany({
      where: {
        employeeId: { in: ids },
        checkIn: { gte, lte },
        ...(f.attendanceStatus ? { status: f.attendanceStatus } : {}),
      },
      select: { employeeId: true, status: true, overtimeHours: true },
    }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: ids },
        status: 'APPROVED',
        dateFrom: { lte }, dateTo: { gte },
        ...(f.timeOffTypeId ? { timeOffTypeId: f.timeOffTypeId } : {}),
      },
      select: {
        employeeId: true, duration: true,
        timeOffType: { select: { id: true, name: true, color: true } },
      },
    }),
  ]);

  // `leaveType` is the one axis that lives on the leave record rather than the
  // employee, so it is folded separately.
  const byLeaveType = new Map();

  for (const p of payslips) {
    const r = rowFor(bucketOf.get(p.employeeId));
    r.net += n(p.net);
    r.gross += n(p.gross);
    r.deduction += n(p.deduction);
    r.payslips += 1;
  }
  for (const a of attendance) {
    const r = rowFor(bucketOf.get(a.employeeId));
    r.attendance += 1;
    r.overtimeHours += n(a.overtimeHours);
    if (a.status === 'PRESENT') r.present += 1;
    else if (a.status === 'LATE') r.late += 1;
    else r.absent += 1;
  }
  for (const l of leaves) {
    const r = rowFor(bucketOf.get(l.employeeId));
    r.leaveDays += n(l.duration);
    r.leaveRequests += 1;

    const t = l.timeOffType;
    if (!byLeaveType.has(t.id)) {
      byLeaveType.set(t.id, { ...emptyRow(t.id, t.name), color: t.color });
    }
    const lt = byLeaveType.get(t.id);
    lt.leaveDays += n(l.duration);
    lt.leaveRequests += 1;
  }

  const source = f.dimension === 'leaveType' ? byLeaveType : rows;
  const out = [...source.values()].map((r) => ({
    ...r,
    net: round(r.net), gross: round(r.gross), deduction: round(r.deduction),
    leaveDays: round(r.leaveDays), overtimeHours: round(r.overtimeHours),
    avgNet: round(r.headcount ? r.net / r.headcount : 0),
    // Share of scheduled days actually worked on time.
    health: r.attendance ? round((r.present / r.attendance) * 100) : null,
  }));

  const metricKey = { salary: 'net', attendance: 'attendance', leave: 'leaveDays' }[f.metric] ?? 'net';
  out.sort((a, b) => b[metricKey] - a[metricKey] || a.label.localeCompare(b.label));

  return {
    dimension: f.dimension,
    dimensionLabel: f.dimension === 'leaveType' ? 'Time Off Type' : dim.label,
    filterKey: f.dimension === 'leaveType' ? 'timeOffTypeId' : dim.filter,
    metric: f.metric,
    rows: f.limit ? out.slice(0, f.limit) : out,
    truncated: Boolean(f.limit && out.length > f.limit),
    totalGroups: out.length,
  };
}
