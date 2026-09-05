export const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

export const monthRange = (year, month) => ({
  periodStart: new Date(Date.UTC(year, month - 1, 1)),
  periodEnd: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
});

// Two ranges overlap unless one ends before the other starts. A null end date
// means open-ended, which overlaps everything after its start.
export const rangesOverlap = (aStart, aEnd, bStart, bEnd) => {
  const aE = aEnd ?? new Date(8640000000000000);
  const bE = bEnd ?? new Date(8640000000000000);
  return aStart <= bE && bStart <= aE;
};

export const eachDay = function* (from, to) {
  const cur = startOfDay(from);
  const last = startOfDay(to);
  while (cur <= last) {
    yield new Date(cur);
    cur.setDate(cur.getDate() + 1);
  }
};

// Prisma stores WorkingScheduleLine.dayOfWeek as 0=Mon..6=Sun; JS uses 0=Sun.
export const isoDayOfWeek = (d) => (d.getDay() + 6) % 7;

export const hoursBetween = (start, end) =>
  Math.max(0, (new Date(end) - new Date(start)) / 3_600_000);

export const parseHHMM = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h + (m || 0) / 60;
};
