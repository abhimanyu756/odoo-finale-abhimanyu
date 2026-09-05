import { useState } from 'react';
import { Plus, Tags } from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Modal, Field } from '../components/ui';

export default function TimeOffTypes() {
  const { data: types, loading, error, refetch } = useFetch('/time-off/types');
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Time Off Types"
        subtitle="Leave policies: units, allocation requirement, approval and payroll treatment"
        actions={
          <button type="button" className="o-btn-primary" onClick={() => setEditing({})}>
            <Plus size={15} /> New Type
          </button>
        }
      />

      <div className="o-card overflow-hidden">
        {loading ? <Spinner label="Loading types" />
          : error ? <ErrorState message={error} onRetry={refetch} />
          : !types?.length ? <EmptyState icon={Tags} title="No time off types" />
          : (
            <table className="o-table">
              <thead>
                <tr>
                  <th>Name</th><th>Code</th><th>Unit</th>
                  <th>Requires Allocation</th><th>Requires Approval</th><th>Paid</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id} className="cursor-pointer" onClick={() => setEditing(t)}>
                    <td>
                      <span className="inline-flex items-center gap-2 font-medium text-ink">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                        {t.name}
                      </span>
                    </td>
                    <td className="font-mono text-xs text-ink-soft">{t.code}</td>
                    <td>{t.unit === 'HOURS' ? 'Hours' : 'Days'}</td>
                    <td>{t.requiresAllocation ? 'Yes' : 'No'}</td>
                    <td>{t.requiresApproval ? 'Yes' : 'No'}</td>
                    <td>{t.isPaid ? 'Paid' : <span className="text-amber-600">Unpaid</span>}</td>
                    <td><StatusBadge value={t.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {editing && (
        <TypeModal type={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch(); }} />
      )}
    </>
  );
}

const Toggle = ({ label, checked, onChange, hint }) => (
  <label className="flex items-start gap-2 rounded-md border border-hairline px-2.5 py-2">
    <input type="checkbox" className="mt-0.5" checked={checked}
      onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="block text-sm text-ink">{label}</span>
      {hint && <span className="block text-xs text-ink-soft">{hint}</span>}
    </span>
  </label>
);

function TypeModal({ type, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !type.id;
  const [form, setForm] = useState({
    name: type.name ?? '', code: type.code ?? '', unit: type.unit ?? 'DAYS',
    requiresAllocation: type.requiresAllocation ?? true,
    requiresApproval: type.requiresApproval ?? true,
    isPaid: type.isPaid ?? true, color: type.color ?? '#714B67',
    isActive: type.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) await api.post('/time-off/types', form);
      else await api.patch(`/time-off/types/${type.id}`, form);
      toast.success(isNew ? 'Type created' : 'Type updated');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={isNew ? 'New Time Off Type' : type.name} onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="type-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      <form id="type-form" onSubmit={submit} className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <input className="o-input" value={form.name} onChange={(e) => set('name', e.target.value)} required />
          </Field>
          <Field label="Code" required>
            <input className="o-input font-mono uppercase" value={form.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())} required disabled={!isNew} />
          </Field>
          <Field label="Unit">
            <select className="o-input" value={form.unit} onChange={(e) => set('unit', e.target.value)}>
              <option value="DAYS">Days</option>
              <option value="HOURS">Hours</option>
            </select>
          </Field>
          <Field label="Colour">
            <input type="color" className="o-input h-9 p-1" value={form.color}
              onChange={(e) => set('color', e.target.value)} />
          </Field>
        </div>
        <Toggle label="Requires allocation" checked={form.requiresAllocation} onChange={(v) => set('requiresAllocation', v)}
          hint="Approved requests consume an approved allocation and cannot exceed the balance." />
        <Toggle label="Requires approval" checked={form.requiresApproval} onChange={(v) => set('requiresApproval', v)}
          hint="When off, requests are approved on submission." />
        <Toggle label="Paid leave" checked={form.isPaid} onChange={(v) => set('isPaid', v)}
          hint="Unpaid leave feeds the payroll deduction rule." />
        <Toggle label="Active" checked={form.isActive} onChange={(v) => set('isActive', v)} />
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
