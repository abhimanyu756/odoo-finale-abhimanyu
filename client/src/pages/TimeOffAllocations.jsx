import { useState } from 'react';
import { Plus, Check, Wallet } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr } from '../lib/roles';
import { date } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field } from '../components/ui';

export default function TimeOffAllocations() {
  const { role } = useAuth();
  const toast = useToast();
  const list = useList('/time-off/allocations');
  const { data: types } = useFetch('/time-off/types');
  const [creating, setCreating] = useState(false);

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
        <select className="o-input w-auto" onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {['DRAFT', 'APPROVED', 'REFUSED'].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
        </select>
        <select className="o-input w-auto" onChange={(e) => list.setParam({ timeOffTypeId: e.target.value || undefined })}>
          <option value="">All types</option>
          {(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
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
                    <th className="text-right">Allocated</th><th className="text-right">Taken</th>
                    <th className="text-right">Remaining</th><th>Valid From</th><th>Valid To</th>
                    <th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((a) => (
                    <tr key={a.id}>
                      <td className="font-medium text-ink">{a.employee?.name}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ background: a.timeOffType?.color }} />
                          {a.timeOffType?.name}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">{a.amount}</td>
                      <td className="text-right tabular-nums text-ink-soft">{a.balance?.taken ?? 0}</td>
                      <td className="text-right font-medium tabular-nums text-odoo-600">{a.balance?.remaining ?? 0}</td>
                      <td>{date(a.validFrom)}</td>
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
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={(p) => list.setParam({ page: p })} />
      </div>

      {creating && (
        <AllocationModal types={types ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); list.refetch(); }} />
      )}
    </>
  );
}

function AllocationModal({ types, onClose, onSaved }) {
  const toast = useToast();
  const { data: employees } = useFetch('/employees', { params: { limit: 200 } });
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
          <select className="o-input" value={form.employeeId} onChange={set('employeeId')} required>
            <option value="">Select employee</option>
            {(employees?.rows ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Time Off Type" required>
          <select className="o-input" value={form.timeOffTypeId} onChange={set('timeOffTypeId')} required>
            <option value="">Select type</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.unit.toLowerCase()})</option>)}
          </select>
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
