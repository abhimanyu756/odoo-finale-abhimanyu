import { prisma } from '../../lib/prisma.js';
import { hoursBetween, isoDayOfWeek, parseHHMM, startOfDay, endOfDay } from '../../lib/dates.js';

// Minutes after the scheduled start before a check-in counts as LATE.
export const LATE_GRACE_MINUTES = 15;

// Returns the schedule line covering a given date, or null on a non-working day.
export async function scheduleLineFor(employeeId, date, tx = prisma) {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { workingSchedule: { select: { lines: true } } },
  });
  const lines = employee?.workingSchedule?.lines ?? [];
  return lines.find((l) => l.dayOfWeek === isoDayOfWeek(new Date(date))) ?? null;
}

// Worked hours are the raw check-in..check-out span, which is what the
// attendance list displays. Overtime is measured against the scheduled span
// net of the configured break, so a normal day yields zero overtime.
export function deriveMetrics({ checkIn, checkOut, line }) {
  if (!checkOut) {
    return { workedHours: 0, overtimeHours: 0, status: 'MISSING_CHECKOUT' };
  }

  const workedHours = Number(hoursBetween(checkIn, checkOut).toFixed(2));
  const breakHours = line ? Number(line.breakHours) : 0;
  const expected = line ? parseHHMM(line.endTime) - parseHHMM(line.startTime) - breakHours : 0;
  const net = workedHours - breakHours;
  const overtimeHours = Number(Math.max(0, net - expected).toFixed(2));

  let status = 'PRESENT';
  if (line) {
    const start = new Date(checkIn);
    const startedAt = start.getHours() + start.getMinutes() / 60;
    if (startedAt > parseHHMM(line.startTime) + LATE_GRACE_MINUTES / 60) status = 'LATE';
  }

  return { workedHours, overtimeHours, status };
}

export async function recomputeAttendance(id, tx = prisma) {
  const row = await tx.attendance.findUnique({ where: { id } });
  if (!row) return null;
  const line = await scheduleLineFor(row.employeeId, row.checkIn, tx);
  const metrics = deriveMetrics({ checkIn: row.checkIn, checkOut: row.checkOut, line });
  return tx.attendance.update({ where: { id }, data: metrics });
}

export const openSessionFor = (employeeId, tx = prisma) =>
  tx.attendance.findFirst({
    where: { employeeId, checkOut: null },
    orderBy: { checkIn: 'desc' },
  });

export async function todayTotals(employeeId, tx = prisma) {
  const now = new Date();
  const rows = await tx.attendance.findMany({
    where: { employeeId, checkIn: { gte: startOfDay(now), lte: endOfDay(now) } },
  });
  // Computed from the raw timestamps rather than the stored workedHours: that
  // column is Decimal(6,2) hours, so its smallest unit is 36 seconds and a
  // short session would round away to zero on the widget.
  const closed = rows
    .filter((r) => r.checkOut)
    .reduce((s, r) => s + hoursBetween(r.checkIn, r.checkOut), 0);
  const open = rows
    .filter((r) => !r.checkOut)
    .reduce((s, r) => s + hoursBetween(r.checkIn, now), 0);

  return Number((closed + open).toFixed(4));
}
