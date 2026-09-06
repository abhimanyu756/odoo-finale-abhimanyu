import { useSearchParams, useNavigate } from 'react-router-dom';
import { Receipt, Search, AlertTriangle } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { useAuth } from '../context/AuthContext';
import { isPayroll } from '../lib/roles';
import { money, date } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, SearchSelect, PagerBar, PeriodFilter, ExportButton } from '../components/ui';

export default function Payslips() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { role } = useAuth();
  const list = useList('/payroll/payslips', { payrunId: sp.get('payrunId') ?? undefined });
  const { data: employees } = useFetch('/employees', { params: { limit: 1000 }, skip: !isPayroll(role) });

  return (
    <>
      <PageHeader
        title={isPayroll(role) ? 'Payslips' : 'My Payslips'}
        subtitle="Individual salary computations by period"
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search payslip number…"
            value={list.params.search ?? ''}
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        {isPayroll(role) && (
          <SearchSelect
            className="w-auto min-w-52"
            value={list.params.employeeId ?? ''}
            onChange={(v) => list.setParam({ employeeId: v || undefined })}
            searchPlaceholder="Search by name or email…"
            options={[{ value: '', label: 'All employees' },
              ...(employees?.rows ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.workEmail }))]}
          />
        )}
        <select className="o-input w-auto" value={list.params.status ?? ''}
          onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {['DRAFT', 'COMPUTED', 'VALIDATED', 'PAID'].map((s) => (
            <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>
          ))}
        </select>
        <PeriodFilter
          year={list.params.year}
          month={list.params.month}
          onChange={(v) => list.setParam(v)}
        />
        <ExportButton path={'/payroll/payslips/export'} params={list.params} name="payslips" />
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading payslips" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={Receipt} title="No payslips" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Payslip</th><th>Employee</th><th>Warning</th><th>Period</th>
                    <th className="text-right">Basic</th><th className="text-right">Gross</th>
                    <th className="text-right">Net</th><th>Structure</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((s) => (
                    <tr key={s.id} className="cursor-pointer" onClick={() => navigate(`/payroll/payslips/${s.id}`)}>
                      <td className="font-mono text-xs text-ink-soft">{s.number}</td>
                      <td className="font-medium text-ink">{s.employee?.name}</td>
                      <td>
                        {s.warningLabel
                          ? (
                            <span className={`o-badge ${
                              s.warningSeverity === 'ERROR'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-amber-100 text-amber-700'}`}>
                              <AlertTriangle size={11} /> {s.warningLabel}
                            </span>
                          )
                          : <span className="text-ink-soft">—</span>}
                      </td>
                      <td className="text-xs">{date(s.periodStart)} – {date(s.periodEnd)}</td>
                      <td className="text-right tabular-nums">{money(s.basic)}</td>
                      <td className="text-right tabular-nums">{money(s.gross)}</td>
                      <td className="text-right font-semibold tabular-nums">{money(s.net)}</td>
                      <td className="text-ink-soft">{s.payrun?.structure?.name ?? '—'}</td>
                      <td><StatusBadge value={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pagination page={list.page} pages={list.pages} total={list.total}
            limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>
    </>
  );
}
