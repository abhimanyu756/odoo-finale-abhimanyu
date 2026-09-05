import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useFetch } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { Modal, Field } from './ui';
import { titleCase } from '../lib/format';

export default function EmployeeCreateModal({ onClose, onCreated }) {
  const toast = useToast();
  const { data: companies } = useFetch('/org/companies');
  const { data: depts } = useFetch('/org/departments');
  const { data: positions } = useFetch('/org/job-positions');
  const { data: schedules } = useFetch('/working-schedules', { params: { limit: 100 } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    firstName: '', lastName: '', workEmail: '',
    employeeType: 'FULL_TIME', departmentId: '', jobPositionId: '',
    workingScheduleId: '', workLocation: '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        companyId: companies?.[0]?.id,
        // Empty selects must be omitted rather than sent as "".
        departmentId: form.departmentId || null,
        jobPositionId: form.jobPositionId || null,
        workingScheduleId: form.workingScheduleId || null,
        workLocation: form.workLocation || null,
      };
      const { data } = await api.post('/employees', payload);
      toast.success(`${data.name} created`);
      onCreated(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New Employee"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="emp-create" className="o-btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create Employee'}
          </button>
        </>
      }
    >
      <form id="emp-create" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="First Name" required>
          <input className="o-input" value={form.firstName} onChange={set('firstName')} required />
        </Field>
        <Field label="Last Name" required>
          <input className="o-input" value={form.lastName} onChange={set('lastName')} required />
        </Field>
        <Field label="Work Email" required>
          <input className="o-input" type="email" value={form.workEmail} onChange={set('workEmail')} required />
        </Field>
        <Field label="Employee Type">
          <select className="o-input" value={form.employeeType} onChange={set('employeeType')}>
            {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => (
              <option key={t} value={t}>{titleCase(t)}</option>
            ))}
          </select>
        </Field>
        <Field label="Department">
          <select className="o-input" value={form.departmentId} onChange={set('departmentId')}>
            <option value="">—</option>
            {(depts ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Job Position">
          <select className="o-input" value={form.jobPositionId} onChange={set('jobPositionId')}>
            <option value="">—</option>
            {(positions ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Working Schedule">
          <select className="o-input" value={form.workingScheduleId} onChange={set('workingScheduleId')}>
            <option value="">—</option>
            {(schedules?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Work Location">
          <input className="o-input" value={form.workLocation} onChange={set('workLocation')} />
        </Field>

        {error && (
          <p className="sm:col-span-2 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
