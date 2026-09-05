import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  IndianRupee, Receipt, TrendingUp, TrendingDown, CalendarCheck, Activity,
  AlertTriangle, AlertCircle, Info, Table2, BarChart3, X, Building2, RotateCcw,
} from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { money, compactMoney, titleCase } from '../lib/format';
import { PageHeader, Spinner, ErrorState, StatusBadge, SearchSelect } from '../components/ui';
import {
  CategoryBarChart, NetSalaryTrend, AttendanceComposition, SERIES, STATUS,
} from '../components/charts';
import DrillDown, { AXES } from '../components/DrillDown';

const SEVERITY = {
  ERROR: { icon: AlertCircle, tone: 'border-red-200 bg-red-50 text-red-800' },
  WARNING: { icon: AlertTriangle, tone: 'border-amber-200 bg-amber-50 text-amber-800' },
  INFO: { icon: Info, tone: 'border-blue-200 bg-blue-50 text-blue-800' },
};

// Payslip lifecycle, in order, with the colours the status split bar uses.
const SLIP_STATES = [
  { key: 'PAID', label: 'Paid', color: STATUS.good },
  { key: 'VALIDATED', label: 'Validated', color: SERIES.slot1 },
  { key: 'COMPUTED', label: 'Computed', color: SERIES.primary },
  { key: 'DRAFT', label: 'Draft', color: STATUS.warning },
];

const GROUPABLE = AXES.filter((a) => !['employee', 'leaveType'].includes(a.value));

export default function Dashboard() {
  const [filters, setFilters] = useState({});
  // Filter values are held in state, not left to the DOM: a refetch re-renders
  // this component and an uncontrolled input would come back blank.
  const [period, setPeriod] = useState('');
  const [showTable, setShowTable] = useState(false);
  const [salaryAxis, setSalaryAxis] = useState('department');
  const [leaveAxis, setLeaveAxis] = useState('leaveType');
  // The drill-down panel: a chain of clicked slices plus the metric in view.
  const [drill, setDrill] = useState(null);

  const { data, loading, error, refetch } = useFetch('/dashboard', { params: filters });
  const { data: depts } = useFetch('/org/departments');
  const { data: companies } = useFetch('/org/companies');
  const { data: positions } = useFetch('/org/job-positions');

  const { data: salaryGroups } = useFetch('/dashboard/drilldown', {
    params: { ...filters, metric: 'salary', dimension: salaryAxis, limit: 15 },
  });
  const { data: leaveGroups } = useFetch('/dashboard/drilldown', {
    params: { ...filters, metric: 'leave', dimension: leaveAxis, limit: 15 },
    skip: leaveAxis === 'leaveType',
  });

  const setMonthRange = (value) => {
    setPeriod(value);
    if (!value) {
      setFilters((f) => ({ ...f, periodStart: undefined, periodEnd: undefined }));
      return;
    }
    const [y, m] = value.split('-').map(Number);
    setFilters((f) => ({
      ...f,
      periodStart: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
      periodEnd: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)).toISOString(),
    }));
  };

  const periodLabel = period
    ? new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-IN', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      })
    : 'Last 12 months';

  // Chips for the non-period filters, so a narrowed dashboard always says so.
  const chips = [
    filters.companyId && {
      key: 'companyId',
      label: (companies ?? []).find((c) => c.id === filters.companyId)?.name ?? 'Company',
    },
    filters.departmentId && {
      key: 'departmentId',
      label: (depts ?? []).find((d) => d.id === filters.departmentId)?.name ?? 'Department',
    },
    filters.employeeType && { key: 'employeeType', label: titleCase(filters.employeeType) },
    filters.jobPositionId && {
      key: 'jobPositionId',
      label: (positions ?? []).find((p) => p.id === filters.jobPositionId)?.name ?? 'Job position',
    },
    filters.workLocation && { key: 'workLocation', label: filters.workLocation },
  ].filter(Boolean);

  const openDrill = (trail, metric = 'salary') => setDrill({ trail, metric });

  const hasFilters = chips.length > 0 || Boolean(period);
  const resetAll = () => {
    setFilters({});
    setPeriod('');
  };

  // "Apply to dashboard" turns a drill trail into real dashboard filters, so the
  // whole page - KPIs included - narrows to the slice the user was exploring.
  const applyTrail = (trail) => {
    // A time off type scopes leave records, not the employee population, so it
    // has no meaning as a page-wide filter and is dropped rather than sent and
    // silently ignored by the server.
    const usable = trail.filter((t) => t.filterKey !== 'timeOffTypeId');
    setFilters((f) => ({ ...f, ...Object.fromEntries(usable.map((t) => [t.filterKey, t.value])) }));
    setDrill(null);
  };

  const k = data?.kpis;
  const delta = k?.netChangePct;

  const kpiTiles = !k ? [] : [
    { label: 'Total Net Salary Paid', value: money(k.totalNet), icon: IndianRupee,
      hint: `${k.paidCount} of ${k.payslipCount} payslips paid`,
      delta },
    { label: 'Payslips Generated', value: k.payslipCount, icon: Receipt,
      hint: `${k.paidCount} paid, ${k.draftCount} draft` },
    { label: 'Average Salary', value: money(k.avgSalary), icon: TrendingUp,
      hint: `${k.headcount} active employees` },
    { label: 'Approved Time Off', value: `${k.approvedLeaveDays} days`, icon: CalendarCheck,
      hint: `${k.pendingLeaveRequests} request(s) pending` },
    { label: 'Attendance Health', value: `${k.attendanceHealth}%`, icon: Activity,
      hint: `${k.overtimeHours}h overtime · ${data.attendanceOverview.coverage ?? '—'}% coverage` },
  ];

  const slipSplit = SLIP_STATES
    .map((s) => ({ ...s, value: k?.payslipsByStatus?.[s.key] ?? 0 }))
    .filter((s) => s.value > 0);
  const slipTotal = slipSplit.reduce((s, r) => s + r.value, 0) || 1;

  const axisLabel = (v) => GROUPABLE.find((a) => a.value === v)?.label ?? 'Department';

  return (
    <>
      <PageHeader
        title="Payroll Dashboard"
        subtitle="Live metrics aggregated across employees, contracts, attendance, time off and payroll"
        actions={
          <>
            {hasFilters && (
              <button type="button" className="o-btn-secondary" onClick={resetAll}
                title="Clear every filter and return to the default view">
                <RotateCcw size={14} />
                Reset filters
              </button>
            )}
            <button type="button" className="o-btn-secondary" onClick={() => setShowTable((v) => !v)}>
              {showTable ? <BarChart3 size={14} /> : <Table2 size={14} />}
              {showTable ? 'Show charts' : 'Show table'}
            </button>
          </>
        }
      />

      {/* Filters sit in one row above the charts and stay mounted while data reloads */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          Period
          <input type="month" className="o-input w-auto"
            value={period}
            onChange={(e) => setMonthRange(e.target.value)} />
        </label>
        {period && (
          <button type="button" className="o-btn-ghost px-2 py-1 text-xs"
            onClick={() => setMonthRange('')}>
            Clear
          </button>
        )}
        <SearchSelect
          className="w-auto min-w-44"
          value={filters.companyId ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, companyId: v || undefined }))}
          searchPlaceholder="Search companies…"
          options={[{ value: '', label: 'All companies' },
            ...(companies ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.currency }))]}
        />
        <SearchSelect
          className="w-auto min-w-44"
          value={filters.departmentId ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, departmentId: v || undefined }))}
          searchPlaceholder="Search departments…"
          options={[{ value: '', label: 'All departments' },
            ...(depts ?? []).map((d) => ({ value: d.id, label: d.name }))]}
        />
        <select className="o-input w-auto"
          value={filters.employeeType ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, employeeType: e.target.value || undefined }))}>
          <option value="">All employee types</option>
          {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => (
            <option key={t} value={t}>{t.replace('_', ' ')}</option>
          ))}
        </select>
        <span className="o-badge bg-odoo-50 text-odoo-700">{periodLabel}</span>
        {loading && <span className="text-xs text-ink-soft">Updating…</span>}
      </div>

      {chips.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-ink-soft">Filtered by</span>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilters((f) => ({ ...f, [c.key]: undefined }))}
              className="o-badge border border-odoo-200 bg-odoo-50 text-odoo-700 hover:bg-odoo-100"
              title="Remove this filter"
            >
              {c.label}
              <X size={11} />
            </button>
          ))}
          <button type="button" className="o-btn-ghost px-2 py-0.5 text-xs" onClick={resetAll}>
            <RotateCcw size={12} />
            Reset all
          </button>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={refetch} />}
      {!data && loading && <Spinner label="Building dashboard" />}
      {data && (
      <>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {kpiTiles.map((t) => (
          <div key={t.label} className="o-card p-3.5">
            <div className="flex items-start justify-between">
              <p className="text-xs text-ink-soft">{t.label}</p>
              <t.icon size={15} className="text-odoo-400" />
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{t.value}</p>
            {t.delta != null ? (
              <p className={`mt-0.5 flex items-center gap-1 text-[11px] font-medium
                ${t.delta >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {t.delta >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {t.delta >= 0 ? '+' : ''}{t.delta}% vs previous period
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-ink-soft">{t.hint}</p>
            )}
          </div>
        ))}
      </div>

      {/* Zero totals with payslips present means "not computed", not "no data" */}
      {k.payslipCount > 0 && k.totalNet === 0 && k.draftCount > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>
            <strong>{k.draftCount} of {k.payslipCount} payslips in this period are still draft.</strong>{' '}
            Salary figures stay at zero until the payrun is computed — the charts below are not
            empty by mistake.
            {data.payrunStatus.filter((p) => p.status === 'DRAFT').map((p) => (
              <Link key={p.id} to={`/payroll/payruns/${p.id}`}
                className="ml-1 font-medium underline hover:no-underline">
                Open {p.name}
              </Link>
            ))}
          </span>
        </div>
      )}

      {/* Payslip status split beside the alerts it usually explains */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {slipSplit.length > 0 && (
          <section className="o-card p-4">
            <h2 className="text-sm font-semibold text-ink">Payslip Status</h2>
            <p className="mb-3 text-xs text-ink-soft">{k.payslipCount} payslips in this period</p>
            <div className="flex h-6 gap-0.5 overflow-hidden rounded">
              {slipSplit.map((s) => (
                <div key={s.key} title={`${s.label}: ${s.value}`}
                  style={{ width: `${(s.value / slipTotal) * 100}%`, background: s.color }}
                  className="first:rounded-l last:rounded-r" />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              {slipSplit.map((s) => (
                <span key={s.key} className="flex items-baseline gap-1.5 text-xs">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                  <span className="font-semibold tabular-nums text-ink">{s.value}</span>
                  <span className="text-ink-soft">{s.label}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {data.alerts.length > 0 && (
          <section className="o-card p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink">Operational Alerts</h2>
            <div className="grid max-h-44 gap-1.5 overflow-y-auto">
              {data.alerts.slice(0, 10).map((a, i) => {
                const s = SEVERITY[a.severity] ?? SEVERITY.INFO;
                return (
                  <div key={`${a.code}-${i}`} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${s.tone}`}>
                    <s.icon size={14} className="mt-0.5 shrink-0" />
                    <span>{a.message}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {showTable ? (
        <div className="o-card overflow-hidden">
          <div className="border-b border-hairline px-3 py-2">
            <h2 className="text-sm font-semibold text-ink">Department breakdown</h2>
          </div>
          <table className="o-table">
            <thead>
              <tr>
                <th>Department</th><th className="text-right">Headcount</th>
                <th className="text-right">Net Salary</th><th className="text-right">Avg / Employee</th>
              </tr>
            </thead>
            <tbody>
              {data.salaryByDepartment.map((d) => (
                <tr key={d.department} className="cursor-pointer"
                  onClick={() => d.departmentId && openDrill(
                    [{ filterKey: 'departmentId', value: d.departmentId, label: d.department, axis: 'Department' }])}>
                  <td className="font-medium text-ink">{d.department}</td>
                  <td className="text-right tabular-nums">{d.headcount}</td>
                  <td className="text-right tabular-nums">{money(d.net)}</td>
                  <td className="text-right tabular-nums text-ink-soft">
                    {money(d.headcount ? d.net / d.headcount : 0)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{k.headcount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(k.totalNet)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="o-card p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-ink">Salary Cost by {axisLabel(salaryAxis)}</h2>
                <p className="text-xs text-ink-soft">Net salary in the selected period · click a bar to drill in</p>
              </div>
              <SearchSelect
                className="w-auto min-w-36"
                value={salaryAxis}
                onChange={setSalaryAxis}
                options={GROUPABLE.map((a) => ({ value: a.value, label: a.label }))}
                searchPlaceholder="Search axes…"
              />
            </div>
            {salaryGroups?.rows?.some((d) => d.net > 0)
              ? (
                <CategoryBarChart
                  data={salaryGroups.rows.filter((d) => d.net > 0)}
                  valueKey="net"
                  onSelect={(row) => openDrill([{
                    filterKey: salaryGroups.filterKey, value: row.key,
                    label: row.label, axis: salaryGroups.dimensionLabel,
                  }], 'salary')}
                />
              )
              : (
                <p className="py-8 text-center text-sm text-ink-soft">
                  {k.draftCount > 0
                    ? 'Payslips for this period are not computed yet'
                    : 'No payroll data in this period'}
                </p>
              )}
          </section>

          <section className="o-card p-4">
            <h2 className="text-sm font-semibold text-ink">Monthly Net Salary Trend</h2>
            <p className="mb-3 text-xs text-ink-soft">
              Total net salary per payroll period · click a month to filter to it
            </p>
            {data.monthlyTrend.some((m) => m.net > 0)
              ? (
                <NetSalaryTrend
                  data={data.monthlyTrend}
                  onSelectMonth={(point) => setMonthRange(point.month)}
                />
              )
              : (
                <p className="py-8 text-center text-sm text-ink-soft">
                  {k.draftCount > 0
                    ? 'Nothing computed in this period yet'
                    : 'No trend data yet'}
                </p>
              )}
          </section>

          <section className="o-card p-4">
            <h2 className="text-sm font-semibold text-ink">Attendance Overview</h2>
            <p className="mb-3 text-xs text-ink-soft">
              {data.attendanceOverview.total} records · click a band to see who
            </p>
            <AttendanceComposition
              overview={data.attendanceOverview}
              onSelect={(part) => setDrill({
                trail: [],
                metric: 'attendance',
                attendanceStatus: part.key,
                statusLabel: part.label,
              })}
            />
            <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-3 text-xs">
              {[
                ['Missing check-outs', data.attendanceOverview.missingCheckout],
                ['Manual edits', data.attendanceOverview.manualEdits],
                ['Overtime hours', data.attendanceOverview.overtimeHours],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-ink-soft">{label}</dt>
                  <dd className="text-base font-semibold tabular-nums text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="o-card p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  Time Off {leaveAxis === 'leaveType' ? 'Overview' : `by ${axisLabel(leaveAxis)}`}
                </h2>
                <p className="text-xs text-ink-soft">
                  {leaveAxis === 'leaveType'
                    ? 'Approved, pending and remaining balance by type'
                    : 'Approved leave days · click a bar to drill in'}
                </p>
              </div>
              <SearchSelect
                className="w-auto min-w-36"
                value={leaveAxis}
                onChange={setLeaveAxis}
                options={[{ value: 'leaveType', label: 'Time Off Type' },
                  ...GROUPABLE.map((a) => ({ value: a.value, label: a.label }))]}
                searchPlaceholder="Search axes…"
              />
            </div>

            {leaveAxis === 'leaveType' ? (
              data.leaveOverview.length ? (
                <div className="overflow-x-auto">
                  <table className="o-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th className="text-right">Approved</th>
                        <th className="text-right">Pending</th>
                        <th className="text-right">Remaining Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.leaveOverview.map((t) => (
                        <tr key={t.timeOffTypeId} className="cursor-pointer"
                          onClick={() => openDrill([{
                            filterKey: 'timeOffTypeId', value: t.timeOffTypeId,
                            label: t.name, axis: 'Time Off Type',
                          }], 'leave')}>
                          <td className="font-medium text-ink">
                            <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                              style={{ background: t.color }} />
                            {t.name}
                          </td>
                          <td className="text-right tabular-nums">{t.days}</td>
                          <td className="text-right tabular-nums text-ink-soft">{t.pending || '—'}</td>
                          <td className="text-right tabular-nums">
                            {t.balance == null
                              ? <span className="text-ink-soft">N/A</span>
                              : `${t.balance} ${t.unit === 'HOURS' ? 'hrs' : 'days'}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-ink-soft">No approved leave in this period</p>
              )
            ) : leaveGroups?.rows?.some((r) => r.leaveDays > 0) ? (
              <CategoryBarChart
                data={leaveGroups.rows.filter((r) => r.leaveDays > 0)}
                valueKey="leaveDays"
                name="Leave days"
                format={(v) => String(v)}
                tooltipFormat={(v) => `${v} days`}
                onSelect={(row) => openDrill([{
                  filterKey: leaveGroups.filterKey, value: row.key,
                  label: row.label, axis: leaveGroups.dimensionLabel,
                }], 'leave')}
              />
            ) : (
              <p className="py-8 text-center text-sm text-ink-soft">No approved leave in this period</p>
            )}
          </section>

          <section className="o-card p-4 lg:col-span-2">
            <h2 className="text-sm font-semibold text-ink">Department Overview</h2>
            <p className="mb-3 text-xs text-ink-soft">
              Headcount and payroll cost per department · click a row to drill in
            </p>
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th className="text-right">Headcount</th>
                    <th className="text-right">Net Salary</th>
                    <th className="text-right">Avg / Employee</th>
                    <th className="text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.salaryByDepartment.map((d) => (
                    <tr key={d.department} className="cursor-pointer"
                      onClick={() => d.departmentId && openDrill(
                        [{ filterKey: 'departmentId', value: d.departmentId, label: d.department, axis: 'Department' }])}>
                      <td className="font-medium text-ink">{d.department}</td>
                      <td className="text-right tabular-nums">{d.headcount}</td>
                      <td className="text-right tabular-nums">{compactMoney(d.net)}</td>
                      <td className="text-right tabular-nums text-ink-soft">
                        {compactMoney(d.headcount ? d.net / d.headcount : 0)}
                      </td>
                      <td className="text-right tabular-nums text-ink-soft">
                        {k.totalNet ? `${((d.net / k.totalNet) * 100).toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {data.payrunStatus.length > 0 && (
        <div className="mt-4 o-card p-3">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Building2 size={14} className="text-odoo-400" />
            Payrun Status
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.payrunStatus.map((p) => (
              <Link key={p.id} to={`/payroll/payruns/${p.id}`}
                className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-xs hover:bg-odoo-50">
                <span className="font-medium text-ink">{p.name}</span>
                <StatusBadge value={p.status} />
              </Link>
            ))}
          </div>
        </div>
      )}
      </>
      )}

      {drill && (
        <DrillDown
          base={{
            ...filters,
            ...(drill.attendanceStatus ? { attendanceStatus: drill.attendanceStatus } : {}),
          }}
          heading={drill.statusLabel}
          baseLabels={chips.map((c) => c.label)}
          trail={drill.trail}
          metric={drill.metric}
          onTrail={(trail) => setDrill((d) => ({ ...d, trail }))}
          onMetric={(metric) => setDrill((d) => ({ ...d, metric }))}
          onApplyFilter={applyTrail}
          onClose={() => setDrill(null)}
        />
      )}
    </>
  );
}
