import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';
import { startOfDay, endOfDay } from '../../lib/dates.js';

const router = Router();
router.use(authenticate, requireMinRole('HR_PAYROLL_USER'));

const n = (v) => Number(v ?? 0);
const round = (v) => Number(n(v).toFixed(2));

const filterSchema = z.object({
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  departmentId: z.string().uuid().optional(),
  employeeType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']).optional(),
});

// Every metric is aggregated from live HR and payroll records; nothing here is
// precomputed or hardcoded, so the dashboard always reflects current state.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = filterSchema.parse(req.query);

    // Default window: the trailing 12 months through the end of the current
    // month, so an in-progress payroll period is still included in the trend.
    const now = new Date();
    const periodEnd = f.periodEnd
      ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const periodStart = f.periodStart
      ?? new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 11, 1));

    const employeeWhere = {
      status: 'ACTIVE',
      ...(f.departmentId ? { departmentId: f.departmentId } : {}),
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

    const [payslips, attendance, leaves, pendingLeaves, contracts, payruns, warnings] =
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
          select: { duration: true, timeOffType: { select: { name: true, color: true, code: true } } },
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
    for (const e of scopedEmployees) {
      const key = e.department?.name ?? 'Unassigned';
      const row = byDept.get(key) ?? { department: key, headcount: 0, net: 0 };
      row.headcount += 1;
      byDept.set(key, row);
    }
    for (const p of payslips) {
      const key = p.employee.department?.name ?? 'Unassigned';
      const row = byDept.get(key) ?? { department: key, headcount: 0, net: 0 };
      row.net += n(p.net);
      byDept.set(key, row);
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
    for (const l of leaves) {
      const key = l.timeOffType.name;
      const row = byLeaveType.get(key) ?? { name: key, color: l.timeOffType.color, days: 0 };
      row.days += n(l.duration);
      byLeaveType.set(key, row);
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
      },
      leaveOverview: [...byLeaveType.values()].map((r) => ({ ...r, days: round(r.days) })),
      payrunStatus: payruns.map((p) => ({ id: p.id, name: p.name, status: p.status })),
      alerts: [...alerts, ...warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message }))],
    });
  }),
);

export default router;
