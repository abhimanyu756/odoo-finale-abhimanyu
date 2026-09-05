import { prisma } from '../../lib/prisma.js';
import { rangesOverlap } from '../../lib/dates.js';
import { conflict } from '../../lib/errors.js';

// CON/<year>/<4-digit sequence>, sequence scoped to the contract's start year.
export async function nextReference(startDate, tx = prisma) {
  const year = new Date(startDate).getUTCFullYear();
  const prefix = `CON/${year}/`;
  const last = await tx.contract.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  const seq = last ? Number(last.reference.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// The spec forbids concurrent RUNNING contracts for one employee, because
// payroll must be able to resolve exactly one contract per period.
export async function assertNoOverlap({ employeeId, startDate, endDate, excludeId }, tx = prisma) {
  const siblings = await tx.contract.findMany({
    where: {
      employeeId,
      status: 'RUNNING',
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, reference: true, startDate: true, endDate: true },
  });

  const clash = siblings.find((c) =>
    rangesOverlap(startDate, endDate ?? null, c.startDate, c.endDate),
  );

  if (clash) {
    throw conflict(
      `Overlaps running contract ${clash.reference}. An employee cannot have two running contracts covering the same period.`,
      { conflictingContractId: clash.id },
    );
  }
}

// Resolves the single contract that applies to a payroll period. Prefers a
// RUNNING contract; falls back to any contract covering the period so payroll
// can still explain itself when statuses are stale.
export async function contractForPeriod(employeeId, periodStart, periodEnd, tx = prisma) {
  const candidates = await tx.contract.findMany({
    where: {
      employeeId,
      startDate: { lte: periodEnd },
      OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
    },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
  });

  return candidates.find((c) => c.status === 'RUNNING') ?? candidates[0] ?? null;
}
