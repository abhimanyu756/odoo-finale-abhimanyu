import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import AuthLayout from '../components/AuthLayout';
import { PasswordInput } from '../components/ui';

export default function ResetPassword() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const token = sp.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = async (e) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, newPassword: password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2200);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout>
        <div className="o-card p-5 text-center shadow-sm">
          <p className="text-sm text-red-700">This reset link is missing its token.</p>
          <Link to="/forgot-password" className="o-btn-secondary mt-3">Request a new link</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      {done ? (
        <div className="o-card p-5 text-center shadow-sm">
          <ShieldCheck size={22} className="mx-auto mb-2 text-green-600" />
          <h2 className="text-base font-semibold text-ink">Password updated</h2>
          <p className="mt-1 text-xs text-ink-soft">
            All other sessions were signed out. Taking you to sign in…
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="o-card p-5 shadow-sm">
          <h2 className="mb-1 text-base font-semibold text-ink">Set a new password</h2>
          <p className="mb-4 text-xs text-ink-soft">Choose a password of at least 8 characters.</p>

          <label className="mb-3 block">
            <span className="o-label">New Password</span>
            <PasswordInput autoComplete="new-password" minLength={8} required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <label className="mb-4 block">
            <span className="o-label">Confirm Password</span>
            <PasswordInput autoComplete="new-password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {mismatch && <span className="mt-1 block text-xs text-red-600">Passwords do not match</span>}
          </label>

          {error && (
            <p className="mb-3 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>
          )}

          <button type="submit" className="o-btn-primary w-full py-2" disabled={busy || mismatch}>
            {busy ? 'Updating…' : 'Update Password'}
          </button>

          <Link to="/login" className="mt-3 flex items-center justify-center gap-1 text-xs text-ink-soft hover:text-odoo-600">
            <ArrowLeft size={12} /> Back to sign in
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}
