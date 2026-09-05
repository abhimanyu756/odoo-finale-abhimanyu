import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight, ChevronLeft, Filter, X, Users, Clock, CalendarDays, IndianRupee,
} from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { money, compactMoney } from '../lib/format';
import { Spinner, ErrorState, SearchSelect } from './ui';
import { CategoryBarChart } from './charts';

// The axes a slice can be broken down along. `employee` is the leaf: it names
// people rather than groups, so it ends the drill rather than continuing it.
export const AXES = [
  { value: 'department', label: 'Department', filterKey: 'departmentId' },
  { value: 'jobPosition', label: 'Job Position', filterKey: 'jobPositionId' },
  { value: 'employeeType', label: 'Employee Type', filterKey: 'employeeType' },
  { value: 'workLocation', label: 'Work Location', filterKey: 'workLocation' },
  { value: 'leaveType', label: 'Time Off Type', filterKey: 'timeOffTypeId' },
  { value: 'employee', label: 'Employee', filterKey: 'employeeId' },
];

export const METRICS = {
  salary: {
    label: 'Salary', icon: IndianRupee, valueKey: 'net', name: 'Net salary',
    format: compactMoney, tooltipFormat: money,
  },
  attendance: {
    label: 'Attendance', icon: Clock, valueKey: 'attendance', name: 'Records',
    format: (v) => String(v), tooltipFormat: (v) => `${v} records`,
  },
  leave: {
    label: 'Time Off', icon: CalendarDays, valueKey: 'leaveDays', name: 'Days',
    format: (v) => String(v), tooltipFormat: (v) => `${v} days`,
  },
};

// A leave type only exists on leave records, so it cannot slice salary or
// attendance; and the leaf axis is never offered as a grouping.
const axesFor = (metric, taken) =>
  AXES.filter(
    (a) => a.value !== 'employee'
      && !taken.includes(a.filterKey)
      && (a.value !== 'leaveType' || metric === 'leave'),
  );

/*
 * The drill-down panel. `trail` is the chain of slices the user clicked to get
 * here - each one contributes a filter, so the question asked at every level is
 * the same one asked of a smaller population. Clicking a bar pushes onto the
 * trail; the breadcrumb pops back off it.
 */
export default function DrillDown({
  base, heading, baseLabels, trail, metric, onTrail, onMetric, onClose, onApplyFilter,
}) {
  const taken = trail.map((t) => t.filterKey);
  const options = axesFor(metric, taken);
  const [dimension, setDimension] = useState(options[0]?.value ?? 'department');

  // A grouping already consumed by the trail is no longer offered; fall back to
  // whatever is still available rather than querying a collapsed axis.
  const activeDimension = options.some((o) => o.value === dimension)
    ? dimension
    : options[0]?.value ?? 'employee';

  // useFetch keys off a JSON snapshot of these params, so rebuilding the object
  // each render costs nothing and keeps the trail's filters in one place.
  const params = { ...base, metric, dimension: activeDimension, limit: 15 };
  for (const t of trail) params[t.filterKey] = t.value;

  const { data, loading, error, refetch } = useFetch('/dashboard/drilldown', { params });
  const { data: people } = useFetch('/dashboard/drilldown', {
    params: { ...params, dimension: 'employee', limit: 8 },
  });

  // "All" would be a lie when the dashboard itself is already filtered, so the
  // root crumb names the base scope it actually sits inside.
  const baseScope = baseLabels?.length ? baseLabels.join(' · ') : null;
  const rootLabel = heading ?? (baseScope ? `All in ${baseScope}` : 'All');

  const m = METRICS[metric];
  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (a, r) => ({
      net: a.net + r.net,
      headcount: a.headcount + r.headcount,
      attendance: a.attendance + r.attendance,
      present: a.present + r.present,
      leaveDays: a.leaveDays + r.leaveDays,
    }),
    { net: 0, headcount: 0, attendance: 0, present: 0, leaveDays: 0 },
  );
  const health = totals.attendance ? Math.round((totals.present / totals.attendance) * 100) : null;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const back = () => onTrail(trail.slice(0, -1));

  const push = (row) => {
    const axis = AXES.find((a) => a.value === activeDimension);
    if (!axis || row.key === 'none') return;
    onTrail([...trail, { filterKey: axis.filterKey, value: row.key, label: row.label, axis: axis.label }]);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8">
      <div className="o-card w-full max-w-5xl shadow-xl">
        {/* ---- Header: how you got here, and how to get back ---- */}
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            {/* An explicit one-step Back: the breadcrumb can do it too, but only
                once you know the crumbs are clickable. */}
            <button
              type="button"
              className="o-btn-secondary mt-0.5 shrink-0 px-2 py-1 text-xs"
              disabled={!trail.length}
              onClick={back}
              title={trail.length ? `Back to ${trail.length > 1 ? trail[trail.length - 2].label : rootLabel}` : 'Already at the top'}
            >
              <ChevronLeft size={14} />
              Back
            </button>

            <div className="min-w-0">
              <nav aria-label="Drill-down path" className="flex flex-wrap items-center gap-1 text-sm">
                {/* The root names the slice the panel was opened on, so an
                    attendance band reads "Late" rather than "All". */}
                <button
                  type="button"
                  onClick={() => onTrail([])}
                  disabled={!trail.length}
                  className={trail.length
                    ? 'rounded px-1 font-medium text-odoo-600 underline decoration-odoo-300 underline-offset-2 hover:bg-odoo-50 hover:decoration-odoo-600'
                    : 'px-1 font-semibold text-ink'}
                >
                  {rootLabel}
                </button>
                {trail.map((t, i) => {
                  const isLast = i === trail.length - 1;
                  return (
                    <span key={t.filterKey} className="flex items-center gap-1">
                      <ChevronRight size={13} className="text-ink-soft" />
                      <button
                        type="button"
                        onClick={() => onTrail(trail.slice(0, i + 1))}
                        disabled={isLast}
                        title={isLast ? undefined : `Back to ${t.label}`}
                        className={isLast
                          ? 'rounded px-1 font-semibold text-ink'
                          : 'rounded px-1 text-odoo-600 underline decoration-odoo-300 underline-offset-2 hover:bg-odoo-50 hover:decoration-odoo-600'}
                      >
                        <span className="text-[10px] uppercase tracking-wide text-ink-soft">{t.axis}: </span>
                        {t.label}
                      </button>
                    </span>
                  );
                })}
              </nav>
              <p className="mt-0.5 text-xs text-ink-soft">
                {totals.headcount} employee{totals.headcount === 1 ? '' : 's'}
                {' · '}{money(totals.net)} net
                {health !== null && ` · ${health}% attendance health`}
                {totals.leaveDays > 0 && ` · ${Math.round(totals.leaveDays)} leave days`}
              </p>
            </div>
          </div>

          <button type="button" className="o-btn-ghost px-2 py-1" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* ---- Controls: which metric, sliced along which axis ---- */}
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
          <div className="flex rounded-md border border-hairline p-0.5">
            {Object.entries(METRICS).map(([key, cfg]) => (
              <button
                key={key}
                type="button"
                onClick={() => onMetric(key)}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors
                  ${key === metric ? 'bg-odoo-500 text-white' : 'text-ink-soft hover:bg-odoo-50'}`}
              >
                <cfg.icon size={13} />
                {cfg.label}
              </button>
            ))}
          </div>

          {options.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-ink-soft">
              Group by
              <SearchSelect
                className="w-auto min-w-40"
                value={activeDimension}
                onChange={setDimension}
                options={options.map((o) => ({ value: o.value, label: o.label }))}
                searchPlaceholder="Search axes…"
              />
            </label>
          )}

          {trail.length > 0 && (
            <button
              type="button"
              className="o-btn-secondary ml-auto text-xs"
              onClick={() => onApplyFilter(trail)}
              title="Narrow the whole dashboard to this slice"
            >
              <Filter size={13} />
              Apply to dashboard
            </button>
          )}
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-4 py-4">
          {error && <ErrorState message={error} onRetry={refetch} />}
          {loading && !data && <Spinner label="Slicing data" />}

          {data && (
            <>
              <p className="mb-2 text-xs text-ink-soft">
                {m.label} by {data.dimensionLabel}
                {data.truncated && ` · top ${rows.length} of ${data.totalGroups}`}
                {options.length > 0 && ' · click a bar to go deeper'}
              </p>

              {rows.some((r) => r[m.valueKey] > 0) ? (
                <CategoryBarChart
                  data={rows.filter((r) => r[m.valueKey] > 0)}
                  valueKey={m.valueKey}
                  name={m.name}
                  format={m.format}
                  tooltipFormat={m.tooltipFormat}
                  onSelect={options.length > 0 ? push : undefined}
                  labelWidth={140}
                />
              ) : (
                <p className="py-8 text-center text-sm text-ink-soft">
                  No {m.label.toLowerCase()} data in this slice
                </p>
              )}

              {/* ---- The leaf level: the actual people behind the bars ---- */}
              {people?.rows?.length > 0 && (
                <div className="mt-5">
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
                    <Users size={13} className="text-odoo-400" />
                    Top employees in this slice
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="o-table">
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th className="text-right">Net Salary</th>
                          <th className="text-right">Payslips</th>
                          <th className="text-right">Attendance</th>
                          <th className="text-right">Late</th>
                          <th className="text-right">Leave Days</th>
                        </tr>
                      </thead>
                      <tbody>
                        {people.rows.map((r) => (
                          <tr key={r.key}>
                            <td className="font-medium text-ink">
                              <Link to={`/employees/${r.key}`} className="hover:text-odoo-600 hover:underline">
                                {r.label}
                              </Link>
                            </td>
                            <td className="text-right tabular-nums">{money(r.net)}</td>
                            <td className="text-right tabular-nums text-ink-soft">{r.payslips}</td>
                            <td className="text-right tabular-nums">{r.attendance}</td>
                            <td className="text-right tabular-nums text-ink-soft">{r.late}</td>
                            <td className="text-right tabular-nums">{r.leaveDays}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
