import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer, Calculator, BadgeCheck, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useFetch } from '../hooks/useApi';
import { api, errorMessage, getAccessToken } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isPayroll, isPayrollAdmin } from '../lib/roles';
import { money, date, titleCase } from '../lib/format';
import { PageHeader, Spinner, ErrorState, StatusBadge } from '../components/ui';

const Fact = ({ label, children }) => (
  <div>
    <p className="o-label">{label}</p>
    <p className="text-sm font-medium text-ink">{children}</p>
  </div>
);

const CATEGORY_TONES = {
  BASIC: 'text-odoo-700',
  ALLOWANCE: 'text-teal-accent',
  GROSS: 'text-blue-700',
  DEDUCTION: 'text-red-600',
  NET: 'text-green-700',
};

export default function PayslipDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { role } = useAuth();
  const [busy, setBusy] = useState(null);
  const { data: slip, loading, error, refetch } = useFetch(`/payroll/payslips/${id}`);

  const act = async (kind, label) => {
    setBusy(kind);
    try {
      await api.post(`/payroll/payslips/${id}/${kind}`);
      toast.success(`${label} complete`);
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner label="Loading payslip" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!slip) return null;

  // The PDF route needs the bearer token, so fetch it and open a blob URL
  // rather than navigating straight to the endpoint.
  const printPdf = async () => {
    try {
      const res = await fetch(`/api/payroll/payslips/${id}/pdf`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) throw new Error('Could not generate PDF');
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumb={
          <div className="mb-1 flex items-center gap-3 text-xs">
            <Link to="/payroll/payslips" className="flex items-center gap-1 text-ink-soft hover:text-odoo-600">
              <ArrowLeft size={12} /> Payslips
            </Link>
            {slip?.payrun && (
              <Link to={`/payroll/payruns/${slip.payrun.id}`} className="text-ink-soft hover:text-odoo-600">
                · {slip.payrun.name}
              </Link>
            )}
          </div>
        }
        title={`Payslip / ${slip.employee?.name}`}
        subtitle={`${slip.number} · ${date(slip.periodStart)} – ${date(slip.periodEnd)}`}
        actions={
          <>
            {isPayroll(role) && (
              <button type="button" className="o-btn-secondary" disabled={busy}
                onClick={() => act('compute', 'Computation')}>
                <Calculator size={14} /> {busy === 'compute' ? 'Computing…' : 'Compute'}
              </button>
            )}
            {isPayrollAdmin(role) && (
              <>
                <button type="button" className="o-btn-secondary"
                  disabled={busy || slip?.status !== 'COMPUTED'}
                  onClick={() => act('validate', 'Validation')}>
                  <CheckCircle2 size={14} /> {busy === 'validate' ? 'Validating…' : 'Validate'}
                </button>
                <button type="button" className="o-btn-secondary"
                  disabled={busy || slip?.status !== 'VALIDATED'}
                  onClick={() => act('mark-paid', 'Payment')}>
                  <BadgeCheck size={14} /> Mark Paid
                </button>
              </>
            )}
            <button type="button" className="o-btn-primary" onClick={printPdf}>
              <Printer size={14} /> Print Payslip
            </button>
          </>
        }
      />

      {slip.warnings?.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <AlertTriangle size={15} />
            {slip.warnings.length} item{slip.warnings.length === 1 ? '' : 's'} requiring attention
          </p>
          <ul className="ml-5 list-disc space-y-0.5 text-xs text-amber-800">
            {slip.warnings.map((w) => <li key={w.id}>{w.message}</li>)}
          </ul>
        </div>
      )}

      {isPayrollAdmin(role) && slip.status !== 'PAID' && (
        <p className="mb-4 rounded border border-hairline bg-gray-50 px-3 py-2 text-xs text-ink-soft">
          <strong className="text-ink">Next step:</strong>{' '}
          {slip.status === 'DRAFT' && 'Compute this payslip to generate its salary lines.'}
          {slip.status === 'COMPUTED' && 'Validate this payslip, then mark it paid.'}
          {slip.status === 'VALIDATED' && 'Mark this payslip paid once payment has been released.'}
          {' '}The payrun advances automatically once every payslip reaches the same stage.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="o-card p-4 lg:col-span-1">
          <h2 className="mb-3 text-sm font-semibold text-ink">Identification</h2>
          <div className="grid gap-3">
            <Fact label="Employee">{slip.employee?.name}</Fact>
            <Fact label="Department">{slip.employee?.department?.name ?? '—'}</Fact>
            <Fact label="Job Position">{slip.employee?.jobPosition?.name ?? '—'}</Fact>
            <Fact label="Pay Run">{slip.payrun?.name}</Fact>
            <Fact label="Salary Structure">{slip.payrun?.structure?.name}</Fact>
            <Fact label="Contract">
              <span className="font-mono text-xs">{slip.contract?.reference}</span>
              {' · '}{money(slip.contract?.wage)}/mo
            </Fact>
            <Fact label="Worked Days">{slip.workedDays} days · {slip.workedHours} h</Fact>
            <Fact label="Leave Days">{slip.leaveDays}</Fact>
            <Fact label="Bank Account">
              {slip.employee?.bankAccount ?? <span className="text-amber-600">Not provided</span>}
            </Fact>
            <div>
              <p className="o-label">Status</p>
              <StatusBadge value={slip.status} />
            </div>
          </div>
        </div>

        <div className="o-card overflow-hidden lg:col-span-2">
          <div className="border-b border-hairline px-4 py-2.5">
            <h2 className="text-sm font-semibold text-ink">Salary Computation</h2>
            <p className="text-xs text-ink-soft">
              Computed from the contract applicable to this period and the payrun&apos;s salary structure
            </p>
          </div>
          <table className="o-table">
            <thead>
              <tr>
                <th className="w-14 text-right">Seq</th><th>Code</th><th>Description</th>
                <th>Category</th><th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(slip.lines ?? []).map((l) => {
                const isTotal = l.category === 'GROSS' || l.category === 'NET';
                return (
                  <tr key={l.id} className={isTotal ? 'bg-gray-50 font-semibold' : ''}>
                    <td className="text-right tabular-nums text-ink-soft">{l.sequence}</td>
                    <td className="font-mono text-xs text-ink-soft">{l.code}</td>
                    <td className="text-ink">{l.name}</td>
                    <td className={`text-xs ${CATEGORY_TONES[l.category]}`}>{titleCase(l.category)}</td>
                    <td className={`text-right tabular-nums ${l.category === 'DEDUCTION' ? 'text-red-600' : 'text-ink'}`}>
                      {l.category === 'DEDUCTION' && l.amount > 0 ? '−' : ''}{money(l.amount, true)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-hairline px-4 py-3 text-sm sm:grid-cols-4">
            {[
              ['Basic', slip.basic], ['Allowances', slip.allowance],
              ['Gross', slip.gross], ['Deductions', slip.deduction],
            ].map(([label, v]) => (
              <div key={label}>
                <p className="text-xs text-ink-soft">{label}</p>
                <p className="font-medium tabular-nums text-ink">{money(v)}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between bg-odoo-500 px-4 py-3 text-white">
            <span className="text-sm font-semibold">Net Salary Payable</span>
            <span className="text-lg font-bold tabular-nums">{money(slip.net, true)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
