import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, Clock } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr } from '../lib/roles';
import { time, hours, date, titleCase } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field, SearchSelect, PagerBar, PeriodFilter } from '../components/ui';

export default function Attendance() {
  const [sp] = useSearchParams();
  const { role } = useAuth();
  const employeeId = sp.get('employeeId') ?? undefined;
  const list = useList('/attendance', { employeeId });
  const { data: employees } = useFetch('/employees', { params: { limit: 1000 }, skip: !isHr(role) });
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
          <SearchSelect
            className="w-auto min-w-52"
            value={list.params.employeeId ?? ''}
            onChange={(v) => list.setParam({ employeeId: v || undefined })}
            searchPlaceholder="Search by name or email…"
            options={[{ value: '', label: 'All employees' },
              ...(employees?.rows ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.workEmail }))]}
          />
        )}
        <select className="o-input w-auto" onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {['PRESENT', 'LATE', 'ABSENT', 'MISSING_CHECKOUT'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
        <PeriodFilter
          year={list.params.year}
          month={list.params.month}
          onChange={(v) => list.setParam(v)}
        />
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
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
        <Pagination page={list.page} pages={list.pages} total={list.total}
            limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
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
    status: record.status ?? undefined,
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
      if (isNew) delete payload.status;
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
      title={isNew
        ? 'New Attendance'
        : `Attendance / ${record.employee?.name} / ${date(record.checkIn)}`}
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
        {!isNew && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-hairline bg-gray-50 px-3 py-2.5 sm:grid-cols-4">
            {[
              ['Department', record.employee?.department?.name ?? '—'],
              ['Manager', record.employee?.manager?.name ?? '—'],
              ['Worked Hours', hours(record.workedHours)],
              ['Overtime', record.overtimeHours > 0 ? `${hours(record.overtimeHours)} hrs` : '—'],
              ['Corrected By', record.editedBy?.name ?? (record.isManual ? 'Manual entry' : '—')],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-[11px] text-ink-soft">{label}</p>
                <p className="text-sm font-medium text-ink">{value}</p>
              </div>
            ))}
          </div>
        )}

        <Field label="Employee" required>
          <SearchSelect
            required
            disabled={!isNew}
            value={form.employeeId}
            onChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}
            placeholder="Select employee"
            searchPlaceholder="Search by name or email…"
            options={[{ value: '', label: 'Select employee' },
              ...employees.map((e) => ({ value: e.id, label: e.name, hint: e.workEmail }))]}
          />
        </Field>
        <Field label="Check In" required>
          <input type="datetime-local" className="o-input" value={form.checkIn} onChange={set('checkIn')} required />
        </Field>
        <Field label="Check Out" hint="Leave blank for an open session">
          <input type="datetime-local" className="o-input" value={form.checkOut} onChange={set('checkOut')} />
        </Field>
        {!isNew && (
          <Field label="Status" hint="Derived from the schedule; override only to correct a misclassification.">
            <select className="o-input" value={form.status ?? record.status} onChange={set('status')}>
              {['PRESENT', 'LATE', 'ABSENT', 'MISSING_CHECKOUT'].map((v) => (
                <option key={v} value={v}>{titleCase(v)}</option>
              ))}
            </select>
          </Field>
        )}

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
