import { useState } from 'react';
import { Plus, Search, ShieldCheck, KeyRound, Trash2 } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ROLE_LABELS, ROLES } from '../lib/roles';
import { initials, dateTime } from '../lib/format';
import {
  PageHeader, Spinner, EmptyState, ErrorState, StatusBadge,
  Pagination, Modal, Field, PasswordInput, SearchSelect, PagerBar,
} from '../components/ui';

// User accounts are separate from Employee records but linked to one for access
// and ownership, so this screen lists Users and shows the employee behind each.
export default function Users() {
  const list = useList('/users', { limit: 50 });
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="User Management"
        subtitle="Accounts are created here and linked to an employee record"
        actions={
          <>
            <span className="o-badge bg-odoo-100 text-odoo-700">Admin Only</span>
            <button type="button" className="o-btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New User
            </button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search users, employees or email…"
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <select
          className="o-input w-auto"
          value={list.params.role ?? ''}
          onChange={(e) => list.setParam({ role: e.target.value || undefined })}
          aria-label="Filter by role"
        >
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <select
          className="o-input w-auto"
          value={list.params.status ?? ''}
          onChange={(e) => list.setParam({ status: e.target.value || undefined })}
          aria-label="Filter by account status"
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading users" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={ShieldCheck} title="No users match these filters" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>User</th><th>Employee</th><th>Work Email</th>
                    <th>Role</th><th>Last Sign-in</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((u) => (
                    <tr key={u.id} className="cursor-pointer" onClick={() => setEditing(u)}>
                      <td>
                        <span className="flex items-center gap-2">
                          <span className="grid h-7 w-7 place-items-center rounded-full bg-odoo-100 text-[10px] font-semibold text-odoo-600">
                            {initials(u.employee?.name ?? u.email)}
                          </span>
                          <span className="font-medium text-ink">{u.employee?.name ?? '—'}</span>
                        </span>
                      </td>
                      <td className="text-ink-soft">{u.employee?.department?.name ?? '—'}</td>
                      <td className="text-ink-soft">{u.email}</td>
                      <td><span className="o-badge bg-odoo-50 text-odoo-700">{ROLE_LABELS[u.role]}</span></td>
                      <td className="text-xs text-ink-soft">
                        {u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never'}
                      </td>
                      <td><StatusBadge value={u.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
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
        Select a user to edit access, or create a new user. User accounts are separate from
        Employee records, but are linked to an employee for access and ownership.
      </p>

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); list.refetch(); }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.refetch(); }}
        />
      )}
    </>
  );
}

function RoleRadios({ value, onChange, disabled, hint }) {
  return (
    <fieldset disabled={disabled}>
      <legend className="o-label">
        Roles <span className="text-red-500">*</span>
      </legend>
      <div className="grid gap-1">
        {ROLES.map((r) => (
          <label key={r}
            className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm ${
              disabled ? 'opacity-60' : 'cursor-pointer hover:bg-odoo-50'}`}>
            <input type="radio" name="role" value={r} checked={value === r}
              onChange={() => onChange(r)} disabled={disabled} />
            {ROLE_LABELS[r]}
          </label>
        ))}
      </div>
      {hint && <p className="mt-1 text-xs text-amber-700">{hint}</p>}
    </fieldset>
  );
}

function CreateUserModal({ onClose, onSaved }) {
  const toast = useToast();
  const { data: assignable, loading } = useFetch('/users/assignable-employees');
  const [form, setForm] = useState({ employeeId: '', email: '', password: '', role: 'EMPLOYEE', isActive: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pickEmployee = (id) => {
    const emp = (assignable ?? []).find((e) => e.id === id);
    // Default the login address to the employee's work email.
    setForm((f) => ({ ...f, employeeId: id, email: emp?.workEmail ?? f.email }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', form);
      toast.success('User created');
      onSaved();
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
          <button type="submit" form="user-create" className="o-btn-primary"
            disabled={busy || !form.employeeId}>
            {busy ? 'Creating…' : 'Create User / Save Access'}
          </button>
        </>
      }>
      {loading ? <Spinner label="Loading employees" /> : (
        <form id="user-create" onSubmit={submit} className="grid gap-3">
          <Field label="Employee" required
            hint="Only employees without an existing login are listed.">
            <SearchSelect
              required
              value={form.employeeId}
              onChange={pickEmployee}
              placeholder="Select employee"
              searchPlaceholder="Search by name or email…"
              options={[{ value: '', label: 'Select employee' },
                ...(assignable ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.workEmail }))]}
            />
          </Field>

          {assignable?.length === 0 && (
            <p className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              Every employee already has a login. Create an employee first, or edit an
              existing user&apos;s access.
            </p>
          )}

          <Field label="Work Email" required>
            <input className="o-input" type="email" value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="employee@company.com" required />
          </Field>

          <Field label="Temporary Password" required hint="At least 8 characters; the user is prompted to change it.">
            <PasswordInput value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              minLength={8} required />
          </Field>

          <RoleRadios value={form.role} onChange={(r) => setForm((f) => ({ ...f, role: r }))} />

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
            Account active
          </label>

          {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
        </form>
      )}
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSaved }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const isSelf = me?.id === user.id;

  const [form, setForm] = useState({ email: user.email, role: user.role, isActive: user.isActive });
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/users/${user.id}`, form);
      if (newPassword) {
        await api.post(`/users/${user.id}/reset-password`, { password: newPassword });
        toast.success('Access saved and password reset');
      } else {
        toast.success('Access saved');
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!confirm(`Revoke the login for ${user.employee?.name ?? user.email}? The employee record is kept.`)) return;
    setBusy(true);
    try {
      await api.delete(`/users/${user.id}`);
      toast.success('Login revoked');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal open title="Create / Edit User" onClose={onClose}
      footer={
        <>
          {!isSelf && (
            <button type="button" className="o-btn-danger mr-auto" onClick={revoke} disabled={busy}>
              <Trash2 size={14} /> Revoke Login
            </button>
          )}
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="user-edit" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Create User / Save Access'}
          </button>
        </>
      }>
      <form id="user-edit" onSubmit={save} className="grid gap-3">
        <Field label="Employee">
          <input className="o-input" value={user.employee?.name ?? 'Not linked'} disabled />
        </Field>

        <Field label="Work Email" required>
          <input className="o-input" type="email" value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
        </Field>

        <RoleRadios
          value={form.role}
          onChange={(r) => setForm((f) => ({ ...f, role: r }))}
          disabled={isSelf}
          hint={isSelf ? 'You cannot change your own role — ask another administrator.' : null}
        />

        <div>
          <span className="o-label">Account Status</span>
          <button
            type="button"
            disabled={isSelf}
            onClick={() => setForm((f) => ({ ...f, isActive: !f.isActive }))}
            className={`o-badge px-2.5 py-1 ${
              form.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
            } ${isSelf ? 'cursor-not-allowed opacity-60' : 'hover:opacity-80'}`}
          >
            {form.isActive ? 'Active' : 'Inactive'}
          </button>
          {isSelf && <p className="mt-1 text-xs text-amber-700">You cannot deactivate your own account.</p>}
        </div>

        <Field label="Reset Password" hint="Leave blank to keep the current password.">
          <PasswordInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            minLength={8} placeholder="New temporary password" />
        </Field>

        <p className="rounded border border-hairline bg-gray-50 px-2.5 py-1.5 text-[11px] text-ink-soft">
          <KeyRound size={11} className="mr-1 inline" />
          Changing a role, deactivating an account or resetting a password signs the
          user out of every active session.
        </p>

        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
