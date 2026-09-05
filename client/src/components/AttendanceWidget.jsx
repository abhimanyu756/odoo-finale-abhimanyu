import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { time } from '../lib/format';

// Rounding minutes independently of hours produced "0h60" at 0.999h, and a
// session under a minute read as "0h00". Resolve to whole minutes first, and
// fall back to seconds so a brief session is still visible.
const asDuration = (hours, zero = '—') => {
  const totalMinutes = Math.floor((hours ?? 0) * 60);
  if (totalMinutes < 1) {
    const seconds = Math.floor((hours ?? 0) * 3600);
    return seconds > 0 ? `${seconds}s` : zero;
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

// Mirrors the mockup: a green dot when checked in, elapsed time since the open
// session, today's total, and a single Check In / Check Out action.
export default function AttendanceWidget({ onClose }) {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const load = async () => {
    try {
      const { data } = await api.get('/attendance/me/status');
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Ticks the elapsed counter without re-polling the server.
  useEffect(() => {
    if (!status?.checkedIn) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status?.checkedIn]);

  const act = async () => {
    setBusy(true);
    try {
      const path = status?.checkedIn ? '/attendance/me/check-out' : '/attendance/me/check-in';
      await api.post(path);
      toast.success(status?.checkedIn ? 'Checked out' : 'Checked in');
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const live = status?.checkedIn
    ? (now - new Date(status.since).getTime()) / 3_600_000
    : 0;

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        className="absolute right-4 top-16 w-80 rounded-lg border border-hairline bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between rounded-t-lg border-b border-hairline bg-odoo-50 px-4 py-2.5">
          <span className="text-sm font-semibold text-odoo-600">Attendance</span>
          <span
            className={`h-2.5 w-2.5 rounded-full ${status?.checkedIn ? 'bg-green-500' : 'bg-gray-300'}`}
            title={status?.checkedIn ? 'Checked in' : 'Not checked in'}
          />
        </div>

        <div className="px-4 py-4">
          <p className="text-xs text-ink-soft">Welcome back</p>
          <p className="mb-4 text-lg font-semibold text-ink">
            {user?.employee?.name ?? user?.email}
          </p>

          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-gray-100 py-2 text-sm">
                <span className="text-ink-soft">
                  {status?.checkedIn ? `${time(status.since)} — Now` : 'Not checked in'}
                </span>
                <span className="font-medium tabular-nums text-ink">
                  {status?.checkedIn ? asDuration(live) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-ink-soft">Today</span>
                <span className="font-medium tabular-nums text-ink">
                  {asDuration((status?.todayHours ?? 0) + (status?.checkedIn ? live : 0), '0m')}
                </span>
              </div>

              <button
                type="button"
                onClick={act}
                disabled={busy}
                className={`mt-3 w-full ${status?.checkedIn ? 'o-btn-danger' : 'o-btn-primary'} py-2`}
              >
                {busy ? 'Working…' : status?.checkedIn ? 'Check Out' : 'Check In'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
