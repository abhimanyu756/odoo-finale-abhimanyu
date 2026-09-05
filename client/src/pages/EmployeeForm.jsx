import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarClock, FileText, Clock, Save, X, UserPlus,
  Trash2, Archive, ArchiveRestore, AlertTriangle,
} from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr, isAdmin } from '../lib/roles';
import { initials, titleCase, date } from '../lib/format';
import { PageHeader, Spinner, ErrorState, StatusBadge, SmartButton, Field, Modal, SearchSelect } from '../components/ui';

const TABS = ['Work Information', 'Private Information'];

// Only these roles can be a named HR responsible; the payroll-only roles
// govern pay rather than the employment relationship.
const HR_ROLES = ['HR_MANAGER', 'HR_PAYROLL_ADMIN', 'ADMIN'];

// Declared at module scope: a component created inside render is a new type on
// every pass, so React remounts it and any focused input loses focus.
const ReadRow = ({ label, children }) => (
  <div>
    <p className="o-label">{label}</p>
    <p className="rounded-md border border-hairline bg-gray-50 px-2.5 py-1.5 text-sm text-ink">
      {children}
    </p>
  </div>
);

export default function EmployeeForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { role } = useAuth();
  const toast = useToast();
  const { data: employee, loading, error, refetch } = useFetch(`/employees/${id}`);
  const { data: depts } = useFetch('/org/departments');
  const { data: positions } = useFetch('/org/job-positions');
  const { data: schedules } = useFetch('/working-schedules', { params: { limit: 100 } });
  const { data: managers } = useFetch('/employees', { params: { limit: 1000 } });

  // ?tab=private lands straight on the Private Information tab, so a link from
  // a payroll warning ("no bank account on file") opens the field it means.
  const [tab, setTab] = useState(
    new URLSearchParams(window.location.search).get('tab') === 'private' ? TABS[1] : TABS[0],
  );
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (loading) return <Spinner label="Loading employee" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!employee) return null;

  const startEdit = () => {
    setForm({
      firstName: employee.firstName, lastName: employee.lastName,
      workEmail: employee.workEmail, personalEmail: employee.personalEmail ?? '',
      hrResponsibleId: employee.hrResponsible?.id ?? '',
      phone: employee.phone ?? '', employeeType: employee.employeeType,
      status: employee.status, workLocation: employee.workLocation ?? '',
      departmentId: employee.department?.id ?? '', jobPositionId: employee.jobPosition?.id ?? '',
      workingScheduleId: employee.workingSchedule?.id ?? '', managerId: employee.manager?.id ?? '',
      address: employee.address ?? '', bankAccount: employee.bankAccount ?? '',
      identificationNo: employee.identificationNo ?? '',
      dateOfBirth: employee.dateOfBirth?.slice(0, 10) ?? '', hireDate: employee.hireDate?.slice(0, 10) ?? '',
    });
    setEditing(true);
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      // Blank strings would fail uuid/date validation, so send null instead.
      const payload = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v === '' ? null : v]),
      );
      await api.patch(`/employees/${id}`, payload);
      toast.success('Employee updated');
      setEditing(false);
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (action) => {
    setBusy(true);
    try {
      await api.post(`/employees/${id}/${action}`);
      toast.success(action === 'archive' ? 'Employee archived' : 'Employee restored');
      refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const value = (v) => v ?? '—';

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/employees" className="mb-1 flex items-center gap-1 text-xs text-ink-soft hover:text-odoo-600">
            <ArrowLeft size={12} /> Employees
          </Link>
        }
        title={`Employee / ${employee.name}`}
        subtitle="Main employee form with related HR actions"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Smart buttons open the related records filtered to this employee */}
            <SmartButton
              label="Time Off" icon={CalendarClock} count={employee.counts?.timeOff}
              onClick={() => navigate(`/time-off/requests?employeeId=${id}`)}
            />
            <SmartButton
              label="Contracts" icon={FileText} count={employee.counts?.contracts}
              onClick={() => navigate(`/contracts?employeeId=${id}`)}
            />
            <SmartButton
              label="Attendance" icon={Clock} count={employee.counts?.attendance}
              onClick={() => navigate(`/attendance?employeeId=${id}`)}
            />
          </div>
        }
      />

      <div className="o-card p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-4">
            <span className="grid h-16 w-16 place-items-center rounded-xl bg-odoo-100 text-lg font-semibold text-odoo-600">
              {initials(employee.name)}
            </span>
            <div>
              <h2 className="text-lg font-semibold text-ink">{employee.name}</h2>
              <p className="text-sm text-ink-soft">
                {employee.jobPosition?.name ?? 'No position'}
                {employee.department && ` • ${employee.department.name}`}
              </p>
              <p className="text-xs text-ink-soft">
                {employee.workEmail}{employee.phone && ` | ${employee.phone}`}
              </p>
            </div>
          </div>

          {isHr(role) && (
            <div className="flex gap-2">
              {editing ? (
                <>
                  <button type="button" className="o-btn-secondary" onClick={() => setEditing(false)}>
                    <X size={14} /> Cancel
                  </button>
                  <button type="button" className="o-btn-primary" onClick={save} disabled={busy}>
                    <Save size={14} /> {busy ? 'Saving…' : 'Save'}
                  </button>
                </>
              ) : (
                <>
                  {isAdmin(role) && !employee.user && (
                    <button type="button" className="o-btn-secondary" onClick={() => setProvisioning(true)}>
                      <UserPlus size={14} /> Create Login
                    </button>
                  )}
                  {employee.status === 'ACTIVE' ? (
                    <button type="button" className="o-btn-secondary" disabled={busy}
                      onClick={() => archive('archive')}>
                      <Archive size={14} /> Archive
                    </button>
                  ) : (
                    <button type="button" className="o-btn-secondary" disabled={busy}
                      onClick={() => archive('restore')}>
                      <ArchiveRestore size={14} /> Restore
                    </button>
                  )}
                  <button type="button" className="o-btn-danger" onClick={() => setDeleting(true)}>
                    <Trash2 size={14} /> Delete
                  </button>
                  <button type="button" className="o-btn-secondary" onClick={startEdit}>Edit</button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mb-4 flex gap-4 border-b border-hairline">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-1 pb-2 text-sm ${
                tab === t ? 'border-odoo-500 font-medium text-odoo-600' : 'border-transparent text-ink-soft'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === TABS[0] ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {editing ? (
              <>
                <Field label="First Name"><input className="o-input" value={form.firstName} onChange={set('firstName')} /></Field>
                <Field label="Last Name"><input className="o-input" value={form.lastName} onChange={set('lastName')} /></Field>
                <Field label="Work Email"><input className="o-input" value={form.workEmail} onChange={set('workEmail')} /></Field>
                <Field label="Department">
                  <SearchSelect
                    value={form.departmentId}
                    onChange={(v) => setForm((f) => ({ ...f, departmentId: v }))}
                    placeholder="—"
                    searchPlaceholder="Search departments…"
                    options={[{ value: '', label: '—' },
                      ...(depts ?? []).map((d) => ({ value: d.id, label: d.name }))]}
                  />
                </Field>
                <Field label="Job Position">
                  <SearchSelect
                    value={form.jobPositionId}
                    onChange={(v) => setForm((f) => ({ ...f, jobPositionId: v }))}
                    placeholder="—"
                    searchPlaceholder="Search positions…"
                    options={[{ value: '', label: '—' },
                      ...(positions ?? []).map((p) => ({ value: p.id, label: p.name }))]}
                  />
                </Field>
                <Field label="Manager">
                  <SearchSelect
                    value={form.managerId}
                    onChange={(v) => setForm((f) => ({ ...f, managerId: v }))}
                    placeholder="—"
                    searchPlaceholder="Search by name or email…"
                    options={[{ value: '', label: '—' },
                      ...(managers?.rows ?? [])
                        .filter((m) => m.id !== id)
                        .map((m) => ({ value: m.id, label: m.name, hint: m.workEmail }))]}
                  />
                </Field>
                <Field label="HR Responsible"
                  hint="The HR person who owns this file — approves officer-level leave">
                  <SearchSelect
                    value={form.hrResponsibleId}
                    onChange={(v) => setForm((f) => ({ ...f, hrResponsibleId: v }))}
                    placeholder="—"
                    searchPlaceholder="Search by name or email…"
                    options={[{ value: '', label: '—' },
                      ...(managers?.rows ?? [])
                        .filter((m) => m.id !== id && m.user && HR_ROLES.includes(m.user.role))
                        .map((m) => ({ value: m.id, label: m.name, hint: m.user?.role?.replace(/_/g, ' ') }))]}
                  />
                </Field>
                <Field label="Working Schedule">
                  <SearchSelect
                    value={form.workingScheduleId}
                    onChange={(v) => setForm((f) => ({ ...f, workingScheduleId: v }))}
                    placeholder="—"
                    searchPlaceholder="Search schedules…"
                    options={[{ value: '', label: '—' },
                      ...(schedules?.rows ?? []).map((s) => ({ value: s.id, label: s.name }))]}
                  />
                </Field>
                <Field label="Work Location"><input className="o-input" value={form.workLocation} onChange={set('workLocation')} /></Field>
                <Field label="Employee Type">
                  <select className="o-input" value={form.employeeType} onChange={set('employeeType')}>
                    {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => (
                      <option key={t} value={t}>{titleCase(t)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select className="o-input" value={form.status} onChange={set('status')}>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>
                </Field>
                <Field label="Phone"><input className="o-input" value={form.phone} onChange={set('phone')} /></Field>
                <Field label="Hire Date"><input type="date" className="o-input" value={form.hireDate} onChange={set('hireDate')} /></Field>
              </>
            ) : (
              <>
                <ReadRow label="Department">{value(employee.department?.name)}</ReadRow>
                <ReadRow label="Job Position">{value(employee.jobPosition?.name)}</ReadRow>
                <ReadRow label="Manager">{value(employee.manager?.name)}</ReadRow>
                <ReadRow label="HR Responsible">{value(employee.hrResponsible?.name)}</ReadRow>
                <ReadRow label="Working Schedule">
                  {employee.workingSchedule
                    ? `${employee.workingSchedule.name} (${employee.workingSchedule.hoursPerWeek}h/week)`
                    : '—'}
                </ReadRow>
                <ReadRow label="Work Location">{value(employee.workLocation)}</ReadRow>
                <ReadRow label="Employee Type">{titleCase(employee.employeeType)}</ReadRow>
                <ReadRow label="Company">{value(employee.company?.name)}</ReadRow>
                <ReadRow label="Hire Date">{date(employee.hireDate)}</ReadRow>
                <div>
                  <p className="o-label">Status</p>
                  <div className="rounded-md border border-hairline bg-gray-50 px-2.5 py-1.5">
                    <StatusBadge value={employee.status} />
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {editing ? (
              <>
                <Field label="Personal Email"><input className="o-input" value={form.personalEmail} onChange={set('personalEmail')} /></Field>
                <Field label="Phone"><input className="o-input" value={form.phone} onChange={set('phone')} /></Field>
                <Field label="Date of Birth"><input type="date" className="o-input" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
                <Field label="Address"><input className="o-input" value={form.address} onChange={set('address')} /></Field>
                <Field label="Bank Account" hint="Required before payslips can be paid">
                  <input className="o-input" value={form.bankAccount} onChange={set('bankAccount')} />
                </Field>
                <Field label="Identification No."><input className="o-input" value={form.identificationNo} onChange={set('identificationNo')} /></Field>
              </>
            ) : (
              <>
                <ReadRow label="Personal Email">{value(employee.personalEmail)}</ReadRow>
                <ReadRow label="Phone">{value(employee.phone)}</ReadRow>
                <ReadRow label="Date of Birth">{date(employee.dateOfBirth)}</ReadRow>
                <ReadRow label="Address">{value(employee.address)}</ReadRow>
                <ReadRow label="Bank Account">
                  {employee.bankAccount ?? <span className="text-amber-600">Not provided</span>}
                </ReadRow>
                <ReadRow label="Identification No.">{value(employee.identificationNo)}</ReadRow>
                <ReadRow label="Login Account">
                  {employee.user ? `${employee.user.email} (${titleCase(employee.user.role)})` : 'No login'}
                </ReadRow>
              </>
            )}
          </div>
        )}
      </div>

      {deleting && (
        <DeleteEmployeeModal
          employee={employee}
          onClose={() => setDeleting(false)}
          onDeleted={() => navigate('/employees')}
          onArchived={() => { setDeleting(false); refetch(); }}
        />
      )}

      {provisioning && (
        <ProvisionUserModal
          employee={employee}
          onClose={() => setProvisioning(false)}
          onDone={() => { setProvisioning(false); refetch(); }}
        />
      )}
    </>
  );
}

function ProvisionUserModal({ employee, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ email: employee.workEmail, password: '', role: 'EMPLOYEE' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/employees/${employee.id}/user`, form);
      toast.success('Login created');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Create login for ${employee.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="provision" className="o-btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create User'}
          </button>
        </>
      }
    >
      <form id="provision" onSubmit={submit} className="grid gap-3">
        <Field label="Work Email" required>
          <input className="o-input" type="email" value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
        </Field>
        <Field label="Temporary Password" required hint="At least 8 characters; the user is asked to reset it.">
          <input className="o-input" type="text" value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} minLength={8} required />
        </Field>
        <Field label="Role" required>
          <select className="o-input" value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            {['EMPLOYEE', 'HR_MANAGER', 'HR_PAYROLL_USER', 'HR_PAYROLL_ADMIN', 'ADMIN'].map((r) => (
              <option key={r} value={r}>{titleCase(r)}</option>
            ))}
          </select>
        </Field>
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}

// Deleting an employee erases contracts, attendance and leave with them, so the
// confirmation states exactly what is destroyed and offers archiving instead.
function DeleteEmployeeModal({ employee, onClose, onDeleted, onArchived }) {
  const toast = useToast();
  const { data: impact, loading } = useFetch(`/employees/${employee.id}/deletion-impact`);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const run = async (action) => {
    setBusy(true);
    try {
      if (action === 'delete') {
        await api.delete(`/employees/${employee.id}`);
        toast.success(`${employee.name} deleted`);
        onDeleted();
      } else {
        await api.post(`/employees/${employee.id}/archive`);
        toast.success(`${employee.name} archived`);
        onArchived();
      }
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  const rows = impact
    ? [
        ['Contracts', impact.contracts],
        ['Attendance records', impact.attendances],
        ['Time off requests', impact.leaveRequests],
        ['Leave allocations', impact.allocations],
        ['Payslips', impact.payslips],
      ]
    : [];

  const nameMatches = confirmText.trim() === employee.name;

  return (
    <Modal
      open
      title={`Delete ${employee.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          {employee.status === 'ACTIVE' && (
            <button type="button" className="o-btn-secondary" disabled={busy}
              onClick={() => run('archive')}>
              <Archive size={14} /> Archive instead
            </button>
          )}
          <button
            type="button"
            className="o-btn-danger"
            disabled={busy || loading || !impact?.canDelete || !nameMatches}
            onClick={() => run('delete')}
          >
            <Trash2 size={14} /> {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </>
      }
    >
      {loading ? (
        <Spinner label="Checking what this would remove" />
      ) : (
        <div className="grid gap-3">
          {!impact?.canDelete && (
            <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{impact?.blockedReason}</span>
            </div>
          )}

          <div>
            <p className="o-label">This will permanently remove</p>
            <table className="o-table">
              <tbody>
                {rows.map(([label, n]) => (
                  <tr key={label}>
                    <td className="text-ink-soft">{label}</td>
                    <td className="text-right font-medium tabular-nums text-ink">{n}</td>
                  </tr>
                ))}
                <tr>
                  <td className="text-ink-soft">Login account</td>
                  <td className="text-right font-medium text-ink">
                    {employee.user ? 'Yes — access revoked' : 'None'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-xs text-ink-soft">
            Archiving keeps every record and simply ends access — it is reversible.
            Deleting is not.
          </p>

          {impact?.canDelete && (
            <label className="block">
              <span className="o-label">
                Type <strong className="text-ink">{employee.name}</strong> to confirm
              </span>
              <input className="o-input" value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)} placeholder={employee.name} />
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
