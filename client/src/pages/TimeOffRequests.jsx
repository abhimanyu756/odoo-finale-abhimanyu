import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, CalendarClock, Check, X } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isHr } from '../lib/roles';
import { date } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field } from '../components/ui';

export default function TimeOffRequests() {
  const [sp] = useSearchParams();
  const { role } = useAuth();
  const list = useList('/time-off/requests', { employeeId: sp.get('employeeId') ?? undefined });
  const { data: types } = useFetch('/time-off/types');
  const { data: balances } = useFetch('/time-off/balances');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);

  return (
    <>
      <PageHeader
        title="Time Off Requests"
        subtitle="Leave requests and their approval status"
        actions={
          <button type="button" className="o-btn-primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New Request
          </button>
        }
      />

      {/* Own balances, so an employee knows what they can request before filing */}
      {balances?.length > 0 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {balances.map((b) => (
            <div key={b.type.id} className="o-card p-3">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.type.color }} />
                <span className="text-xs font-medium text-ink">{b.type.name}</span>
              </div>
              <p className="mt-1 text-lg font-semibold text-ink">
                {b.remaining}
                <span className="ml-1 text-xs font-normal text-ink-soft">
                  of {b.allocated} {b.type.unit.toLowerCase()} left
                </span>
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <select className="o-input w-auto" onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {['TO_APPROVE', 'APPROVED', 'REFUSED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
        <select className="o-input w-auto" onChange={(e) => list.setParam({ timeOffTypeId: e.target.value || undefined })}>
          <option value="">All types</option>
          {(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading requests" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={CalendarClock} title="No time off requests" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Employee</th><th>Type</th><th>From</th><th>To</th>
                    <th className="text-right">Duration</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                      <td className="font-medium text-ink">{r.employee?.name}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ background: r.timeOffType?.color }} />
                          {r.timeOffType?.name}
                        </span>
                      </td>
                      <td>{date(r.dateFrom)}</td>
                      <td>{date(r.dateTo)}</td>
                      <td className="text-right tabular-nums">
                        {r.duration} {r.timeOffType?.unit === 'HOURS' ? 'h' : 'd'}
                      </td>
                      <td><StatusBadge value={r.status} /></td>
                      <td className="text-right">
                        {isHr(role) && r.status === 'TO_APPROVE' && (
                          <ApproveActions request={r} onDone={list.refetch} />
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
        <RequestModal types={types ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); list.refetch(); }} />
      )}
      {detail && <RequestDetail request={detail} onClose={() => setDetail(null)} onChanged={list.refetch} />}
    </>
  );
}

function ApproveActions({ request, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const act = async (e, kind) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.post(`/time-off/requests/${request.id}/${kind}`);
      toast.success(kind === 'approve' ? 'Request approved' : 'Request refused');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-end gap-1">
      <button type="button" disabled={busy} onClick={(e) => act(e, 'approve')}
        className="o-btn-secondary px-2 py-1 text-green-700" title="Approve">
        <Check size={14} />
      </button>
      <button type="button" disabled={busy} onClick={(e) => act(e, 'refuse')}
        className="o-btn-secondary px-2 py-1 text-red-600" title="Refuse">
        <X size={14} />
      </button>
    </div>
  );
}

function RequestModal({ types, onClose, onSaved }) {
  const toast = useToast();
  const { role } = useAuth();
  const { data: employees } = useFetch('/employees', { params: { limit: 200 }, skip: !isHr(role) });
  const [form, setForm] = useState({ timeOffTypeId: '', dateFrom: '', dateTo: '', reason: '', employeeId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      if (!payload.employeeId) delete payload.employeeId;
      if (!payload.reason) delete payload.reason;
      await api.post('/time-off/requests', payload);
      toast.success('Request submitted');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="New Time Off Request" onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="req-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit Request'}
          </button>
        </>
      }>
      <form id="req-form" onSubmit={submit} className="grid gap-3">
        {isHr(role) && (
          <Field label="Employee" hint="Leave blank to file for yourself">
            <select className="o-input" value={form.employeeId} onChange={set('employeeId')}>
              <option value="">Myself</option>
              {(employees?.rows ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Time Off Type" required>
          <select className="o-input" value={form.timeOffTypeId} onChange={set('timeOffTypeId')} required>
            <option value="">Select type</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" required>
            <input type="date" className="o-input" value={form.dateFrom} onChange={set('dateFrom')} required />
          </Field>
          <Field label="To" required>
            <input type="date" className="o-input" value={form.dateTo} onChange={set('dateTo')} required />
          </Field>
        </div>
        <Field label="Reason">
          <textarea className="o-input" rows={2} value={form.reason} onChange={set('reason')} />
        </Field>
        <p className="rounded border border-hairline bg-gray-50 px-2.5 py-1.5 text-xs text-ink-soft">
          Duration counts only days you are scheduled to work, so weekends and non-working days are excluded.
        </p>
        {error && <p className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}

const Row = ({ label, children }) => (
  <div className="flex justify-between border-b border-gray-100 py-2 text-sm">
    <span className="text-ink-soft">{label}</span>
    <span className="font-medium text-ink">{children}</span>
  </div>
);

function RequestDetail({ request, onClose, onChanged }) {
  const { role } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const act = async (kind) => {
    setBusy(true);
    try {
      await api.post(`/time-off/requests/${request.id}/${kind}`);
      toast.success(kind === 'approve' ? 'Approved' : 'Refused');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={`Time Off / ${request.employee?.name}`} onClose={onClose}
      footer={
        isHr(role) && request.status === 'TO_APPROVE' ? (
          <>
            <button type="button" className="o-btn-danger" disabled={busy} onClick={() => act('refuse')}>Refuse</button>
            <button type="button" className="o-btn-primary" disabled={busy} onClick={() => act('approve')}>Approve</button>
          </>
        ) : (
          <button type="button" className="o-btn-secondary" onClick={onClose}>Close</button>
        )
      }>
      <div>
        <Row label="Type">{request.timeOffType?.name}</Row>
        <Row label="From">{date(request.dateFrom)}</Row>
        <Row label="To">{date(request.dateTo)}</Row>
        <Row label="Duration">
          {request.duration} {request.timeOffType?.unit === 'HOURS' ? 'hours' : 'days'}
        </Row>
        <Row label="Status"><StatusBadge value={request.status} /></Row>
        {request.reason && <Row label="Reason">{request.reason}</Row>}
        {request.refusalReason && <Row label="Refusal Reason">{request.refusalReason}</Row>}
        {request.timeOffType?.requiresAllocation && (
          <p className="mt-3 rounded border border-hairline bg-gray-50 px-2.5 py-1.5 text-xs text-ink-soft">
            Approving this request consumes the employee&apos;s {request.timeOffType.name} allocation.
          </p>
        )}
      </div>
    </Modal>
  );
}
