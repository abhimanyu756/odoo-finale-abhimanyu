import { useMemo, useState } from 'react';
import { Plus, Trash2, CalendarRange, Search } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { titleCase, timeZoneOptions, localTimeZone } from '../lib/format';
import {
  PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, Modal, Field, PagerBar,
  SearchSelect,
} from '../components/ui';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const parseHHMM = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h + (m || 0) / 60;
};
const lineHours = (l) =>
  Math.max(0, parseHHMM(l.endTime) - parseHHMM(l.startTime) - Number(l.breakHours || 0));

export default function WorkingSchedules() {
  const list = useList('/working-schedules', { limit: 50 });
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Working Schedules"
        subtitle="Weekly patterns used by attendance, time off and payroll"
        actions={
          <button type="button" className="o-btn-primary" onClick={() => setEditing({ lines: [] })}>
            <Plus size={15} /> New Schedule
          </button>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search schedules…"
            value={list.params.search ?? ''}
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <select
          className="o-input w-auto"
          value={list.params.scheduleType ?? ''}
          onChange={(e) => list.setParam({ scheduleType: e.target.value || undefined })}
          aria-label="Filter by schedule type"
        >
          <option value="">All types</option>
          {['FULL_TIME', 'PART_TIME', 'FLEXIBLE'].map((t) => (
            <option key={t} value={t}>{titleCase(t)}</option>
          ))}
        </select>
        <select
          className="o-input w-auto"
          value={list.params.status ?? ''}
          onChange={(e) => list.setParam({ status: e.target.value || undefined })}
          aria-label="Filter by status"
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading schedules" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? (
            <EmptyState icon={CalendarRange} title="No schedules match these filters"
              hint="Clear the search or filters, or create a new schedule." />
          )
          : (
            <table className="o-table">
              <thead>
                <tr>
                  <th>Schedule Name</th><th>Type</th>
                  <th className="text-right">Days / Week</th><th className="text-right">Hours / Week</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((s) => (
                  <tr key={s.id} className="cursor-pointer" onClick={() => setEditing(s)}>
                    <td className="font-medium text-ink">{s.name}</td>
                    <td>{titleCase(s.scheduleType)}</td>
                    <td className="text-right tabular-nums">{s.daysPerWeek}</td>
                    <td className="text-right font-medium tabular-nums">{s.hoursPerWeek}h</td>
                    <td><StatusBadge value={s.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <Pagination page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <p className="mt-3 text-xs text-ink-soft">
        Select a schedule to open its form view. Weekly hours are derived from the day
        rows, never entered by hand.
      </p>

      {editing && (
        <ScheduleModal schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.refetch(); }} />
      )}
    </>
  );
}

function ScheduleModal({ schedule, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !schedule.id;
  const [form, setForm] = useState({
    name: schedule.name ?? '',
    scheduleType: schedule.scheduleType ?? 'FULL_TIME',
    timezone: schedule.timezone ?? 'Asia/Kolkata',
    isActive: schedule.isActive ?? true,
  });
  // Built once and reused: enumerating and offset-formatting 400+ zones on every
  // keystroke would make the search feel sluggish.
  const zoneOptions = useMemo(() => {
    const all = timeZoneOptions();
    const local = localTimeZone();
    const mine = all.find((z) => z.value === local);
    // The current value may be a zone this browser does not enumerate; keep it
    // so opening an existing schedule never silently blanks the field.
    const current = all.some((z) => z.value === form.timezone)
      ? null
      : { value: form.timezone, label: form.timezone, hint: 'saved value' };
    return [
      ...(current ? [current] : []),
      ...(mine ? [{ ...mine, label: `${mine.label} (your timezone)` }] : []),
      ...all.filter((z) => z.value !== local),
    ];
  }, [form.timezone]);

  const [lines, setLines] = useState(
    (schedule.lines ?? []).map((l) => ({
      dayOfWeek: l.dayOfWeek, startTime: l.startTime, endTime: l.endTime,
      breakHours: Number(l.breakHours ?? 0),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The weekly total is derived live so the form matches what the server stores.
  const total = lines.reduce((s, l) => s + lineHours(l), 0);
  const usedDays = new Set(lines.map((l) => l.dayOfWeek));
  const nextFreeDay = [0, 1, 2, 3, 4, 5, 6].find((d) => !usedDays.has(d));

  const setLine = (i, patch) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, lines };
      if (isNew) await api.post('/working-schedules', payload);
      else await api.put(`/working-schedules/${schedule.id}`, payload);
      toast.success(isNew ? 'Schedule created' : 'Schedule updated');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${schedule.name}"?`)) return;
    try {
      await api.delete(`/working-schedules/${schedule.id}`);
      toast.success('Schedule deleted');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Modal
      open wide
      title={isNew ? 'New Working Schedule' : schedule.name}
      onClose={onClose}
      footer={
        <>
          {!isNew && <button type="button" className="o-btn-danger mr-auto" onClick={remove}>Delete</button>}
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="sched-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="sched-form" onSubmit={submit}>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Field label="Schedule Name" required>
            <input className="o-input" value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
          <Field label="Type">
            <select className="o-input" value={form.scheduleType}
              onChange={(e) => setForm((f) => ({ ...f, scheduleType: e.target.value }))}>
              {['FULL_TIME', 'PART_TIME', 'FLEXIBLE'].map((t) => (
                <option key={t} value={t}>{titleCase(t)}</option>
              ))}
            </select>
          </Field>
          <Field label="Timezone" hint="Start and end times below are read in this zone">
            <SearchSelect
              value={form.timezone}
              onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
              placeholder="Select a timezone"
              searchPlaceholder="Search 400+ zones…"
              options={zoneOptions}
            />
          </Field>
        </div>

        <label className="mb-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
          Active
          <span className="text-xs text-ink-soft">
            — inactive schedules stay assigned but are hidden from new selections
          </span>
        </label>

        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Weekly Schedule</h3>
          <button type="button" className="o-btn-secondary"
            disabled={nextFreeDay === undefined}
            onClick={() => setLines((ls) => [...ls, { dayOfWeek: nextFreeDay, startTime: '09:00', endTime: '18:00', breakHours: 1 }])}>
            <Plus size={14} /> Add Day
          </button>
        </div>

        <div className="overflow-hidden rounded-md border border-hairline">
          <table className="o-table">
            <thead>
              <tr><th>Day</th><th>Start Time</th><th>End Time</th><th>Break (h)</th><th className="text-right">Hours</th><th /></tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-ink-soft">
                  No days yet — add one to build the weekly pattern.
                </td></tr>
              )}
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select className="o-input" value={l.dayOfWeek}
                      onChange={(e) => setLine(i, { dayOfWeek: Number(e.target.value) })}>
                      {DAYS.map((d, idx) => (
                        <option key={d} value={idx}
                          disabled={usedDays.has(idx) && idx !== l.dayOfWeek}>{d}</option>
                      ))}
                    </select>
                  </td>
                  <td><input type="time" className="o-input" value={l.startTime}
                    onChange={(e) => setLine(i, { startTime: e.target.value })} /></td>
                  <td><input type="time" className="o-input" value={l.endTime}
                    onChange={(e) => setLine(i, { endTime: e.target.value })} /></td>
                  <td><input type="number" step="0.25" min="0" className="o-input w-20" value={l.breakHours}
                    onChange={(e) => setLine(i, { breakHours: Number(e.target.value) })} /></td>
                  <td className="text-right font-medium tabular-nums">{lineHours(l).toFixed(2)}h</td>
                  <td className="text-right">
                    <button type="button" className="o-btn-ghost px-1.5 py-1"
                      onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50">
                <td colSpan={4} className="px-3 py-2 text-right text-sm font-medium text-ink">Total Weekly Hours</td>
                <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums text-odoo-600">
                  {total.toFixed(2)}h
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {error && <p className="mt-3 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
