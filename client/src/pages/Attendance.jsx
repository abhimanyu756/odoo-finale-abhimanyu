import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, Clock } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr } from '../lib/roles';
import { dateTime, time, hours, date } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field } from '../components/ui';

export default function Attendance() {
  const [sp] = useSearchParams();
  const { role } = useAuth();
  const employeeId = sp.get('employeeId') ?? undefined;
  const list = useList('/attendance', { employeeId });
  const { data: employees } = useFetch('/employees', { params: { limit: 200 }, skip: !isHr(role) });
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Raw check-in / check-out records and exceptions"
        actions={
          isHr(role) && (
            <button type="button" className="o-btn-primary" onClick={() => setEditing({})}>
              <Plus size={15} /> New
            </button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search by employee…"
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <button type="button" className="o-btn-secondary"
          onClick={() => list.setParam({ today: list.params.today ? undefined : 'true' })}>
          {list.params.today ? 'Showing Today' : 'Today'}
        </button>
        {isHr(role) && (
          <select className="o-input w-auto" value={list.params.employeeId ?? ''}
            onChange={(e) => list.setParam({ employeeId: e.target.value || undefined })}>
            <option value="">All employees</option>
            {(employees?.rows ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        <select className="o-input w-auto" onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {['PRESENT', 'LATE', 'ABSENT', 'MISSING_CHECKOUT'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading attendance" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={Clock} title="No attendance records" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Employee</th><th>Date</th><th>Check In</th><th>Check Out</th>
                    <th className="text-right">Worked Hours</th><th className="text-right">Overtime</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((a) => (
                    <tr key={a.id} className={isHr(role) ? 'cursor-pointer' : ''}
                      onClick={() => isHr(role) && setEditing(a)}>
                      <td className="font-medium text-ink">{a.employee?.name}</td>
                      <td>{date(a.checkIn)}</td>
                      <td className="tabular-nums">{time(a.checkIn)}</td>
                      <td className="tabular-nums">
                        {a.checkOut ? time(a.checkOut) : <span className="text-amber-600">—</span>}
                      </td>
                      <td className="text-right tabular-nums">{hours(a.workedHours)}</td>
                      <td className="text-right tabular-nums text-ink-soft">
                        {a.overtimeHours > 0 ? hours(a.overtimeHours) : '—'}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <StatusBadge value={a.status} />
                          {a.isManual && <span className="o-badge bg-odoo-50 text-odoo-600">Edited</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={(p) => list.setParam({ page: p })} />
      </div>

      {editing && (
        <AttendanceModal record={editing} employees={employees?.rows ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.refetch(); }} />
      )}
    </>
  );
}

// Datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time, not an ISO
// string in UTC, or the displayed time shifts by the timezone offset.
const toLocalInput = (v) => {
  if (!v) return '';
  const d = new Date(v);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
};

function AttendanceModal({ record, employees, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !record.id;
  const [form, setForm] = useState({
    employeeId: record.employee?.id ?? '',
    checkIn: toLocalInput(record.checkIn),
    checkOut: toLocalInput(record.checkOut),
    notes: record.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, checkOut: form.checkOut || null, notes: form.notes || null };
      if (isNew) await api.post('/attendance', payload);
      else await api.patch(`/attendance/${record.id}`, payload);
      toast.success(isNew ? 'Attendance created' : 'Attendance corrected');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Delete this attendance record?')) return;
    try {
      await api.delete(`/attendance/${record.id}`);
      toast.success('Attendance deleted');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Modal
      open
      title={isNew ? 'New Attendance' : `Attendance / ${record.employee?.name}`}
      onClose={onClose}
      footer={
        <>
          {!isNew && <button type="button" className="o-btn-danger mr-auto" onClick={remove}>Delete</button>}
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="att-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="att-form" onSubmit={submit} className="grid gap-3">
        <Field label="Employee" required>
          <select className="o-input" value={form.employeeId} onChange={set('employeeId')} required disabled={!isNew}>
            <option value="">Select employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Check In" required>
          <input type="datetime-local" className="o-input" value={form.checkIn} onChange={set('checkIn')} required />
        </Field>
        <Field label="Check Out" hint="Leave blank for an open session">
          <input type="datetime-local" className="o-input" value={form.checkOut} onChange={set('checkOut')} />
        </Field>
        <Field label="Notes">
          <textarea className="o-input" rows={2} value={form.notes} onChange={set('notes')} />
        </Field>
        {!isNew && (
          <p className="rounded border border-hairline bg-gray-50 px-2.5 py-1.5 text-xs text-ink-soft">
            Worked hours and overtime are recalculated from the timestamps and the employee&apos;s
            working schedule; they cannot be entered directly.
          </p>
        )}
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
