import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Wallet, ArrowRight, Search, AlertTriangle } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { money, date, compactMoney } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field, SearchSelect, PagerBar, PeriodFilter } from '../components/ui';

export default function Payruns() {
  const navigate = useNavigate();
  const list = useList('/payroll/payruns');
  const { data: structures } = useFetch('/salary/structures', { params: { limit: 1000 } });
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
            value={list.params.search ?? ''}
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <PeriodFilter
          year={list.params.year}
          month={list.params.month}
          onChange={(v) => list.setParam(v)}
        />
        <SearchSelect
          className="w-auto min-w-40"
          value={list.params.structureId ?? ''}
          onChange={(v) => list.setParam({ structureId: v || undefined })}
          searchPlaceholder="Search structures…"
          options={[{ value: '', label: 'All structures' },
            ...(structures?.rows ?? []).map((x) => ({ value: x.id, label: x.name, hint: x.code }))]}
        />
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
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
                    <th className="text-right">Net</th><th>Status</th><th>Warnings</th>
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
                      <td>
                        {/* Accumulated across the run's payslips, as in the
                            mockup: the row says whether it needs attention
                            before you open it. */}
                        {p.warningCount > 0
                          ? (
                            <span className={`o-badge ${p.errorCount > 0
                              ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700'}`}>
                              <AlertTriangle size={11} />
                              {p.errorCount > 0
                                ? `${p.errorCount} blocking`
                                : `${p.warningCount} warning${p.warningCount === 1 ? '' : 's'}`}
                            </span>
                          )
                          : <span className="text-xs text-ink-soft">No warnings</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pagination page={list.page} pages={list.pages} total={list.total}
            limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
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

  // toISOString() converts local midnight to UTC, which rolls the date back a
  // day in any timezone ahead of UTC. Format from local parts instead.
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const monthBounds = (year, monthIndex) => ({
    periodStart: iso(new Date(year, monthIndex, 1)),
    periodEnd: iso(new Date(year, monthIndex + 1, 0)),
  });

  const monthKey = (year, monthIndex) => `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  const monthLabel = (year, monthIndex) =>
    new Date(year, monthIndex, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  const [step, setStep] = useState(1);
  const [period, setPeriod] = useState(monthKey(today.getFullYear(), today.getMonth()));
  const [customPeriod, setCustomPeriod] = useState(false);
  const [scope, setScope] = useState({
    name: `Payrun / ${monthLabel(today.getFullYear(), today.getMonth())}`,
    structureId: '',
    ...monthBounds(today.getFullYear(), today.getMonth()),
    departmentId: '', employeeType: '',
  });

  // Picking a month fills both bounds and renames the run to match, so the
  // common case needs one control rather than two date fields.
  const applyMonth = (key) => {
    setPeriod(key);
    if (!key) return;
    const [y, m] = key.split('-').map(Number);
    setScope((sc) => ({
      ...sc,
      ...monthBounds(y, m - 1),
      name: `Payrun / ${monthLabel(y, m - 1)}`,
    }));
  };

  // Twelve months back and three forward covers any realistic run.
  const monthOptions = Array.from({ length: 16 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() + 3 - i, 1);
    return { key: monthKey(d.getFullYear(), d.getMonth()), label: monthLabel(d.getFullYear(), d.getMonth()) };
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
            <SearchSelect
              required
              value={scope.structureId}
              onChange={(v) => setScope((s) => ({ ...s, structureId: v }))}
              placeholder="Select structure"
              searchPlaceholder="Search structures…"
              options={[{ value: '', label: 'Select structure' },
                ...(structures?.rows ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.code }))]}
            />
          </Field>
          <Field label="Department" hint="Optional filter">
            <SearchSelect
              value={scope.departmentId}
              onChange={(v) => setScope((s) => ({ ...s, departmentId: v }))}
              placeholder="All departments"
              searchPlaceholder="Search departments…"
              options={[{ value: '', label: 'All departments' },
                ...(depts ?? []).map((d) => ({ value: d.id, label: d.name }))]}
            />
          </Field>
          <Field label="Period" required hint="Sets the first and last day of the month">
            <select className="o-input" value={customPeriod ? '' : period}
              onChange={(e) => {
                if (e.target.value === 'CUSTOM') { setCustomPeriod(true); return; }
                setCustomPeriod(false);
                applyMonth(e.target.value);
              }}>
              {monthOptions.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              <option value="CUSTOM">Custom date range…</option>
            </select>
          </Field>
          <div className="flex items-end">
            <p className="rounded-md border border-hairline bg-gray-50 px-2.5 py-1.5 text-xs text-ink-soft">
              {scope.periodStart} → {scope.periodEnd}
            </p>
          </div>

          {customPeriod && (
            <>
              <Field label="Period Start" required>
                <input type="date" className="o-input" value={scope.periodStart} onChange={set('periodStart')} required />
              </Field>
              <Field label="Period End" required>
                <input type="date" className="o-input" value={scope.periodEnd} onChange={set('periodEnd')} required />
              </Field>
            </>
          )}
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
                  <th className="w-10" /><th>Employee</th><th>Work Email</th>
                  <th>Job Position</th><th>Working Hours</th>
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
                    {/* The mockup identifies a person by name + work email: two
                        employees can share a name, an address is unique. */}
                    <td className="text-ink-soft">{c.workEmail ?? '—'}</td>
                    <td className="text-ink-soft">{c.jobPosition?.name ?? '—'}</td>
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
