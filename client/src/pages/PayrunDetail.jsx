import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Calculator, CheckCircle2, BadgeCheck, Send, AlertTriangle, Trash2, Search,
  Pencil, Printer, Plus,
} from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { api, errorMessage, getAccessToken } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isPayrollAdmin } from '../lib/roles';
import { money, date } from '../lib/format';
import {
  PageHeader, Spinner, ErrorState, StatusBadge, Modal, Field, SearchSelect,
} from '../components/ui';

const SEVERITY_TONES = {
  ERROR: 'border-red-200 bg-red-50 text-red-800',
  WARNING: 'border-amber-200 bg-amber-50 text-amber-800',
  INFO: 'border-blue-200 bg-blue-50 text-blue-800',
};

export default function PayrunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [slipSearch, setSlipSearch] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const { role } = useAuth();
  const toast = useToast();
  const { data: run, loading, error, refetch } = useFetch(`/payroll/payruns/${id}`);
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  if (loading) return <Spinner label="Loading payrun" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!run) return null;

  // Advisory warnings do not block a payrun - a single missing bank account
  // must not halt payroll for everyone else - but proceeding past one should be
  // a decision the user makes on purpose, not something that happens silently.
  const confirmDespiteWarnings = (kind) => {
    const open = (run.warnings ?? []).filter((w) => w.severity !== 'ERROR');
    if (!open.length) return true;

    const countOf = (code) => open.filter((w) => w.code === code).length;
    const noBank = countOf('MISSING_BANK');
    const noEmail = countOf('MISSING_EMAIL');

    if (kind === 'mark-paid' && noBank) {
      return confirm(
        `${noBank} employee(s) have no bank account on file and cannot actually be paid.\n\n`
        + 'Mark this payrun paid anyway?',
      );
    }
    if (kind === 'send' && noEmail) {
      return confirm(
        `${noEmail} employee(s) have no work email; their payslip cannot be delivered.\n\n`
        + 'Send to the rest anyway?',
      );
    }
    if (kind === 'validate') {
      return confirm(
        `${open.length} item(s) still need attention:\n\n`
        + `${open.slice(0, 5).map((w) => `• ${w.message}`).join('\n')}`
        + `${open.length > 5 ? `\n• …and ${open.length - 5} more` : ''}`
        + '\n\nNone of these are blocking. Validate anyway?',
      );
    }
    return true;
  };

  const act = async (kind, label) => {
    if (!confirmDespiteWarnings(kind)) return;
    setBusy(kind);
    try {
      const { data } = await api.post(`/payroll/payruns/${id}/${kind}`);
      if (kind === 'send') {
        // Say plainly when SMTP is unconfigured rather than reporting a
        // delivery count for mail that never left the server.
        if (data.dryRun) {
          toast.error(
            `${data.prepared} payslip PDF(s) prepared but NOT sent — SMTP credentials are not configured`,
          );
        } else {
          toast.success(`${data.sent} payslip email(s) sent`);
        }
        if (data.skipped?.length) toast.error(`${data.skipped.length} skipped (no work email)`);
        if (data.failed?.length) toast.error(`${data.failed.length} failed to send`);
      } else {
        toast.success(`${label} complete`);
      }
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Removing one payslip is the fix for a roster mistake - a duplicate that
  // blocks validation, or someone who should not have been in the run - so the
  // whole payrun does not have to be rebuilt.
  const removeSlip = async (slip) => {
    const name = slip.employee?.name ?? slip.number;
    if (!confirm(`Remove ${name}'s payslip from this payrun?`)) return;
    setBusy(slip.id);
    try {
      const { data } = await api.delete(`/payroll/payslips/${slip.id}`);
      toast.success(`${data.removed}'s payslip removed`);
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // The PDF route needs the bearer token, so fetch it and open a blob URL
  // rather than navigating straight to the endpoint. Same approach the payslip
  // page uses for its Print button.
  const downloadPdf = async (slip) => {
    try {
      const res = await fetch(`/api/payroll/payslips/${slip.id}/pdf`, {
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

  const addEmployees = async (employeeIds) => {
    setBusy('add');
    try {
      const { data } = await api.post(`/payroll/payruns/${id}/payslips`, { employeeIds });
      toast.success(`${data.added} payslip(s) added`);
      if (data.skipped?.length) {
        toast.error(`${data.skipped.length} skipped — ${data.skipped[0].reason}`);
      }
      setAdding(false);
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async (form) => {
    setBusy('edit');
    try {
      const { data } = await api.patch(`/payroll/payruns/${id}`, form);
      toast.success('Payrun updated');
      if (data.needsRecompute) {
        toast.error('Period or structure changed — recompute to refresh the payslip figures');
      }
      setEditing(false);
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

  const slips = run.payslips ?? [];
  const flaggedCount = slips.filter((s) => s.warningLabel).length;
  const term = slipSearch.trim().toLowerCase();
  const visibleSlips = slips.filter((s) => {
    if (onlyFlagged && !s.warningLabel) return false;
    if (!term) return true;
    return `${s.employee?.name ?? ''} ${s.number}`.toLowerCase().includes(term);
  });
  // Totals always describe the whole run, never the filtered view, so a filter
  // can never make the payrun look like it pays less than it does.
  const filtered = visibleSlips.length !== slips.length;

  const canEditRoster = isPayrollAdmin(role) && ['DRAFT', 'COMPUTED'].includes(run.status);

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
                <button type="button" className="o-btn-secondary px-2" onClick={() => setEditing(true)}
                  title="Edit payrun">
                  <Pencil size={14} />
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

      <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          ['Status', <StatusBadge key="s" value={run.status} />],
          ['Payslips', run.payslips?.length ?? 0],
          ['Total Gross', money(run.totals?.gross)],
          ['Total Deductions', money(run.totals?.deduction), 'text-red-600'],
          ['Total Net', money(run.totals?.net)],
        ].map(([label, value, tone]) => (
          <div key={label} className="o-card p-3">
            <p className="text-xs text-ink-soft">{label}</p>
            <p className={`mt-0.5 text-lg font-semibold ${tone ?? 'text-ink'}`}>{value}</p>
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
                {errors.slice(0, 6).map((w) => <li key={w.id}>{w.message}</li>)}
              </ul>
              {errors.length > 6 && (
                <p className="mt-1 text-xs font-medium">
                  +{errors.length - 6} more — see the Warning column on each payslip below
                </p>
              )}
            </div>
          )}
          {advisories.length > 0 && (
            <div className={`rounded-lg border p-3 ${SEVERITY_TONES.WARNING}`}>
              <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <AlertTriangle size={15} />
                {advisories.length} item{advisories.length === 1 ? '' : 's'} requiring attention
                {/* Say which tier this is: the blocking banner above says it
                    blocks, so silence here reads as "probably blocks too". */}
                <span className="font-normal opacity-80">— advisory, does not block validation</span>
              </p>
              <ul className="ml-5 list-disc space-y-0.5 text-xs">
                {advisories.slice(0, 6).map((w) => <li key={w.id}>{w.message}</li>)}
              </ul>
              {advisories.length > 6 && (
                <p className="mt-1 text-xs font-medium">
                  +{advisories.length - 6} more — see the Warning column on each payslip below
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="o-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
          <h2 className="text-sm font-semibold text-ink">Payslips</h2>
          <span className="text-xs text-ink-soft">
            {filtered ? `${visibleSlips.length} of ${slips.length}` : slips.length}
          </span>

          <div className="relative ml-auto w-full sm:w-56">
            <Search size={13} className="absolute left-2.5 top-2 text-gray-400" />
            <input
              className="o-input py-1 pl-7 text-xs"
              placeholder="Find an employee or slip no…"
              value={slipSearch}
              onChange={(e) => setSlipSearch(e.target.value)}
            />
          </div>

          {/* The reason to scan a long payrun is usually to find the problems,
              so make that one click rather than a scroll. */}
          <button
            type="button"
            disabled={!flaggedCount}
            onClick={() => setOnlyFlagged((v) => !v)}
            className={`o-badge border px-2 py-1 text-xs transition-colors disabled:opacity-50
              ${onlyFlagged
                ? 'border-amber-300 bg-amber-100 text-amber-800'
                : 'border-hairline bg-white text-ink-soft hover:bg-amber-50'}`}
            title={flaggedCount ? 'Show only payslips with a warning' : 'Nothing needs attention'}
          >
            <AlertTriangle size={11} />
            Needs attention ({flaggedCount})
          </button>

          {(filtered || slipSearch) && (
            <button type="button" className="o-btn-ghost px-2 py-1 text-xs"
              onClick={() => { setSlipSearch(''); setOnlyFlagged(false); }}>
              Clear
            </button>
          )}
          {canEditRoster && (
            <button type="button" className="o-btn-secondary px-2 py-1 text-xs"
              onClick={() => setAdding(true)} disabled={busy === 'add'}>
              <Plus size={13} />
              Add employees
            </button>
          )}
        </div>
        <div className="max-h-[70vh] overflow-auto">
          <table className="o-table">
            {/* Sticky header: at row 60 the columns are otherwise off screen.
                sticky goes on the cells - it does not inherit from <thead>. */}
            <thead className="[&>tr>th]:sticky [&>tr>th]:top-0 [&>tr>th]:z-10">
              <tr>
                <th>Payslip</th><th>Employee</th><th>Warning</th>
                <th className="text-right">Worked Days</th><th className="text-right">Basic</th>
                <th className="text-right">Allowances</th><th className="text-right">Gross</th>
                <th className="text-right">Deductions</th><th className="text-right">Net</th><th>Status</th>
                <th className="w-10" aria-label="Download" />
                {canEditRoster && <th className="w-10" aria-label="Row actions" />}
              </tr>
            </thead>
            <tbody>
              {visibleSlips.map((s) => (
                <tr key={s.id} className="cursor-pointer" onClick={() => navigate(`/payroll/payslips/${s.id}`)}>
                  <td className="font-mono text-xs text-ink-soft">{s.number}</td>
                  <td className="font-medium text-ink">{s.employee?.name}</td>
                  <td>
                    {s.warningLabel
                      ? (
                        <span
                          title={(s.warnings ?? []).map((w) => w.message).join('\n')}
                          className={`o-badge ${s.warningSeverity === 'ERROR'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700'}`}
                        >
                          <AlertTriangle size={11} />
                          {s.warningLabel}
                          {s.warnings?.length > 1 && ` +${s.warnings.length - 1}`}
                        </span>
                      )
                      : <span className="text-ink-soft">—</span>}
                  </td>
                  <td className="text-right tabular-nums">{s.workedDays}</td>
                  <td className="text-right tabular-nums">{money(s.basic)}</td>
                  <td className="text-right tabular-nums">{money(s.allowance)}</td>
                  <td className="text-right tabular-nums">{money(s.gross)}</td>
                  <td className="text-right tabular-nums text-red-600">{money(s.deduction)}</td>
                  <td className="text-right font-semibold tabular-nums">{money(s.net)}</td>
                  <td><StatusBadge value={s.status} /></td>
                  <td>
                    {/* Per-row PDF, as in the mockup. Draft payslips have no
                        computed lines yet, so there is nothing to print. */}
                    <button
                      type="button"
                      className="o-btn-ghost px-1.5 py-1 disabled:opacity-40"
                      disabled={s.status === 'DRAFT'}
                      title={s.status === 'DRAFT'
                        ? 'Compute the payrun before printing'
                        : `Download ${s.employee?.name ?? 'this'} payslip PDF`}
                      aria-label={`Download payslip PDF for ${s.employee?.name ?? s.number}`}
                      onClick={(e) => { e.stopPropagation(); downloadPdf(s); }}
                    >
                      <Printer size={14} />
                    </button>
                  </td>
                  {canEditRoster && (
                    <td>
                      <button
                        type="button"
                        className="o-btn-ghost px-1.5 py-1 text-red-600 hover:bg-red-50"
                        disabled={busy === s.id}
                        title={`Remove ${s.employee?.name ?? 'this'} payslip from this payrun`}
                        aria-label={`Remove ${s.employee?.name ?? 'this'} payslip`}
                        onClick={(e) => { e.stopPropagation(); removeSlip(s); }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {slips.length > 0 && !filtered && (
              <tfoot>
                <tr className="bg-gray-50 font-semibold">
                  <td colSpan={6} className="px-3 py-2 text-right text-sm">Totals</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(run.totals?.gross)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600">{money(run.totals?.deduction)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-odoo-600">{money(run.totals?.net)}</td>
                  <td />
                  <td />
                  {canEditRoster && <td />}
                </tr>
              </tfoot>
            )}
          </table>

          {visibleSlips.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-ink-soft">
              No payslip matches this filter.
            </p>
          )}
        </div>
      </div>

      {adding && (
        <AddEmployeesModal
          run={run}
          busy={busy === 'add'}
          onAdd={addEmployees}
          onClose={() => setAdding(false)}
        />
      )}

      {editing && (
        <PayrunEditModal
          run={run}
          busy={busy === 'edit'}
          onSave={saveEdit}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

const toDateInput = (v) => new Date(v).toISOString().slice(0, 10);

// Renaming is always allowed. The period and structure define what the payslips
// were computed from, so they are locked once the run leaves DRAFT - the server
// enforces the same rule, this just explains it before you try.
function PayrunEditModal({ run, busy, onSave, onClose }) {
  const { data: structures } = useFetch('/salary/structures', { params: { limit: 1000 } });
  const locked = run.status !== 'DRAFT';
  const [form, setForm] = useState({
    name: run.name,
    structureId: run.structureId,
    periodStart: toDateInput(run.periodStart),
    periodEnd: toDateInput(run.periodEnd),
  });

  const submit = (e) => {
    e.preventDefault();
    if (locked) { onSave({ name: form.name }); return; }
    onSave({
      name: form.name,
      structureId: form.structureId,
      periodStart: new Date(`${form.periodStart}T00:00:00.000Z`).toISOString(),
      periodEnd: new Date(`${form.periodEnd}T23:59:59.999Z`).toISOString(),
    });
  };

  return (
    <Modal open title="Edit Payrun" onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="payrun-edit" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }>
      <form id="payrun-edit" onSubmit={submit} className="grid gap-3">
        <Field label="Name" required>
          <input className="o-input" value={form.name} required
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>

        {locked && (
          <p className="rounded border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-800">
            This payrun is {run.status.toLowerCase()}, so its period and salary structure are
            fixed — they define what the payslips were computed from. Only the name can change.
          </p>
        )}

        <Field label="Salary Structure" required>
          <SearchSelect
            required
            disabled={locked}
            value={form.structureId}
            onChange={(v) => setForm((f) => ({ ...f, structureId: v }))}
            placeholder="Select structure"
            searchPlaceholder="Search structures…"
            options={(structures?.rows ?? []).map((x) => ({ value: x.id, label: x.name, hint: x.code }))}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Period Start" required>
            <input type="date" className="o-input" value={form.periodStart} required disabled={locked}
              onChange={(e) => setForm((f) => ({ ...f, periodStart: e.target.value }))} />
          </Field>
          <Field label="Period End" required>
            <input type="date" className="o-input" value={form.periodEnd} required disabled={locked}
              onChange={(e) => setForm((f) => ({ ...f, periodEnd: e.target.value }))} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// Employees who could join this run: eligible for the period, and not already
// on it. The eligibility endpoint already explains why someone cannot be paid,
// so those rows are shown greyed with the reason rather than hidden.
function AddEmployeesModal({ run, busy, onAdd, onClose }) {
  const [picked, setPicked] = useState([]);
  const [search, setSearch] = useState('');
  const { data, loading } = useFetch('/payroll/payruns/eligible', {
    params: { periodStart: run.periodStart, periodEnd: run.periodEnd },
  });

  const already = new Set((run.payslips ?? []).map((s) => s.employee?.id));
  const term = search.trim().toLowerCase();
  const rows = (data ?? [])
    .filter((e) => !already.has(e.id))
    .filter((e) => !term || `${e.name} ${e.workEmail}`.toLowerCase().includes(term));

  const toggle = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Modal open wide title={`Add employees to ${run.name}`} onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="o-btn-primary" disabled={!picked.length || busy}
            onClick={() => onAdd(picked)}>
            {busy ? 'Adding…' : `Add ${picked.length || ''} payslip${picked.length === 1 ? '' : 's'}`}
          </button>
        </>
      }>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-2 text-gray-400" />
          <input className="o-input py-1 pl-7 text-xs" placeholder="Search by name or email…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <span className="text-xs text-ink-soft">{rows.length} available</span>
      </div>

      {loading && <Spinner label="Loading employees" />}
      {!loading && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-ink-soft">
          Everyone eligible for this period is already in this payrun.
        </p>
      )}

      {rows.length > 0 && (
        <div className="max-h-80 overflow-y-auto rounded border border-hairline">
          <table className="o-table">
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.eligible ? 'cursor-pointer' : 'opacity-50'}
                  onClick={() => e.eligible && toggle(e.id)}>
                  <td className="w-8">
                    <input type="checkbox" checked={picked.includes(e.id)} disabled={!e.eligible}
                      onChange={() => toggle(e.id)} onClick={(ev) => ev.stopPropagation()} />
                  </td>
                  <td className="font-medium text-ink">{e.name}</td>
                  <td className="text-ink-soft">{e.workEmail ?? '—'}</td>
                  <td className="text-ink-soft">{e.department?.name ?? '—'}</td>
                  <td className="text-ink-soft">{e.jobPosition?.name ?? '—'}</td>
                  <td className="text-right tabular-nums">
                    {e.contract ? money(e.contract.wage) : <span className="text-amber-600">{e.reason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
