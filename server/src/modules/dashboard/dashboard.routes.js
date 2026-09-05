import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';
import { startOfDay, endOfDay } from '../../lib/dates.js';
import { drilldown, DIMENSIONS } from './drilldown.js';

const router = Router();
router.use(authenticate, requireMinRole('HR_PAYROLL_USER'));

const n = (v) => Number(v ?? 0);
const round = (v) => Number(n(v).toFixed(2));

const EMPLOYEE_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];

// Every axis the drill-down can slice on is also a dashboard filter, so
// "apply to dashboard" from any drill level narrows the whole page.
const filterSchema = z.object({
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  companyId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  jobPositionId: z.string().uuid().optional(),
  workLocation: z.string().min(1).optional(),
  employeeType: z.enum(EMPLOYEE_TYPES).optional(),
});

// Drill-down carries the base filters plus whichever slice the user clicked, so
// each level down is the same question asked of a smaller population.
const drillSchema = filterSchema.extend({
  metric: z.enum(['salary', 'attendance', 'leave']).default('salary'),
  dimension: z
    .enum([...Object.keys(DIMENSIONS), 'leaveType'])
    .default('department'),
  employeeId: z.string().uuid().optional(),
  attendanceStatus: z.enum(['PRESENT', 'LATE', 'ABSENT', 'MISSING_CHECKOUT']).optional(),
  timeOffTypeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(15),
});

// Same default window as the main dashboard: the trailing 12 months through the
// end of the current month, so an in-progress period is still included.
const resolvePeriod = (f) => {
  const now = new Date();
  const periodEnd = f.periodEnd
    ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const periodStart = f.periodStart
    ?? new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 11, 1));
  return { periodStart, periodEnd };
};

// Every metric is aggregated from live HR and payroll records; nothing here is
// precomputed or hardcoded, so the dashboard always reflects current state.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = filterSchema.parse(req.query);

    const { periodStart, periodEnd } = resolvePeriod(f);

    // The comparison window for the KPI delta. Payroll periods are stored in UTC,
    // so these bounds come from the raw instants - passing them through the
    // local-time startOfDay/endOfDay shifts them by the offset and drops the
    // adjacent period entirely.
    //
    // A whole-month selection steps back a calendar month rather than a fixed
    // span, because months differ in length: a 30-day step back from June starts
    // on 2 May and would miss every payslip for May.
    const py = periodStart.getUTCFullYear();
    const pm = periodStart.getUTCMonth();
    const lastOfMonth = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
    const isWholeMonth =
      periodStart.getUTCDate() === 1
      && periodStart.getUTCHours() === 0
      && periodEnd.getUTCFullYear() === py
      && periodEnd.getUTCMonth() === pm
      && periodEnd.getUTCDate() === lastOfMonth;

    const previousEnd = isWholeMonth
      ? new Date(Date.UTC(py, pm, 0, 23, 59, 59, 999))
      : new Date(periodStart.getTime() - 1);
    const previousStart = isWholeMonth
      ? new Date(Date.UTC(py, pm - 1, 1))
      : new Date(previousEnd.getTime() - (periodEnd.getTime() - periodStart.getTime()));

    const employeeWhere = {
      status: 'ACTIVE',
      ...(f.companyId ? { companyId: f.companyId } : {}),
      ...(f.departmentId ? { departmentId: f.departmentId } : {}),
      ...(f.jobPositionId ? { jobPositionId: f.jobPositionId } : {}),
      ...(f.workLocation ? { workLocation: f.workLocation } : {}),
      ...(f.employeeType ? { employeeType: f.employeeType } : {}),
    };

    const scopedEmployees = await prisma.employee.findMany({
      where: employeeWhere,
      select: { id: true, departmentId: true, department: { select: { name: true } } },
    });
    const employeeIds = scopedEmployees.map((e) => e.id);

    const slipWhere = {
      employeeId: { in: employeeIds },
      periodStart: { gte: startOfDay(periodStart) },
      periodEnd: { lte: endOfDay(periodEnd) },
      status: { not: 'CANCELLED' },
    };

    const [payslips, attendance, leaves, pendingLeaves, contracts, payruns, warnings,
      previousNet, pendingLeaveRows, allocations, timeOffTypes] =
      await Promise.all([
        prisma.payslip.findMany({
          where: slipWhere,
          select: {
            id: true, net: true, gross: true, deduction: true, status: true,
            periodStart: true, employeeId: true,
            employee: { select: { departmentId: true, department: { select: { name: true } }, bankAccount: true } },
          },
        }),
        prisma.attendance.findMany({
          where: {
            employeeId: { in: employeeIds },
            checkIn: { gte: startOfDay(periodStart), lte: endOfDay(periodEnd) },
          },
          select: { status: true, workedHours: true, overtimeHours: true, isManual: true, checkOut: true },
        }),
        prisma.leaveRequest.findMany({
          where: {
            employeeId: { in: employeeIds },
            status: 'APPROVED',
            dateFrom: { lte: endOfDay(periodEnd) },
            dateTo: { gte: startOfDay(periodStart) },
          },
          select: { duration: true, timeOffType: { select: { id: true, name: true, color: true, code: true } } },
        }),
        prisma.leaveRequest.count({
          where: { employeeId: { in: employeeIds }, status: 'TO_APPROVE' },
        }),
        prisma.contract.findMany({
          where: { employeeId: { in: employeeIds } },
          select: { id: true, status: true, endDate: true, employeeId: true },
        }),
        prisma.payrun.findMany({
          where: { periodStart: { gte: startOfDay(periodStart) }, periodEnd: { lte: endOfDay(periodEnd) } },
          select: { id: true, name: true, status: true, periodStart: true },
          orderBy: { periodStart: 'desc' },
        }),
        prisma.payrollWarning.findMany({
          where: { resolved: false },
          select: { id: true, code: true, message: true, severity: true },
          take: 50,
        }),
        // Same-length window immediately before this one, for the KPI delta.
        prisma.payslip.aggregate({
          where: {
            employeeId: { in: employeeIds },
            periodStart: { gte: previousStart },
            periodEnd: { lte: previousEnd },
            status: { not: 'CANCELLED' },
          },
          _sum: { net: true },
        }),
        prisma.leaveRequest.findMany({
          where: {
            employeeId: { in: employeeIds },
            status: 'TO_APPROVE',
            dateFrom: { lte: endOfDay(periodEnd) },
            dateTo: { gte: startOfDay(periodStart) },
          },
          select: { duration: true, timeOffTypeId: true },
        }),
        // Approved allocations overlapping the window: the pool that "remaining
        // balance" is measured against.
        prisma.leaveAllocation.findMany({
          where: {
            employeeId: { in: employeeIds },
            status: 'APPROVED',
            validFrom: { lte: endOfDay(periodEnd) },
            OR: [{ validTo: null }, { validTo: { gte: startOfDay(periodStart) } }],
          },
          select: { amount: true, timeOffTypeId: true },
        }),
        prisma.timeOffType.findMany({
          where: { isActive: true },
          select: { id: true, name: true, color: true, code: true, unit: true, requiresAllocation: true },
        }),
      ]);

    // ---- KPIs
    // A period can hold payslips that are not computed yet, which reads as an
    // empty dashboard unless the UI is told why.
    const byStatus = payslips.reduce((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});
    const uncomputed = byStatus.DRAFT ?? 0;

    const totalNet = payslips.reduce((s, p) => s + n(p.net), 0);
    const totalGross = payslips.reduce((s, p) => s + n(p.gross), 0);
    const paidSlips = payslips.filter((p) => p.status === 'PAID');
    const avgSalary = payslips.length ? totalNet / payslips.length : 0;

    const present = attendance.filter((a) => a.status === 'PRESENT').length;
    const late = attendance.filter((a) => a.status === 'LATE').length;
    const missingCheckout = attendance.filter((a) => !a.checkOut).length;
    const manualEdits = attendance.filter((a) => a.isManual).length;
    const overtimeHours = attendance.reduce((s, a) => s + n(a.overtimeHours), 0);
    const attendanceHealth = attendance.length
      ? (present / attendance.length) * 100
      : 0;

    // ---- Salary cost by department
    const byDept = new Map();
    const deptRow = (id, name) => {
      const key = id ?? 'none';
      if (!byDept.has(key)) {
        byDept.set(key, { departmentId: id ?? null, department: name ?? 'Unassigned', headcount: 0, net: 0 });
      }
      return byDept.get(key);
    };
    for (const e of scopedEmployees) {
      deptRow(e.departmentId, e.department?.name).headcount += 1;
    }
    for (const p of payslips) {
      deptRow(p.employee.departmentId, p.employee.department?.name).net += n(p.net);
    }

    // ---- Monthly net salary trend
    const byMonth = new Map();
    for (const p of payslips) {
      const d = new Date(p.periodStart);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      byMonth.set(key, n(byMonth.get(key)) + n(p.net));
    }

    // ---- Leave breakdown
    const byLeaveType = new Map();
    // Policy fields (unit, requiresAllocation) come from the type table, not the
    // slimmer object embedded on a leave request.
    const typeById = new Map(timeOffTypes.map((t) => [t.id, t]));
    const leaveRow = (id, fallback) => {
      if (!byLeaveType.has(id)) {
        const t = typeById.get(id) ?? fallback;
        if (!t) return null;
        byLeaveType.set(id, {
          timeOffTypeId: id, name: t.name, color: t.color, unit: t.unit ?? 'DAYS',
          days: 0, pending: 0, allocated: 0,
          // A type that needs no allocation has no pool, so no balance to show.
          balance: t.requiresAllocation ? 0 : null,
        });
      }
      return byLeaveType.get(id);
    };
    for (const l of leaves) {
      const row = leaveRow(l.timeOffType.id, l.timeOffType);
      if (row) row.days += n(l.duration);
    }
    for (const l of pendingLeaveRows) {
      const row = leaveRow(l.timeOffTypeId);
      if (row) row.pending += n(l.duration);
    }
    for (const a of allocations) {
      const row = leaveRow(a.timeOffTypeId);
      if (row) row.allocated += n(a.amount);
    }
    for (const row of byLeaveType.values()) {
      if (row.balance !== null) row.balance = round(Math.max(0, row.allocated - row.days));
    }

    // ---- Operational alerts derived from live records
    const alerts = [];
    const missingBank = payslips.filter((p) => !p.employee.bankAccount).length;
    if (missingBank) {
      alerts.push({ code: 'MISSING_BANK', severity: 'WARNING',
        message: `${missingBank} payslip(s) belong to employees with no bank account` });
    }
    const noContract = employeeIds.filter(
      (id) => !contracts.some((c) => c.employeeId === id && c.status === 'RUNNING'),
    ).length;
    if (noContract) {
      alerts.push({ code: 'NO_RUNNING_CONTRACT', severity: 'ERROR',
        message: `${noContract} active employee(s) have no running contract` });
    }
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const expiring = contracts.filter(
      (c) => c.status === 'RUNNING' && c.endDate && c.endDate <= soon,
    ).length;
    if (expiring) {
      alerts.push({ code: 'CONTRACT_EXPIRING', severity: 'INFO',
        message: `${expiring} contract(s) expire within 30 days` });
    }
    if (uncomputed) {
      alerts.push({
        code: 'PAYSLIPS_NOT_COMPUTED',
        severity: 'INFO',
        message: `${uncomputed} payslip(s) in this period are still draft — compute the payrun to see salary figures`,
      });
    }
    if (pendingLeaves) {
      alerts.push({ code: 'PENDING_LEAVE', severity: 'INFO',
        message: `${pendingLeaves} time off request(s) awaiting approval` });
    }
    if (missingCheckout) {
      alerts.push({ code: 'MISSING_CHECKOUT', severity: 'WARNING',
        message: `${missingCheckout} attendance record(s) have no check-out` });
    }

    res.json({
      period: { start: periodStart, end: periodEnd },
      kpis: {
        totalNet: round(totalNet),
        totalGross: round(totalGross),
        payslipCount: payslips.length,
        paidCount: paidSlips.length,
        draftCount: uncomputed,
        payslipsByStatus: byStatus,
        avgSalary: round(avgSalary),
        headcount: scopedEmployees.length,
        approvedLeaveDays: round(leaves.reduce((s, l) => s + n(l.duration), 0)),
        pendingLeaveRequests: pendingLeaves,
        attendanceHealth: round(attendanceHealth),
        overtimeHours: round(overtimeHours),
        previousNet: round(n(previousNet._sum.net)),
        // Null rather than 0 when there is no prior period to compare against,
        // so the UI can omit the delta instead of claiming a 0% change.
        netChangePct: n(previousNet._sum.net) > 0
          ? round(((totalNet - n(previousNet._sum.net)) / n(previousNet._sum.net)) * 100)
          : null,
      },
      salaryByDepartment: [...byDept.values()]
        .map((r) => ({ ...r, net: round(r.net) }))
        .sort((a, b) => b.net - a.net),
      monthlyTrend: [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, net]) => ({
          month,
          label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
            month: 'short', year: '2-digit', timeZone: 'UTC',
          }),
          net: round(net),
        })),
      attendanceOverview: {
        total: attendance.length,
        present, late,
        absent: Math.max(0, attendance.length - present - late),
        missingCheckout, manualEdits,
        overtimeHours: round(overtimeHours),
        // Share of records that were actually closed out with a check-out.
        coverage: attendance.length
          ? round(((attendance.length - missingCheckout) / attendance.length) * 100)
          : null,
      },
      leaveOverview: [...byLeaveType.values()]
        .map((r) => ({ ...r, days: round(r.days), pending: round(r.pending), allocated: round(r.allocated) }))
        .sort((a, b) => b.days - a.days),
      payrunStatus: payruns.map((p) => ({ id: p.id, name: p.name, status: p.status })),
      alerts: [...alerts, ...warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message }))],
    });
  }),
);

// Slices any of the three headline metrics along a chosen axis. The client uses
// it both for the group-by switchers and for the panel opened by clicking a bar.
router.get(
  '/drilldown',
  asyncHandler(async (req, res) => {
    const f = drillSchema.parse(req.query);
    res.json(await drilldown({ ...f, ...resolvePeriod(f) }));
  }),
);

export default router;
