import { prisma } from '../../lib/prisma.js';
import { eachDay, isoDayOfWeek, parseHHMM } from '../../lib/dates.js';
import { badRequest } from '../../lib/errors.js';

// Duration counts only days the employee is actually scheduled to work, so a
// Friday-to-Monday request on a Mon-Fri schedule costs 2 days, not 4.
export async function computeDuration({ employeeId, dateFrom, dateTo, unit }, tx = prisma) {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { workingSchedule: { select: { lines: true } } },
  });
  const lines = employee?.workingSchedule?.lines ?? [];

  let days = 0;
  let hours = 0;
  for (const day of eachDay(dateFrom, dateTo)) {
    const line = lines.find((l) => l.dayOfWeek === isoDayOfWeek(day));
    // With no schedule assigned, fall back to Mon-Fri at 8h so the request
    // still gets a sensible duration instead of zero.
    if (!lines.length) {
      if (isoDayOfWeek(day) < 5) {
        days += 1;
        hours += 8;
      }
      continue;
    }
    if (line) {
      days += 1;
      hours += parseHHMM(line.endTime) - parseHHMM(line.startTime) - Number(line.breakHours);
    }
  }

  return Number((unit === 'HOURS' ? hours : days).toFixed(2));
}

// Balance = approved allocations - approved requests, per employee and type.
export async function balanceFor(employeeId, timeOffTypeId, tx = prisma) {
  const [allocations, taken] = await Promise.all([
    tx.leaveAllocation.aggregate({
      where: { employeeId, timeOffTypeId, status: 'APPROVED' },
      _sum: { amount: true },
    }),
    tx.leaveRequest.aggregate({
      where: { employeeId, timeOffTypeId, status: 'APPROVED' },
      _sum: { duration: true },
    }),
  ]);

  const allocated = Number(allocations._sum.amount ?? 0);
  const used = Number(taken._sum.duration ?? 0);
  return { allocated, taken: used, remaining: Number((allocated - used).toFixed(2)) };
}

// Called on approval. For types that require an allocation, refuses to let the
// balance go negative and links the request to the allocation it consumed.
export async function consumeAllocation(request, tx = prisma) {
  const type = await tx.timeOffType.findUnique({ where: { id: request.timeOffTypeId } });
  if (!type.requiresAllocation) return null;

  const { remaining } = await balanceFor(request.employeeId, request.timeOffTypeId, tx);
  const duration = Number(request.duration);
  if (duration > remaining) {
    throw badRequest(
      `Insufficient ${type.name} balance: ${remaining} ${type.unit.toLowerCase()} remaining, ${duration} requested`,
    );
  }

  const allocation = await tx.leaveAllocation.findFirst({
    where: {
      employeeId: request.employeeId,
      timeOffTypeId: request.timeOffTypeId,
      status: 'APPROVED',
      validFrom: { lte: request.dateFrom },
      OR: [{ validTo: null }, { validTo: { gte: request.dateTo } }],
    },
    orderBy: { validFrom: 'asc' },
  });

  return allocation?.id ?? null;
}

export async function overlappingRequest({ employeeId, dateFrom, dateTo, excludeId }, tx = prisma) {
  return tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: ['TO_APPROVE', 'APPROVED'] },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      dateFrom: { lte: dateTo },
      dateTo: { gte: dateFrom },
    },
  });
}
