import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Layers, Search } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isPayrollAdmin } from '../lib/roles';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Modal, Field } from '../components/ui';

export default function SalaryStructures() {
  const { role } = useAuth();
  const list = useList('/salary/structures', { limit: 50 });
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Salary Structures"
        subtitle="Containers for the salary rules that compute a payslip"
        actions={
          isPayrollAdmin(role) && (
            <button type="button" className="o-btn-primary" onClick={() => setEditing({})}>
              <Plus size={15} /> New Structure
            </button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search structures…"
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading structures" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={Layers} title="No salary structures" />
          : (
            <table className="o-table">
              <thead>
                <tr>
                  <th>Structure</th><th>Code</th><th>Description</th>
                  <th className="text-right">Rules</th><th className="text-right">Contracts</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {list.rows.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium text-ink">{s.name}</td>
                    <td className="font-mono text-xs text-ink-soft">{s.code}</td>
                    <td className="text-ink-soft">{s.description ?? '—'}</td>
                    <td className="text-right tabular-nums">{s.ruleCount}</td>
                    <td className="text-right tabular-nums">{s.contractCount}</td>
                    <td><StatusBadge value={s.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Link to={`/payroll/rules?structureId=${s.id}`} className="o-btn-secondary px-2 py-1">
                          View Rules
                        </Link>
                        {isPayrollAdmin(role) && (
                          <button type="button" className="o-btn-secondary px-2 py-1" onClick={() => setEditing(s)}>
                            Edit
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {editing && (
        <StructureModal structure={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.refetch(); }} />
      )}
    </>
  );
}

function StructureModal({ structure, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !structure.id;
  const [form, setForm] = useState({
    name: structure.name ?? '', code: structure.code ?? '',
    description: structure.description ?? '', isActive: structure.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) await api.post('/salary/structures', form);
      else await api.patch(`/salary/structures/${structure.id}`, form);
      toast.success('Saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={isNew ? 'New Salary Structure' : structure.name} onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="struct-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      <form id="struct-form" onSubmit={submit} className="grid gap-3">
        <Field label="Name" required>
          <input className="o-input" value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
        </Field>
        <Field label="Code" required>
          <input className="o-input font-mono uppercase" value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            required disabled={!isNew} />
        </Field>
        <Field label="Description">
          <textarea className="o-input" rows={2} value={form.description ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
          Active
        </label>
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
