import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { contractForPeriod } from '../contracts/contracts.service.js';
import { buildContext, runRules } from '../salary/compute.js';

export async function nextPayslipNumber(periodStart, tx = prisma) {
  const d = new Date(periodStart);
  const prefix = `SLIP/${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}/`;
  const last = await tx.payslip.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// Employees eligible for a payrun: active, and holding a contract that covers
// the period. Each row explains itself so step 2 of the wizard can show why
// someone is or is not selectable.
export async function eligibleEmployees({ periodStart, periodEnd, departmentId, employeeType }) {
  const employees = await prisma.employee.findMany({
    where: {
      status: 'ACTIVE',
      ...(departmentId ? { departmentId } : {}),
      ...(employeeType ? { employeeType } : {}),
    },
    include: {
      department: { select: { id: true, name: true } },
      jobPosition: { select: { id: true, name: true } },
      workingSchedule: { select: { name: true, hoursPerWeek: true } },
    },
    orderBy: { firstName: 'asc' },
  });

  return Promise.all(
    employees.map(async (e) => {
      const contract = await contractForPeriod(e.id, periodStart, periodEnd);
      // The contract's own schedule wins over the employee default, since that
      // is what payroll uses for the period.
      const schedule = contract?.workingSchedule ?? e.workingSchedule;
      return {
        id: e.id,
        name: `${e.firstName} ${e.lastName}`,
        workEmail: e.workEmail,
        department: e.department,
        jobPosition: e.jobPosition,
        employeeType: e.employeeType,
        workingHours: schedule ? Number(schedule.hoursPerWeek) : null,
        workingSchedule: schedule?.name ?? null,
        contract: contract
          ? {
              id: contract.id,
              reference: contract.reference,
              wage: Number(contract.wage),
              status: contract.status,
              startDate: contract.startDate,
            }
          : null,
        eligible: Boolean(contract),
        reason: contract ? null : 'No contract covers this period',
      };
    }),
  );
}

const warn = (code, message, severity = 'WARNING') => ({ code, message, severity });

// Checks run before and after computation and surface on the payrun screen.
export async function collectWarnings(payrun, tx = prisma) {
  const warnings = [];

  const payslips = await tx.payslip.findMany({
    where: { payrunId: payrun.id },
    include: { employee: true, contract: true },
  });

  if (!payslips.length) warnings.push(warn('NO_PAYSLIPS', 'This payrun has no payslips', 'ERROR'));

  for (const slip of payslips) {
    const who = `${slip.employee.firstName} ${slip.employee.lastName}`;

    if (!slip.employee.bankAccount) {
      warnings.push(warn('MISSING_BANK', `${who} has no bank account on file`));
    }
    if (!slip.employee.workEmail) {
      warnings.push(warn('MISSING_EMAIL', `${who} has no work email; payslip cannot be sent`));
    }
    if (Number(slip.net) < 0) {
      warnings.push(warn('NEGATIVE_NET', `${who} has a negative net salary`, 'ERROR'));
    }
    if (Number(slip.net) === 0 && slip.status !== 'DRAFT') {
      warnings.push(warn('ZERO_NET', `${who} computed to a zero net salary`));
    }
    if (slip.contract.status !== 'RUNNING') {
      warnings.push(
        warn('CONTRACT_NOT_RUNNING', `${who} is paid from ${slip.contract.reference} (${slip.contract.status})`),
      );
    }

    // The same employee paid twice for one period across different payruns.
    const duplicates = await tx.payslip.count({
      where: {
        employeeId: slip.employeeId,
        payrunId: { not: payrun.id },
        periodStart: { lte: slip.periodEnd },
        periodEnd: { gte: slip.periodStart },
        status: { not: 'CANCELLED' },
      },
    });
    if (duplicates) {
      warnings.push(
        warn('DUPLICATE_PAYSLIP', `${who} already has ${duplicates} payslip(s) covering this period`, 'ERROR'),
      );
    }
  }

  return warnings;
}

export async function persistWarnings(payrunId, warnings, tx = prisma) {
  await tx.payrollWarning.deleteMany({ where: { payrunId } });
  if (warnings.length) {
    await tx.payrollWarning.createMany({
      data: warnings.map((w) => ({ ...w, payrunId })),
    });
  }
  return warnings;
}

// Computes every payslip in a payrun from the period contract and the run's
// structure, replacing any previously computed lines.
export async function computePayrun(payrunId) {
  return prisma.$transaction(
    async (tx) => {
      const payrun = await tx.payrun.findUnique({
        where: { id: payrunId },
        include: { structure: { include: { rules: true } }, payslips: true },
      });
      if (!payrun) throw badRequest('Payrun not found');
      if (['VALIDATED', 'PAID'].includes(payrun.status)) {
        throw badRequest(`A ${payrun.status.toLowerCase()} payrun can no longer be recomputed`);
      }
      if (!payrun.structure.rules.length) {
        throw badRequest(`Structure ${payrun.structure.name} has no salary rules`);
      }

      for (const slip of payrun.payslips) {
        const employee = await tx.employee.findUnique({
          where: { id: slip.employeeId },
          include: { workingSchedule: { include: { lines: true } } },
        });
        const contract = await tx.contract.findUnique({
          where: { id: slip.contractId },
          include: { workingSchedule: { include: { lines: true } } },
        });

        const context = await buildContext(
          { employee, contract, periodStart: payrun.periodStart, periodEnd: payrun.periodEnd },
          tx,
        );
        const { lines, totals } = runRules(payrun.structure.rules, context);

        await tx.payslipLine.deleteMany({ where: { payslipId: slip.id } });
        await tx.payslip.update({
          where: { id: slip.id },
          data: {
            status: 'COMPUTED',
            workedDays: context.worked_days,
            workedHours: context.worked_hours,
            leaveDays: context.leave_days,
            basic: totals.basic,
            allowance: totals.allowance,
            gross: totals.gross,
            deduction: totals.deduction,
            net: totals.net,
            lines: { create: lines },
          },
        });
      }

      const updated = await tx.payrun.update({
        where: { id: payrunId },
        data: { status: 'COMPUTED', computedAt: new Date() },
      });

      await persistWarnings(payrunId, await collectWarnings(updated, tx), tx);
      return updated;
    },
    { timeout: 30_000 },
  );
}
