import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Wallet, ArrowRight, Search } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { money, date, compactMoney } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field } from '../components/ui';

export default function Payruns() {
  const navigate = useNavigate();
  const list = useList('/payroll/payruns');
  const [wizard, setWizard] = useState(false);

  return (
    <>
      <PageHeader
        title="Payruns"
        subtitle="Payroll batches grouped by period"
        actions={
          <button type="button" className="o-btn-primary" onClick={() => setWizard(true)}>
            <Plus size={15} /> New
          </button>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search payruns…"
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading payruns" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={Wallet} title="No payruns yet" hint="Create a payrun to generate payslips." />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Payrun</th><th>Structure</th><th>Period</th>
                    <th className="text-right">Payslips</th><th className="text-right">Gross</th>
                    <th className="text-right">Net</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((p) => (
                    <tr key={p.id} className="cursor-pointer" onClick={() => navigate(`/payroll/payruns/${p.id}`)}>
                      <td className="font-medium text-ink">{p.name}</td>
                      <td className="text-ink-soft">{p.structure?.name}</td>
                      <td>{date(p.periodStart)} – {date(p.periodEnd)}</td>
                      <td className="text-right tabular-nums">{p.payslipCount}</td>
                      <td className="text-right tabular-nums">{money(p.totals?.gross)}</td>
                      <td className="text-right font-medium tabular-nums">{money(p.totals?.net)}</td>
                      <td><StatusBadge value={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={(p) => list.setParam({ page: p })} />
      </div>

      {wizard && <PayrunWizard onClose={() => setWizard(false)} onCreated={(id) => navigate(`/payroll/payruns/${id}`)} />}
    </>
  );
}

// Two-step wizard: step 1 collects scope only — nothing is persisted until the
// user picks employees in step 2 and confirms.
function PayrunWizard({ onClose, onCreated }) {
  const toast = useToast();
  const { data: structures } = useFetch('/salary/structures', { params: { limit: 100 } });
  const { data: depts } = useFetch('/org/departments');

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const iso = (d) => d.toISOString().slice(0, 10);

  const [step, setStep] = useState(1);
  const [scope, setScope] = useState({
    name: `Payrun / ${today.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}`,
    structureId: '', periodStart: iso(firstOfMonth), periodEnd: iso(lastOfMonth),
    departmentId: '', employeeType: '',
  });
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setScope((s) => ({ ...s, [k]: e.target.value }));

  const goStep2 = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.get('/payroll/payruns/eligible', {
        params: {
          periodStart: scope.periodStart, periodEnd: scope.periodEnd,
          departmentId: scope.departmentId || undefined,
          employeeType: scope.employeeType || undefined,
        },
      });
      setCandidates(data);
      setSelected(new Set(data.filter((c) => c.eligible).map((c) => c.id)));
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/payroll/payruns', {
        name: scope.name, structureId: scope.structureId,
        periodStart: scope.periodStart, periodEnd: scope.periodEnd,
        employeeIds: [...selected],
      });
      toast.success(`Payrun created with ${data.payslips.length} payslip(s)`);
      onCreated(data.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const eligible = candidates.filter((c) => c.eligible);
  // Filtering is client-side: the whole candidate set is already loaded, so
  // searching must not drop selections made before the filter was typed.
  const term = employeeSearch.trim().toLowerCase();
  const visible = term
    ? candidates.filter((c) =>
        c.name.toLowerCase().includes(term)
        || (c.department?.name ?? '').toLowerCase().includes(term)
        || (c.contract?.reference ?? '').toLowerCase().includes(term))
    : candidates;
  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal open wide
      title={step === 1 ? 'New Pay Run — Step 1: Scope' : 'New Pay Run — Step 2: Select Employees'}
      onClose={onClose}
      footer={
        step === 1 ? (
          <>
            <button type="button" className="o-btn-secondary" onClick={onClose}>Discard</button>
            <button type="submit" form="scope-form" className="o-btn-primary" disabled={busy}>
              {busy ? 'Loading…' : <>Continue <ArrowRight size={14} /></>}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="o-btn-secondary mr-auto" onClick={() => setStep(1)}>Back</button>
            <button type="button" className="o-btn-secondary" onClick={onClose}>Discard</button>
            <button type="button" className="o-btn-primary" disabled={busy || !selected.size} onClick={create}>
              {busy ? 'Creating…' : `Create Payrun (${selected.size})`}
            </button>
          </>
        )
      }>
      {step === 1 ? (
        <form id="scope-form" onSubmit={goStep2} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Payrun Name" required>
              <input className="o-input" value={scope.name} onChange={set('name')} required />
            </Field>
          </div>
          <Field label="Salary Structure" required>
            <select className="o-input" value={scope.structureId} onChange={set('structureId')} required>
              <option value="">Select structure</option>
              {(structures?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Department" hint="Optional filter">
            <select className="o-input" value={scope.departmentId} onChange={set('departmentId')}>
              <option value="">All departments</option>
              {(depts ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Period Start" required>
            <input type="date" className="o-input" value={scope.periodStart} onChange={set('periodStart')} required />
          </Field>
          <Field label="Period End" required>
            <input type="date" className="o-input" value={scope.periodEnd} onChange={set('periodEnd')} required />
          </Field>
          <div className="sm:col-span-2">
            <p className="rounded border border-hairline bg-gray-50 px-2.5 py-1.5 text-xs text-ink-soft">
              Continuing only previews eligible employees — the payrun is created after you select them.
            </p>
          </div>
          {error && <p className="sm:col-span-2 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
        </form>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 sm:max-w-xs">
              <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
              <input className="o-input pl-8" placeholder="Search employees…"
                value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} />
            </div>
            <span className="text-xs tabular-nums text-ink-soft">
              {visible.length ? `1-${visible.length} / ${candidates.length}` : `0 / ${candidates.length}`}
            </span>
            <div className="ml-auto flex gap-2">
              <button type="button" className="o-btn-ghost px-2 py-1"
                onClick={() => setSelected((s2) => {
                  const next = new Set(s2);
                  visible.filter((c) => c.eligible).forEach((c) => next.add(c.id));
                  return next;
                })}>
                Select {term ? 'shown' : 'all'}
              </button>
              <button type="button" className="o-btn-ghost px-2 py-1"
                onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          </div>
          <p className="mb-2 text-xs text-ink-soft">
            {eligible.length} eligible of {candidates.length} employees ·{' '}
            <strong className="text-ink">{selected.size} selected</strong>
          </p>
          <div className="max-h-96 overflow-y-auto rounded-md border border-hairline">
            <table className="o-table">
              <thead>
                <tr>
                  <th className="w-10" /><th>Employee</th><th>Working Hours</th>
                  <th>Start Date</th><th>Contract</th><th className="text-right">Wage</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id} className={c.eligible ? 'cursor-pointer' : 'opacity-60'}
                    onClick={() => c.eligible && toggle(c.id)}>
                    <td>
                      <input type="checkbox" disabled={!c.eligible} checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} />
                    </td>
                    <td className="font-medium text-ink">
                      {c.name}
                      {c.department && (
                        <span className="ml-1.5 text-xs font-normal text-ink-soft">{c.department.name}</span>
                      )}
                    </td>
                    <td className="text-ink-soft">
                      {c.workingHours != null ? `${c.workingHours} hours/week` : '—'}
                    </td>
                    <td className="text-ink-soft">{c.contract ? date(c.contract.startDate) : '—'}</td>
                    <td className="text-xs">
                      {c.contract
                        ? <span className="font-mono">{c.contract.reference}</span>
                        : <span className="text-amber-600">{c.reason}</span>}
                    </td>
                    <td className="text-right tabular-nums">{c.contract ? money(c.contract.wage) : '—'}</td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-sm text-ink-soft">
                    No employees match “{employeeSearch}”.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            Estimated payroll base:{' '}
            <strong className="text-ink">
              {compactMoney(candidates.filter((c) => selected.has(c.id)).reduce((s, c) => s + (c.contract?.wage ?? 0), 0))}
            </strong>
          </p>
          {error && <p className="mt-2 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
        </>
      )}
    </Modal>
  );
}
