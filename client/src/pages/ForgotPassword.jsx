import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import AuthLayout from '../components/AuthLayout';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      {sent ? (
        <div className="o-card p-5 shadow-sm">
          <MailCheck size={22} className="mb-2 text-teal-accent" />
          <h2 className="mb-1 text-base font-semibold text-ink">Check your inbox</h2>
          <p className="text-xs text-ink-soft">{sent.message}</p>
          <p className="mt-2 text-xs text-ink-soft">The link expires in 30 minutes.</p>

          {/* Shown only when SMTP is unconfigured, so the flow stays testable */}
          {sent.devResetLink && (
            <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-2.5">
              <p className="text-[11px] font-semibold text-amber-800">
                Development mode — no email was actually sent
              </p>
              <a href={sent.devResetLink} className="mt-1 block break-all text-[11px] text-amber-900 underline">
                {sent.devResetLink}
              </a>
            </div>
          )}

          <Link to="/login" className="o-btn-secondary mt-4 w-full">
            <ArrowLeft size={14} /> Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="o-card p-5 shadow-sm">
          <h2 className="mb-1 text-base font-semibold text-ink">Forgot your password?</h2>
          <p className="mb-4 text-xs text-ink-soft">
            Enter your work email and we&apos;ll send you a link to set a new one.
          </p>

          <label className="mb-4 block">
            <span className="o-label">Work Email</span>
            <input className="o-input" type="email" autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </label>

          {error && (
            <p className="mb-3 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>
          )}

          <button type="submit" className="o-btn-primary w-full py-2" disabled={busy}>
            {busy ? 'Sending…' : 'Send Reset Link'}
          </button>

          <Link to="/login" className="mt-3 flex items-center justify-center gap-1 text-xs text-ink-soft hover:text-odoo-600">
            <ArrowLeft size={12} /> Back to sign in
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}
