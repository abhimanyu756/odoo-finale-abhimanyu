import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  IndianRupee, Receipt, TrendingUp, CalendarCheck, Activity,
  AlertTriangle, AlertCircle, Info, Table2, BarChart3,
} from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { money } from '../lib/format';
import { PageHeader, Spinner, ErrorState, StatusBadge } from '../components/ui';
import {
  DepartmentCostChart, NetSalaryTrend, AttendanceComposition, LeaveBreakdown,
} from '../components/charts';

const SEVERITY = {
  ERROR: { icon: AlertCircle, tone: 'border-red-200 bg-red-50 text-red-800' },
  WARNING: { icon: AlertTriangle, tone: 'border-amber-200 bg-amber-50 text-amber-800' },
  INFO: { icon: Info, tone: 'border-blue-200 bg-blue-50 text-blue-800' },
};

export default function Dashboard() {
  const [filters, setFilters] = useState({});
  const [showTable, setShowTable] = useState(false);
  const { data, loading, error, refetch } = useFetch('/dashboard', { params: filters });
  const { data: depts } = useFetch('/org/departments');

  if (loading) return <Spinner label="Building dashboard" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return null;

  const k = data.kpis;

  const setMonthRange = (value) => {
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

  const kpiTiles = [
    { label: 'Total Net Salary Paid', value: money(k.totalNet), icon: IndianRupee,
      hint: `${k.paidCount} of ${k.payslipCount} payslips paid` },
    { label: 'Payslips Generated', value: k.payslipCount, icon: Receipt,
      hint: `across ${data.payrunStatus.length} payrun(s)` },
    { label: 'Average Salary', value: money(k.avgSalary), icon: TrendingUp,
      hint: `${k.headcount} active employees` },
    { label: 'Approved Time Off', value: `${k.approvedLeaveDays} days`, icon: CalendarCheck,
      hint: `${k.pendingLeaveRequests} request(s) pending` },
    { label: 'Attendance Health', value: `${k.attendanceHealth}%`, icon: Activity,
      hint: `${k.overtimeHours}h overtime logged` },
  ];

  return (
    <>
      <PageHeader
        title="Payroll Dashboard"
        subtitle="Live metrics aggregated across employees, contracts, attendance, time off and payroll"
        actions={
          <button type="button" className="o-btn-secondary" onClick={() => setShowTable((v) => !v)}>
            {showTable ? <BarChart3 size={14} /> : <Table2 size={14} />}
            {showTable ? 'Show charts' : 'Show table'}
          </button>
        }
      />

      {/* Filters sit in one row above the charts */}
      <div className="mb-4 flex flex-wrap gap-2">
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          Period
          <input type="month" className="o-input w-auto"
            defaultValue=""
            onChange={(e) => setMonthRange(e.target.value)} />
        </label>
        <select className="o-input w-auto"
          onChange={(e) => setFilters((f) => ({ ...f, departmentId: e.target.value || undefined }))}>
          <option value="">All departments</option>
          {(depts ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="o-input w-auto"
          onChange={(e) => setFilters((f) => ({ ...f, employeeType: e.target.value || undefined }))}>
          <option value="">All employee types</option>
          {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => (
            <option key={t} value={t}>{t.replace('_', ' ')}</option>
          ))}
        </select>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {kpiTiles.map((t) => (
          <div key={t.label} className="o-card p-3.5">
            <div className="flex items-start justify-between">
              <p className="text-xs text-ink-soft">{t.label}</p>
              <t.icon size={15} className="text-odoo-400" />
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{t.value}</p>
            <p className="mt-0.5 text-[11px] text-ink-soft">{t.hint}</p>
          </div>
        ))}
      </div>

      {data.alerts.length > 0 && (
        <div className="mb-4 o-card p-3">
          <h2 className="mb-2 text-sm font-semibold text-ink">Operational Alerts</h2>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {data.alerts.slice(0, 8).map((a, i) => {
              const s = SEVERITY[a.severity] ?? SEVERITY.INFO;
              return (
                <div key={`${a.code}-${i}`} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${s.tone}`}>
                  <s.icon size={14} className="mt-0.5 shrink-0" />
                  <span>{a.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
                <tr key={d.department}>
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
            <h2 className="text-sm font-semibold text-ink">Salary Cost by Department</h2>
            <p className="mb-3 text-xs text-ink-soft">Net salary in the selected period</p>
            {data.salaryByDepartment.length
              ? <DepartmentCostChart data={data.salaryByDepartment} />
              : <p className="py-8 text-center text-sm text-ink-soft">No payroll data in this period</p>}
          </section>

          <section className="o-card p-4">
            <h2 className="text-sm font-semibold text-ink">Monthly Net Salary Trend</h2>
            <p className="mb-3 text-xs text-ink-soft">Total net salary per payroll period</p>
            {data.monthlyTrend.length
              ? <NetSalaryTrend data={data.monthlyTrend} />
              : <p className="py-8 text-center text-sm text-ink-soft">No trend data yet</p>}
          </section>

          <section className="o-card p-4">
            <h2 className="text-sm font-semibold text-ink">Attendance Overview</h2>
            <p className="mb-3 text-xs text-ink-soft">
              {data.attendanceOverview.total} records · {data.attendanceOverview.manualEdits} manually edited
            </p>
            <AttendanceComposition overview={data.attendanceOverview} />
          </section>

          <section className="o-card p-4">
            <h2 className="text-sm font-semibold text-ink">Time Off Overview</h2>
            <p className="mb-3 text-xs text-ink-soft">Approved leave days by type</p>
            {data.leaveOverview.length
              ? <LeaveBreakdown data={data.leaveOverview} />
              : <p className="py-8 text-center text-sm text-ink-soft">No approved leave in this period</p>}
          </section>
        </div>
      )}

      {data.payrunStatus.length > 0 && (
        <div className="mt-4 o-card p-3">
          <h2 className="mb-2 text-sm font-semibold text-ink">Payrun Status</h2>
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
  );
}
