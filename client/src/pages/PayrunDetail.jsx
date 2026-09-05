import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Calculator, CheckCircle2, BadgeCheck, Send, AlertTriangle, Trash2 } from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isPayrollAdmin } from '../lib/roles';
import { money, date } from '../lib/format';
import { PageHeader, Spinner, ErrorState, StatusBadge } from '../components/ui';

const SEVERITY_TONES = {
  ERROR: 'border-red-200 bg-red-50 text-red-800',
  WARNING: 'border-amber-200 bg-amber-50 text-amber-800',
  INFO: 'border-blue-200 bg-blue-50 text-blue-800',
};

export default function PayrunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { role } = useAuth();
  const toast = useToast();
  const { data: run, loading, error, refetch } = useFetch(`/payroll/payruns/${id}`);
  const [busy, setBusy] = useState(null);

  if (loading) return <Spinner label="Loading payrun" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!run) return null;

  const act = async (kind, label) => {
    setBusy(kind);
    try {
      const { data } = await api.post(`/payroll/payruns/${id}/${kind}`);
      toast.success(`${label} complete`);
      if (kind === 'send') toast.success(`${data.sent ?? 0} payslip email(s) sent`);
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${run.name}" and its payslips?`)) return;
    try {
      await api.delete(`/payroll/payruns/${id}`);
      toast.success('Payrun deleted');
      navigate('/payroll/payruns');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const errors = (run.warnings ?? []).filter((w) => w.severity === 'ERROR');
  const advisories = (run.warnings ?? []).filter((w) => w.severity !== 'ERROR');
  const canCompute = ['DRAFT', 'COMPUTED'].includes(run.status);
  const canValidate = run.status === 'COMPUTED';
  const canPay = run.status === 'VALIDATED';
  const canSend = ['VALIDATED', 'PAID'].includes(run.status);

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/payroll/payruns" className="mb-1 flex items-center gap-1 text-xs text-ink-soft hover:text-odoo-600">
            <ArrowLeft size={12} /> Payruns
          </Link>
        }
        title={run.name}
        subtitle={`${run.structure?.name} · ${date(run.periodStart)} – ${date(run.periodEnd)}`}
        actions={
          <>
            <button type="button" className="o-btn-secondary" disabled={!canCompute || busy}
              onClick={() => act('compute', 'Computation')}>
              <Calculator size={14} /> {busy === 'compute' ? 'Computing…' : 'Compute'}
            </button>
            {isPayrollAdmin(role) && (
              <>
                <button type="button" className="o-btn-secondary" disabled={!canValidate || busy}
                  onClick={() => act('validate', 'Validation')}>
                  <CheckCircle2 size={14} /> Validate
                </button>
                <button type="button" className="o-btn-secondary" disabled={!canPay || busy}
                  onClick={() => act('mark-paid', 'Payment')}>
                  <BadgeCheck size={14} /> Mark Paid
                </button>
                <button type="button" className="o-btn-primary" disabled={!canSend || busy}
                  onClick={() => act('send', 'Sending')}>
                  <Send size={14} /> {busy === 'send' ? 'Sending…' : 'Send Payslips'}
                </button>
                {run.status !== 'PAID' && (
                  <button type="button" className="o-btn-danger px-2" onClick={remove} title="Delete payrun">
                    <Trash2 size={14} />
                  </button>
                )}
              </>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[
          ['Status', <StatusBadge key="s" value={run.status} />],
          ['Payslips', run.payslips?.length ?? 0],
          ['Total Gross', money(run.totals?.gross)],
          ['Total Net', money(run.totals?.net)],
        ].map(([label, value]) => (
          <div key={label} className="o-card p-3">
            <p className="text-xs text-ink-soft">{label}</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">{value}</p>
          </div>
        ))}
      </div>

      {(errors.length > 0 || advisories.length > 0) && (
        <div className="mb-4 space-y-2">
          {errors.length > 0 && (
            <div className={`rounded-lg border p-3 ${SEVERITY_TONES.ERROR}`}>
              <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <AlertTriangle size={15} /> {errors.length} blocking issue{errors.length === 1 ? '' : 's'} — validation is blocked
              </p>
              <ul className="ml-5 list-disc space-y-0.5 text-xs">
                {errors.map((w) => <li key={w.id}>{w.message}</li>)}
              </ul>
            </div>
          )}
          {advisories.length > 0 && (
            <div className={`rounded-lg border p-3 ${SEVERITY_TONES.WARNING}`}>
              <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <AlertTriangle size={15} /> {advisories.length} item{advisories.length === 1 ? '' : 's'} requiring attention
              </p>
              <ul className="ml-5 list-disc space-y-0.5 text-xs">
                {advisories.map((w) => <li key={w.id}>{w.message}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="o-card overflow-hidden">
        <div className="border-b border-hairline px-3 py-2">
          <h2 className="text-sm font-semibold text-ink">Payslips</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="o-table">
            <thead>
              <tr>
                <th>Payslip</th><th>Employee</th>
                <th className="text-right">Worked Days</th><th className="text-right">Basic</th>
                <th className="text-right">Allowances</th><th className="text-right">Gross</th>
                <th className="text-right">Deductions</th><th className="text-right">Net</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(run.payslips ?? []).map((s) => (
                <tr key={s.id} className="cursor-pointer" onClick={() => navigate(`/payroll/payslips/${s.id}`)}>
                  <td className="font-mono text-xs text-ink-soft">{s.number}</td>
                  <td className="font-medium text-ink">{s.employee?.name}</td>
                  <td className="text-right tabular-nums">{s.workedDays}</td>
                  <td className="text-right tabular-nums">{money(s.basic)}</td>
                  <td className="text-right tabular-nums">{money(s.allowance)}</td>
                  <td className="text-right tabular-nums">{money(s.gross)}</td>
                  <td className="text-right tabular-nums text-red-600">{money(s.deduction)}</td>
                  <td className="text-right font-semibold tabular-nums">{money(s.net)}</td>
                  <td><StatusBadge value={s.status} /></td>
                </tr>
              ))}
            </tbody>
            {run.payslips?.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 font-semibold">
                  <td colSpan={5} className="px-3 py-2 text-right text-sm">Totals</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(run.totals?.gross)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600">{money(run.totals?.deduction)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-odoo-600">{money(run.totals?.net)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  );
}
