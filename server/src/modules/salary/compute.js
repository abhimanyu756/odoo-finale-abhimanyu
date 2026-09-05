import { prisma } from '../../lib/prisma.js';
import { evaluate } from './expression.js';
import { badRequest } from '../../lib/errors.js';
import { eachDay, isoDayOfWeek, parseHHMM, startOfDay, endOfDay } from '../../lib/dates.js';

// Bases a PERCENTAGE rule can be measured against, per the mockup's
// "percentage of a selected base such as Contract Wage, Basic, or Gross".
export const PERCENT_BASES = {
  WAGE: (ctx) => ctx.wage,
  BASIC: (ctx) => ctx.categories.BASIC,
  GROSS: (ctx) => ctx.categories.GROSS,
  NET: (ctx) => ctx.categories.NET,
};

// Builds the period facts a rule can read: contract wage, attendance-derived
// worked days/hours, approved leave, and the running category totals.
export async function buildContext({ employee, contract, periodStart, periodEnd }, tx = prisma) {
  const lines = contract.workingSchedule?.lines ?? employee.workingSchedule?.lines ?? [];

  let scheduledDays = 0;
  let scheduledHours = 0;
  for (const day of eachDay(periodStart, periodEnd)) {
    const line = lines.find((l) => l.dayOfWeek === isoDayOfWeek(day));
    if (line) {
      scheduledDays += 1;
      scheduledHours += parseHHMM(line.endTime) - parseHHMM(line.startTime) - Number(line.breakHours);
    } else if (!lines.length && isoDayOfWeek(day) < 5) {
      scheduledDays += 1;
      scheduledHours += 8;
    }
  }

  const [attendance, leaves] = await Promise.all([
    tx.attendance.aggregate({
      where: {
        employeeId: employee.id,
        checkIn: { gte: startOfDay(periodStart), lte: endOfDay(periodEnd) },
        checkOut: { not: null },
      },
      _sum: { workedHours: true, overtimeHours: true },
      _count: true,
    }),
    tx.leaveRequest.findMany({
      where: {
        employeeId: employee.id,
        status: 'APPROVED',
        dateFrom: { lte: endOfDay(periodEnd) },
        dateTo: { gte: startOfDay(periodStart) },
      },
      include: { timeOffType: true },
    }),
  ]);

  const leaveDays = leaves.reduce((s, l) => s + Number(l.duration), 0);
  const unpaidLeaveDays = leaves
    .filter((l) => !l.timeOffType.isPaid)
    .reduce((s, l) => s + Number(l.duration), 0);

  const attendedDays = attendance._count ?? 0;
  const workedHours = Number(attendance._sum.workedHours ?? 0);

  // Worked days: attendance where it exists, otherwise the schedule less
  // unpaid leave, so payroll still computes for employees who do not punch in.
  const workedDays = attendedDays > 0
    ? attendedDays
    : Math.max(0, scheduledDays - unpaidLeaveDays);

  return {
    wage: Number(contract.wage),
    worked_days: Number(workedDays.toFixed(2)),
    worked_hours: Number(workedHours.toFixed(2)),
    overtime_hours: Number(Number(attendance._sum.overtimeHours ?? 0).toFixed(2)),
    scheduled_days: scheduledDays,
    scheduled_hours: Number(scheduledHours.toFixed(2)),
    leave_days: Number(leaveDays.toFixed(2)),
    unpaid_leave_days: Number(unpaidLeaveDays.toFixed(2)),
    days_in_period: [...eachDay(periodStart, periodEnd)].length,
    categories: { BASIC: 0, ALLOWANCE: 0, GROSS: 0, DEDUCTION: 0, NET: 0 },
    rules: {},
  };
}

function amountFor(rule, ctx) {
  const quantity = Number(rule.quantity ?? 1);

  switch (rule.computeType) {
    case 'FIXED':
      return Number(rule.amount ?? 0) * quantity;

    case 'PERCENTAGE': {
      const pct = Number(rule.percentage ?? 0) / 100;
      const baseKey = (rule.baseExpr ?? 'WAGE').toUpperCase();
      // A named base is the common case; anything else is treated as an
      // expression so a rule can take a percentage of an arbitrary total.
      const base = PERCENT_BASES[baseKey]
        ? PERCENT_BASES[baseKey](ctx)
        : evaluate(rule.baseExpr, ctx);
      return base * pct * quantity;
    }

    case 'FORMULA': {
      if (!rule.expression) {
        throw badRequest(`Rule ${rule.code} is set to FORMULA but has no expression`);
      }
      return evaluate(rule.expression, ctx) * quantity;
    }

    default:
      throw badRequest(`Unknown computation type ${rule.computeType} on rule ${rule.code}`);
  }
}

// Runs every active rule in ascending sequence. Each result is folded into the
// running category totals before the next rule runs, so later rules (GROSS,
// NET) can be expressed in terms of earlier ones.
export function runRules(rules, context) {
  const ctx = { ...context, categories: { ...context.categories }, rules: { ...context.rules } };
  const lines = [];

  for (const rule of [...rules].sort((a, b) => a.sequence - b.sequence)) {
    if (!rule.isActive) continue;

    if (rule.condition) {
      const passed = evaluate(rule.condition, ctx);
      if (!passed) continue;
    }

    const amount = Number(amountFor(rule, ctx).toFixed(2));

    lines.push({
      ruleId: rule.id,
      code: rule.code,
      name: rule.name,
      category: rule.category,
      sequence: rule.sequence,
      amount,
    });

    // GROSS and NET are totals the structure defines; adding their own result
    // back into the running total would double-count the components already
    // summed into them.
    if (rule.category === 'GROSS' || rule.category === 'NET') {
      ctx.categories[rule.category] = amount;
    } else {
      ctx.categories[rule.category] += amount;
    }
    ctx.rules[rule.code] = amount;
  }

  // Fall back to derived totals when the structure defines no GROSS/NET rule.
  const basic = Number(ctx.categories.BASIC.toFixed(2));
  const allowance = Number(ctx.categories.ALLOWANCE.toFixed(2));
  const deduction = Number(ctx.categories.DEDUCTION.toFixed(2));
  const gross = ctx.categories.GROSS || Number((basic + allowance).toFixed(2));
  const net = ctx.categories.NET || Number((gross - deduction).toFixed(2));

  return {
    lines,
    totals: { basic, allowance, gross, deduction, net: Number(net.toFixed(2)) },
    context: ctx,
  };
}
