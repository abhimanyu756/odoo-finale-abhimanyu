import { useState } from 'react';
import { Plus, Building2, Search, Trash2, Pencil } from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr } from '../lib/roles';
import { PageHeader, Spinner, EmptyState, ErrorState, Modal, Field, SearchSelect } from '../components/ui';

// Departments are small and rarely change, so the whole set loads at once and
// filtering happens in the browser - no pagination to get in the way.
export default function Departments() {
  const { role } = useAuth();
  const { data, loading, error, refetch } = useFetch('/org/departments');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);

  const term = search.trim().toLowerCase();
  const rows = (data ?? []).filter((d) => !term || d.name.toLowerCase().includes(term));
  const totalStaff = (data ?? []).reduce((s, d) => s + (d.employeeCount ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="How the company is grouped — used by employees, contracts and the payroll dashboard"
        actions={isHr(role) && (
          <button type="button" className="o-btn-primary" onClick={() => setEditing({})}>
            <Plus size={15} /> New Department
          </button>
        )}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search departments…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <span className="ml-auto text-xs text-ink-soft">
          {rows.length} department{rows.length === 1 ? '' : 's'} · {totalStaff} employees
        </span>
      </div>

      <div className="o-card overflow-hidden">
        {loading ? <Spinner label="Loading departments" />
          : error ? <ErrorState message={error} onRetry={refetch} />
          : !rows.length ? <EmptyState icon={Building2} title="No departments"
              hint="Create one so employees and contracts can be grouped." />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Department</th><th>Company</th>
                    <th className="text-right">Employees</th>
                    {isHr(role) && <th className="w-20" aria-label="Row actions" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td className="font-medium text-ink">{d.name}</td>
                      <td className="text-ink-soft">{d.company?.name ?? '—'}</td>
                      <td className="text-right tabular-nums">{d.employeeCount ?? 0}</td>
                      {isHr(role) && (
                        <td className="text-right">
                          <button type="button" className="o-btn-ghost px-1.5 py-1"
                            title={`Rename ${d.name}`} onClick={() => setEditing(d)}>
                            <Pencil size={14} />
                          </button>
                          <DeleteButton dept={d} onDone={refetch} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {editing && (
        <DepartmentModal
          dept={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch(); }}
        />
      )}
    </>
  );
}

// A department holding employees cannot be deleted without orphaning them, so
// the button says why rather than letting the server reject the click.
function DeleteButton({ dept, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inUse = (dept.employeeCount ?? 0) > 0;

  const remove = async () => {
    if (!confirm(`Delete the ${dept.name} department?`)) return;
    setBusy(true);
    try {
      await api.delete(`/org/departments/${dept.id}`);
      toast.success('Department deleted');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="o-btn-ghost px-1.5 py-1 text-red-600 hover:bg-red-50 disabled:opacity-40"
      disabled={busy || inUse}
      title={inUse
        ? `${dept.employeeCount} employee(s) are in this department — reassign them first`
        : `Delete ${dept.name}`}
      onClick={remove}
    >
      <Trash2 size={14} />
    </button>
  );
}

function DepartmentModal({ dept, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !dept.id;
  const { data: companies } = useFetch('/org/companies');
  const [form, setForm] = useState({ name: dept.name ?? '', companyId: dept.companyId ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // With a single company there is nothing to choose, so it is preselected.
  const only = companies?.length === 1 ? companies[0].id : null;
  const companyId = form.companyId || only || '';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) await api.post('/org/departments', { ...form, companyId });
      else await api.patch(`/org/departments/${dept.id}`, { name: form.name });
      toast.success(isNew ? 'Department created' : 'Department updated');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={isNew ? 'New Department' : `Rename ${dept.name}`} onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="dept-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      <form id="dept-form" onSubmit={submit} className="grid gap-3">
        <Field label="Name" required>
          <input className="o-input" value={form.name} required autoFocus
            placeholder="Engineering"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        {isNew && (
          <Field label="Company" required>
            <SearchSelect
              required
              value={companyId}
              onChange={(v) => setForm((f) => ({ ...f, companyId: v }))}
              placeholder="Select company"
              searchPlaceholder="Search companies…"
              options={(companies ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.currency }))}
            />
          </Field>
        )}
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
