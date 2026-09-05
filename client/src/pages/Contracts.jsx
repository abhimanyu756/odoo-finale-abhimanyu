import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, FileText } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { money, date } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field, SearchSelect, PagerBar } from '../components/ui';

const STATUSES = ['DRAFT', 'RUNNING', 'EXPIRED', 'CANCELLED'];

export default function Contracts() {
  const [sp] = useSearchParams();
  const employeeId = sp.get('employeeId') ?? undefined;
  const list = useList('/contracts', { employeeId });
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Contracts"
        subtitle="Contract history; payroll uses the contract running in the period"
        actions={
          <button type="button" className="o-btn-primary" onClick={() => setEditing({})}>
            <Plus size={15} /> New
          </button>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search contracts…"
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <select className="o-input w-auto" onChange={(e) => list.setParam({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
        </select>
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading contracts" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={FileText} title="No contracts" hint="Create a contract to enable payroll for an employee." />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Contract</th><th>Employee</th><th>Start</th><th>End</th>
                    <th className="text-right">Wage / Month</th><th>Structure</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((c) => (
                    <tr key={c.id} className="cursor-pointer" onClick={() => setEditing(c)}>
                      <td className="font-medium text-ink">{c.reference}</td>
                      <td>{c.employee?.name}</td>
                      <td>{date(c.startDate)}</td>
                      <td>{c.endDate ? date(c.endDate) : <span className="text-ink-soft">—</span>}</td>
                      <td className="text-right font-medium tabular-nums">{money(c.wage)}</td>
                      <td className="text-ink-soft">{c.salaryStructure?.name ?? '—'}</td>
                      <td><StatusBadge value={c.status} /></td>
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
        <ContractModal
          contract={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.refetch(); }}
        />
      )}
    </>
  );
}

function ContractModal({ contract, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !contract.id;
  const { data: employees } = useFetch('/employees', { params: { limit: 1000 } });
  const { data: depts } = useFetch('/org/departments');
  const { data: positions } = useFetch('/org/job-positions');
  const { data: schedules } = useFetch('/working-schedules', { params: { limit: 100 } });
  const { data: structures } = useFetch('/salary/structures', { params: { limit: 100 } });

  const [form, setForm] = useState({
    name: contract.name ?? '', employeeId: contract.employee?.id ?? '',
    startDate: contract.startDate?.slice(0, 10) ?? '', endDate: contract.endDate?.slice(0, 10) ?? '',
    wage: contract.wage ?? '', status: contract.status ?? 'DRAFT',
    departmentId: contract.department?.id ?? '', jobPositionId: contract.jobPosition?.id ?? '',
    workingScheduleId: contract.workingSchedule?.id ?? '', salaryStructureId: contract.salaryStructure?.id ?? '',
    notes: contract.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v]));
      if (isNew) await api.post('/contracts', payload);
      else await api.patch(`/contracts/${contract.id}`, payload);
      toast.success(isNew ? 'Contract created' : 'Contract updated');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open wide
      title={isNew ? 'New Contract' : `Contract / ${contract.reference}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="contract-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="contract-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Contract Name" required>
          <input className="o-input" value={form.name} onChange={set('name')} required />
        </Field>
        <Field label="Employee" required>
          <SearchSelect
            required
            disabled={!isNew}
            value={form.employeeId}
            onChange={(v) => setForm((f) => ({ ...f, employeeId: v }))}
            placeholder="Select employee"
            searchPlaceholder="Search by name or email…"
            options={[{ value: '', label: 'Select employee' },
              ...(employees?.rows ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.workEmail }))]}
          />
        </Field>
        <Field label="Start Date" required>
          <input type="date" className="o-input" value={form.startDate} onChange={set('startDate')} required />
        </Field>
        <Field label="End Date" hint="Leave blank for an open-ended contract">
          <input type="date" className="o-input" value={form.endDate ?? ''} onChange={set('endDate')} />
        </Field>
        <Field label="Wage / Month" required>
          <input type="number" step="0.01" className="o-input" value={form.wage} onChange={set('wage')} required />
        </Field>
        <Field label="Status" hint="Only one Running contract per period is allowed">
          <select className="o-input" value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Department">
          <SearchSelect
            value={form.departmentId ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, departmentId: v }))}
            placeholder="—"
            searchPlaceholder="Search departments…"
            options={[{ value: '', label: '—' },
              ...(depts ?? []).map((d) => ({ value: d.id, label: d.name }))]}
          />
        </Field>
        <Field label="Job Position">
          <SearchSelect
            value={form.jobPositionId ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, jobPositionId: v }))}
            placeholder="—"
            searchPlaceholder="Search positions…"
            options={[{ value: '', label: '—' },
              ...(positions ?? []).map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Field>
        <Field label="Working Schedule">
          <SearchSelect
            value={form.workingScheduleId ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, workingScheduleId: v }))}
            placeholder="—"
            searchPlaceholder="Search schedules…"
            options={[{ value: '', label: '—' },
              ...(schedules?.rows ?? []).map((s) => ({ value: s.id, label: s.name }))]}
          />
        </Field>
        <Field label="Salary Structure">
          <SearchSelect
            value={form.salaryStructureId ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, salaryStructureId: v }))}
            placeholder="—"
            searchPlaceholder="Search structures…"
            options={[{ value: '', label: '—' },
              ...(structures?.rows ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.code }))]}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <textarea className="o-input" rows={2} value={form.notes ?? ''} onChange={set('notes')} />
          </Field>
        </div>
        {error && (
          <p className="sm:col-span-2 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>
        )}
      </form>
    </Modal>
  );
}
