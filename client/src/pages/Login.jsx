import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/api';

const DEMO = [
  ['admin@oxp.com', 'Admin@123', 'Administrator'],
  ['aarav@oxp.com', 'Pass@1234', 'Payroll Admin'],
  ['nisha@oxp.com', 'Pass@1234', 'Payroll User'],
  ['sara@oxp.com', 'Pass@1234', 'HR Manager'],
  ['rohan@oxp.com', 'Pass@1234', 'Employee'],
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-odoo-50 via-canvas to-teal-soft/40 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-odoo-500 text-sm font-bold text-white">
            PP
          </span>
          <h1 className="text-xl font-semibold text-ink">PeoplePay360</h1>
          <p className="text-sm text-ink-soft">HR &amp; Payroll Operations</p>
        </div>

        <form onSubmit={submit} className="o-card p-5 shadow-sm">
          <h2 className="mb-1 text-base font-semibold text-ink">Welcome back</h2>
          <p className="mb-4 text-xs text-ink-soft">Sign in to your work account</p>

          <label className="mb-3 block">
            <span className="o-label">Work Email</span>
            <input
              className="o-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@oxp.com"
              required
            />
          </label>

          <label className="mb-4 block">
            <span className="o-label">Password</span>
            <input
              className="o-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && (
            <p className="mb-3 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
              {error}
            </p>
          )}

          <button type="submit" className="o-btn-primary w-full py-2" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>

          <p className="mt-4 border-t border-hairline pt-3 text-center text-[11px] text-ink-soft">
            Accounts are created by an administrator.
          </p>
        </form>

        <div className="mt-4 rounded-lg border border-hairline bg-white/70 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
            Demo accounts
          </p>
          <div className="grid gap-1">
            {DEMO.map(([e, p, label]) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  setEmail(e);
                  setPassword(p);
                }}
                className="flex items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-odoo-50"
              >
                <span className="font-medium text-ink">{label}</span>
                <span className="text-ink-soft">{e}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
