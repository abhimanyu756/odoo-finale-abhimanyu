import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/api';
import AuthLayout from '../components/AuthLayout';
import { PasswordInput } from '../components/ui';

const DEMO = [
  ['admin@odoo.com', 'Admin@123', 'Administrator'],
  ['aarav@odoo.com', 'Pass@1234', 'Payroll Admin'],
  ['nisha@odoo.com', 'Pass@1234', 'Payroll User'],
  ['sara@odoo.com', 'Pass@1234', 'HR Manager'],
  ['rohan@odoo.com', 'Pass@1234', 'Employee'],
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
    <AuthLayout>
      <>
        <form onSubmit={submit} className="o-card p-5 shadow-sm">
          <h2 className="mb-1 text-base font-semibold text-ink">Welcome back</h2>
          <p className="mb-4 text-xs text-ink-soft">Sign in to continue to your workspace.</p>

          <label className="mb-3 block">
            <span className="o-label">Work Email</span>
            <input
              className="o-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@odoo.com"
              required
            />
          </label>

          <label className="mb-1 block">
            <span className="o-label">Password</span>
            <PasswordInput
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          <div className="mb-4 text-right">
            <Link to="/forgot-password" className="text-xs text-odoo-600 hover:underline">
              Forgot password?
            </Link>
          </div>

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
      </>
    </AuthLayout>
  );
}
