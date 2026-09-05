import { useState } from 'react';
import { Plus, Check, Wallet, Search, X } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr } from '../lib/roles';
import { date } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field, SearchSelect, PagerBar, PeriodFilter } from '../components/ui';

export default function TimeOffAllocations() {
  const { role } = useAuth();
  const toast = useToast();
  const list = useList('/time-off/allocations');
  const { data: types } = useFetch('/time-off/types');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);

  const approve = async (id, e) => {
    e.stopPropagation();
    try {
      await api.post(`/time-off/allocations/${id}/approve`);
      toast.success('Allocation approved');
      list.refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Allocations"
        subtitle="Leave balances granted to employees; only approved allocations can be consumed"
        actions={
          isHr(role) && (
            <button type="button" className="o-btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New Allocation
            </button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search by employee or type…"
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <select className="o-input w-auto"
          onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {['DRAFT', 'APPROVED', 'REFUSED'].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
        </select>
        <SearchSelect
          className="w-auto min-w-44"
          value={list.params.timeOffTypeId ?? ''}
          onChange={(v) => list.setParam({ timeOffTypeId: v || undefined })}
          options={[{ value: '', label: 'All types' },
            ...(types ?? []).map((t) => ({ value: t.id, label: t.name }))]}
          searchPlaceholder="Search types…"
        />
        <PeriodFilter
          year={list.params.year}
          month={list.params.month}
          onChange={(v) => list.setParam(v)}
        />
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading allocations" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={Wallet} title="No allocations" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Employee</th><th>Type</th>
                    <th className="text-right">This Grant</th>
                    <th className="border-l border-hairline text-right">Total Allocated</th>
                    <th className="text-right">Taken</th>
                    <th className="text-right">Remaining</th>
                    <th className="border-l border-hairline">Valid From</th><th>Valid To</th>
                    <th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((a) => (
                    <tr key={a.id} className="cursor-pointer" onClick={() => setViewing(a)}>
                      <td className="font-medium text-ink">{a.employee?.name}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ background: a.timeOffType?.color }} />
                          {a.timeOffType?.name}
                        </span>
                      </td>
                      <td className="text-right font-medium tabular-nums text-ink">{a.amount}</td>
                      <td className="border-l border-hairline text-right tabular-nums text-ink-soft">
                        {a.balance?.allocated ?? 0}
                      </td>
                      <td className="text-right tabular-nums text-ink-soft">{a.balance?.taken ?? 0}</td>
                      <td className="text-right font-medium tabular-nums text-odoo-600">{a.balance?.remaining ?? 0}</td>
                      <td className="border-l border-hairline">{date(a.validFrom)}</td>
                      <td>{a.validTo ? date(a.validTo) : '—'}</td>
                      <td><StatusBadge value={a.status} /></td>
                      <td className="text-right">
                        {isHr(role) && a.status !== 'APPROVED' && (
                          <button type="button" className="o-btn-secondary px-2 py-1 text-green-700"
                            onClick={(e) => approve(a.id, e)} title="Approve allocation">
                            <Check size={14} />
                          </button>
                        )}
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

      <p className="mt-3 text-xs text-ink-soft">
        <strong className="text-ink">This Grant</strong> is what this row adds.
        <strong className="ml-1 text-ink">Total Allocated</strong>, <strong className="text-ink">Taken</strong>
        and <strong className="text-ink">Remaining</strong> are the employee&apos;s balance across every
        approved allocation of that leave type — two grants of the same type share one balance.
      </p>

      {creating && (
        <AllocationModal types={types ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); list.refetch(); }} />
      )}
      {viewing && (
        <AllocationDetail allocation={viewing}
          onClose={() => setViewing(null)}
          onChanged={() => { setViewing(null); list.refetch(); }} />
      )}
    </>
  );
}

function AllocationModal({ types, onClose, onSaved }) {
  const toast = useToast();
  const { data: employees } = useFetch('/employees', { params: { limit: 1000 } });
  const [form, setForm] = useState({
    employeeId: '', timeOffTypeId: '', amount: '',
    validFrom: `${new Date().getFullYear()}-01-01`,
    validTo: `${new Date().getFullYear()}-12-31`,
    status: 'APPROVED', notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/time-off/allocations', { ...form, notes: form.notes || null });
      toast.success('Allocation created');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="New Allocation" onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="alloc-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Create Allocation'}
          </button>
        </>
      }>
      <form id="alloc-form" onSubmit={submit} className="grid gap-3">
        <Field label="Employee" required>
          <SearchSelect
            required
            value={form.employeeId}
            onChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}
            placeholder="Select employee"
            searchPlaceholder="Search by name or email…"
            options={[{ value: '', label: 'Select employee' },
              ...(employees?.rows ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.workEmail }))]}
          />
        </Field>
        <Field label="Time Off Type" required>
          <SearchSelect
            required
            value={form.timeOffTypeId}
            onChange={(v) => setForm((f) => ({ ...f, timeOffTypeId: v }))}
            placeholder="Select type"
            searchPlaceholder="Search types…"
            options={[{ value: '', label: 'Select type' },
              ...types.map((t) => ({ value: t.id, label: `${t.name} (${t.unit.toLowerCase()})` }))]}
          />
        </Field>
        <Field label="Amount" required>
          <input type="number" step="0.5" min="0.5" className="o-input" value={form.amount} onChange={set('amount')} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Valid From" required>
            <input type="date" className="o-input" value={form.validFrom} onChange={set('validFrom')} required />
          </Field>
          <Field label="Valid To">
            <input type="date" className="o-input" value={form.validTo} onChange={set('validTo')} />
          </Field>
        </div>
        <Field label="Status" hint="Only approved allocations count toward a balance">
          <select className="o-input" value={form.status} onChange={set('status')}>
            <option value="DRAFT">Draft</option>
            <option value="APPROVED">Approved</option>
          </select>
        </Field>
        <Field label="Notes">
          <input className="o-input" value={form.notes} onChange={set('notes')} />
        </Field>
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}

const DetailRow = ({ label, children }) => (
  <div className="flex justify-between border-b border-gray-100 py-2 text-sm">
    <span className="text-ink-soft">{label}</span>
    <span className="font-medium text-ink">{children}</span>
  </div>
);

// The mockup's "Allocation / <employee>" form view: the grant, the balance it
// produces, and what has consumed it.
function AllocationDetail({ allocation, onClose, onChanged }) {
  const { role } = useAuth();
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(`/time-off/allocations/${allocation.id}`);
  const [busy, setBusy] = useState(false);

  const act = async (kind) => {
    setBusy(true);
    try {
      await api.post(`/time-off/allocations/${allocation.id}/${kind}`);
      toast.success(kind === 'approve' ? 'Allocation approved' : 'Allocation refused');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  const a = data ?? allocation;
  const unit = a.timeOffType?.unit === 'HOURS' ? 'hours' : 'days';

  return (
    <Modal
      open
      title={`Allocation / ${a.employee?.name ?? ''}`}
      onClose={onClose}
      footer={
        isHr(role) && a.status !== 'APPROVED' ? (
          <>
            <button type="button" className="o-btn-danger" disabled={busy} onClick={() => act('refuse')}>
              <X size={14} /> Refuse
            </button>
            <button type="button" className="o-btn-primary" disabled={busy} onClick={() => act('approve')}>
              <Check size={14} /> Approve
            </button>
          </>
        ) : (
          <button type="button" className="o-btn-secondary" onClick={onClose}>Close</button>
        )
      }
    >
      {loading ? <Spinner label="Loading allocation" />
        : error ? <ErrorState message={error} onRetry={refetch} />
        : (
          <div>
            <DetailRow label="Employee">{a.employee?.name}</DetailRow>
            <DetailRow label="Time Off Type">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: a.timeOffType?.color }} />
                {a.timeOffType?.name}
              </span>
            </DetailRow>
            <DetailRow label="This Grant">{a.amount} {unit}</DetailRow>
            <DetailRow label="Valid From">{date(a.validFrom)}</DetailRow>
            <DetailRow label="Valid To">{a.validTo ? date(a.validTo) : 'Open-ended'}</DetailRow>
            <DetailRow label="Status"><StatusBadge value={a.status} /></DetailRow>
            {a.notes && <DetailRow label="Notes">{a.notes}</DetailRow>}

            {data?.balance && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  ['Total Allocated', data.balance.allocated],
                  ['Taken', data.balance.taken],
                  ['Remaining', data.balance.remaining],
                ].map(([label, v]) => (
                  <div key={label} className="rounded-md border border-hairline bg-gray-50 px-2.5 py-2 text-center">
                    <p className="text-[11px] text-ink-soft">{label}</p>
                    <p className="text-base font-semibold tabular-nums text-ink">{v}</p>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-2 text-[11px] text-ink-soft">
              These totals cover <strong>every approved {a.timeOffType?.name} allocation</strong> for this
              employee, not just this grant — a second grant raises the total rather than
              creating a separate balance.
            </p>

            {data?.consumedBy?.length > 0 && (
              <div className="mt-3">
                <p className="o-label">Consumed by</p>
                <table className="o-table">
                  <tbody>
                    {data.consumedBy.map((r) => (
                      <tr key={r.id}>
                        <td className="text-ink-soft">{date(r.dateFrom)} – {date(r.dateTo)}</td>
                        <td className="text-right font-medium tabular-nums text-ink">
                          {r.duration} {unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {a.status === 'APPROVED' && (
              <p className="mt-3 rounded border border-hairline bg-gray-50 px-2.5 py-1.5 text-xs text-ink-soft">
                Approved allocations back real leave balances and cannot be refused once
                requests have drawn on them.
              </p>
            )}
          </div>
        )}
    </Modal>
  );
}
