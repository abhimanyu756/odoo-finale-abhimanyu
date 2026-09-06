import { useState } from 'react';
import { Mail, AlertTriangle, Send, Paperclip, CheckCircle2, Info } from 'lucide-react';
import { useFetch } from '../hooks/useApi';
import { Spinner, ErrorState, Modal } from './ui';
import { dateTime } from '../lib/format';

/*
 * Dry run of "Send Payslips".
 *
 * With 87 payslips the useful question is not "what does one email look like"
 * but "who is about to receive mail, and who will not" - so the roster leads and
 * the message body is what you get when you pick a name. The whole set arrives
 * in one request, so switching between recipients is instant.
 *
 * Nothing here sends. Confirming hands off to the existing send flow untouched.
 */
export default function SendPreview({ payrunId, onClose, onConfirm, sending }) {
  const { data, loading, error, refetch } = useFetch(`/payroll/payruns/${payrunId}/send-preview`);
  const [selected, setSelected] = useState(null);

  const recipients = data?.recipients ?? [];
  const current = recipients.find((r) => r.payslipId === selected)
    ?? recipients.find((r) => r.deliverable)
    ?? recipients[0];

  return (
    <Modal
      open
      wide
      title={`Send Payslips — ${data?.payrun?.name ?? ''}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="o-btn-primary"
            disabled={sending || !data?.summary?.deliverable}
            onClick={onConfirm}
          >
            <Send size={14} />
            {sending
              ? 'Sending…'
              : `Send ${data?.summary?.deliverable ?? 0} payslip${data?.summary?.deliverable === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {loading && <Spinner label="Preparing preview" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {data && (
        <>
          {/* What will actually happen, before anything happens. */}
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            {[
              ['Will be sent', data.summary.deliverable, 'text-emerald-700'],
              ['Skipped', data.summary.skipped, data.summary.skipped ? 'text-amber-700' : 'text-ink-soft'],
              ['Already sent once', data.summary.resend, 'text-ink-soft'],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-md border border-hairline bg-gray-50 px-2.5 py-2">
                <p className="text-[11px] text-ink-soft">{label}</p>
                <p className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</p>
              </div>
            ))}
          </div>

          {!data.smtp.configured && (
            <p className="mb-3 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              SMTP credentials are not configured. Sending will render every PDF but
              nothing will leave the server, and no payslip will be marked as sent.
            </p>
          )}
          {data.summary.resend > 0 && (
            <p className="mb-3 flex items-start gap-2 rounded border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-800">
              <Info size={14} className="mt-0.5 shrink-0" />
              {data.summary.resend} payslip(s) were emailed before — sending again delivers a duplicate.
            </p>
          )}

          <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_1fr]">
            {/* Roster: who gets mail, and who does not */}
            <div className="max-h-80 overflow-y-auto rounded border border-hairline">
              {recipients.map((r) => (
                <button
                  key={r.payslipId}
                  type="button"
                  onClick={() => setSelected(r.payslipId)}
                  className={`flex w-full items-start gap-2 border-b border-gray-100 px-2.5 py-2 text-left last:border-0
                    ${r.payslipId === current?.payslipId ? 'bg-odoo-50' : 'hover:bg-gray-50'}`}
                >
                  {r.deliverable
                    ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" />
                    : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />}
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">{r.name}</span>
                    <span className="block truncate text-[11px] text-ink-soft">
                      {r.deliverable ? r.to : r.reason}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {/* The exact message that recipient will receive */}
            {current && (
              <div className="rounded border border-hairline">
                <dl className="border-b border-hairline px-3 py-2 text-xs">
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-soft">To</dt>
                    <dd className="truncate text-ink">{current.to ?? <span className="text-amber-600">{current.reason}</span>}</dd>
                  </div>
                  <div className="mt-1 flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-soft">Subject</dt>
                    <dd className="font-medium text-ink">{current.subject}</dd>
                  </div>
                  <div className="mt-1 flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-soft">Attached</dt>
                    <dd className="flex items-center gap-1 font-mono text-[11px] text-ink">
                      <Paperclip size={11} /> {current.attachment}
                    </dd>
                  </div>
                  {current.alreadySentAt && (
                    <div className="mt-1 flex gap-2">
                      <dt className="w-16 shrink-0 text-ink-soft">Sent</dt>
                      <dd className="text-ink-soft">{dateTime(current.alreadySentAt)}</dd>
                    </div>
                  )}
                </dl>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-sans text-xs leading-relaxed text-ink">
                  {current.text}
                </pre>
              </div>
            )}
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-soft">
            <Mail size={12} />
            This is the exact subject, body and attachment name the send will use.
          </p>
        </>
      )}
    </Modal>
  );
}
