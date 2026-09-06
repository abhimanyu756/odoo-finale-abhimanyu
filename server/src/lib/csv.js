/*
 * CSV export shared by every list endpoint.
 *
 * The export reuses each route's own `where` clause, so a downloaded file always
 * matches exactly what the screen was showing - the filters, the search and the
 * sort, just without the pagination.
 */

// RFC 4180 quoting. Values containing a comma, quote or newline are wrapped and
// inner quotes doubled; everything else is emitted bare.
const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (columns, rows) =>
  [
    columns.map((c) => cell(c.header)).join(','),
    ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(',')),
  ].join('\r\n');

// Excel opens UTF-8 CSV as the system codepage unless it sees a BOM, which
// mangles the rupee sign and every non-ASCII name in the file.
export function sendCsv(res, filename, columns, rows) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${stamp}.csv"`);
  res.send(`﻿${toCsv(columns, rows)}`);
}

// Exports are unpaginated but not unbounded: a runaway query would otherwise
// try to serialise the whole table into memory.
export const EXPORT_LIMIT = 10000;
