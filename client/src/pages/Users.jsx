import { useState } from 'react';
import { ShieldCheck, Search } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { ROLE_LABELS, ROLES } from '../lib/roles';
import { initials } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field } from '../components/ui';

// User accounts are separate from Employee records but linked to one for
// access and ownership, so this screen is driven by the employee list.
export default function Users() {
  const list = useList('/employees', { limit: 50 });
  const [provisioning, setProvisioning] = useState(null);

  return (
    <>
      <PageHeader
        title="User Management"
        subtitle="Admin only — accounts are created here and linked to an employee record"
        actions={<span className="o-badge bg-odoo-100 text-odoo-700">Admin Only</span>}
      />

      <div className="mb-3 relative sm:max-w-xs">
        <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
        <input className="o-input pl-8" placeholder="Search users, employees or email…"
          onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading users" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={ShieldCheck} title="No employees" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr><th>Employee</th><th>Work Email</th><th>Role</th><th>Account</th><th /></tr>
                </thead>
                <tbody>
                  {list.rows.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <span className="flex items-center gap-2">
                          <span className="grid h-7 w-7 place-items-center rounded-full bg-odoo-100 text-[10px] font-semibold text-odoo-600">
                            {initials(e.name)}
                          </span>
                          <span className="font-medium text-ink">{e.name}</span>
                        </span>
                      </td>
                      <td className="text-ink-soft">{e.workEmail}</td>
                      <td>
                        {e.user
                          ? <span className="o-badge bg-odoo-50 text-odoo-700">{ROLE_LABELS[e.user.role]}</span>
                          : <span className="text-xs text-ink-soft">—</span>}
                      </td>
                      <td>
                        {e.user
                          ? <StatusBadge value={e.user.isActive ? 'ACTIVE' : 'INACTIVE'} />
                          : <span className="o-badge bg-amber-100 text-amber-700">No login</span>}
                      </td>
                      <td className="text-right">
                        {!e.user && (
                          <button type="button" className="o-btn-secondary px-2 py-1"
                            onClick={() => setProvisioning(e)}>
                            Create Login
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

      <p className="mt-3 text-xs text-ink-soft">
        User accounts are separate from Employee records, but are linked to an employee for access and ownership.
      </p>

      {provisioning && (
        <ProvisionModal employee={provisioning}
          onClose={() => setProvisioning(null)}
          onDone={() => { setProvisioning(null); list.refetch(); }} />
      )}
    </>
  );
}

function ProvisionModal({ employee, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ email: employee.workEmail, password: '', role: 'EMPLOYEE', isActive: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/employees/${employee.id}/user`, form);
      toast.success(`Login created for ${employee.name}`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="Create / Edit User" onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="user-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create User / Save Access'}
          </button>
        </>
      }>
      <form id="user-form" onSubmit={submit} className="grid gap-3">
        <Field label="Employee" required>
          <input className="o-input" value={employee.name} disabled />
        </Field>
        <Field label="Work Email" required>
          <input className="o-input" type="email" value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
        </Field>
        <Field label="Temporary Password" required hint="At least 8 characters">
          <input className="o-input" type="text" minLength={8} value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
        </Field>
        <fieldset>
          <legend className="o-label">Roles</legend>
          <div className="grid gap-1">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-odoo-50">
                <input type="radio" name="role" value={r} checked={form.role === r}
                  onChange={() => setForm((f) => ({ ...f, role: r }))} />
                {ROLE_LABELS[r]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
          Account active
        </label>
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
