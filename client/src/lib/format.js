const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrPrecise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

export const money = (v, precise = false) =>
  v == null ? '—' : (precise ? inrPrecise : inr).format(Number(v));

export const compactMoney = (v) => {
  const n = Number(v ?? 0);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
};

export const date = (v) =>
  v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const dateTime = (v) =>
  v ? new Date(v).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '—';

export const time = (v) =>
  v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

export const hours = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}`);

export const initials = (name = '') =>
  name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

export const titleCase = (s = '') =>
  s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Every IANA zone the browser knows, each labelled with its current UTC offset -
// "Asia/Kolkata" alone does not tell you it is +5:30. Offsets are computed once
// per session; they shift with DST, which is correct for a picker showing what
// the zone is right now.
//
// supportedValuesOf is unavailable on older Safari, so a short list of common
// zones keeps the field usable rather than empty.
const FALLBACK_ZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo', 'UTC',
];

const offsetOf = (tz) => {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
};

let zoneCache = null;
export function timeZoneOptions() {
  if (zoneCache) return zoneCache;
  const zones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : FALLBACK_ZONES;
  zoneCache = zones.map((z) => ({ value: z, label: z.replace(/_/g, ' '), hint: offsetOf(z) }));
  return zoneCache;
}

// The viewer's own zone, offered first so the common case is one click.
export const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};
