import { useId, useState } from 'react';
import {
  Loader2, Inbox, AlertTriangle, ChevronLeft, ChevronRight, Eye, EyeOff,
} from 'lucide-react';
import { titleCase } from '../lib/format';

// A password field with a reveal toggle. The button is type="button" so it can
// never submit the surrounding form, and it reports its state to screen readers
// rather than relying on the icon alone.
export function PasswordInput({ className = '', ...props }) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  return (
    <div className="relative">
      <input
        {...props}
        id={props.id ?? id}
        type={visible ? 'text' : 'password'}
        className={`o-input pr-9 ${className}`}
      />
      <button
        type="button"
        onClick={(e) => {
          // These fields sit inside <label>, which forwards clicks to the
          // control it wraps; without this the toggle can fire twice.
          e.preventDefault();
          e.stopPropagation();
          setVisible((v) => !v);
        }}
        aria-controls={props.id ?? id}
        aria-pressed={visible}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-md text-ink-soft
                   transition-colors hover:text-odoo-600 focus-visible:outline-2
                   focus-visible:outline-odoo-400"
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

export const Spinner = ({ label = 'Loading' }) => (
  <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-soft">
    <Loader2 className="animate-spin" size={16} />
    {label}…
  </div>
);

export const EmptyState = ({ title = 'Nothing here yet', hint, icon: Icon = Inbox, action }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
    <Icon size={28} className="text-gray-300" />
    <p className="text-sm font-medium text-ink">{title}</p>
    {hint && <p className="max-w-sm text-xs text-ink-soft">{hint}</p>}
    {action}
  </div>
);

export const ErrorState = ({ message, onRetry }) => (
  <div className="flex flex-col items-center gap-2 py-12 text-center">
    <AlertTriangle size={24} className="text-red-400" />
    <p className="text-sm text-red-700">{message}</p>
    {onRetry && (
      <button type="button" className="o-btn-secondary" onClick={onRetry}>
        Try again
      </button>
    )}
  </div>
);

// Status colours are shared across payruns, payslips, leave and contracts so a
// given state always reads the same way wherever it appears.
const STATUS_TONES = {
  ACTIVE: 'bg-green-100 text-green-700',
  RUNNING: 'bg-green-100 text-green-700',
  APPROVED: 'bg-green-100 text-green-700',
  PAID: 'bg-green-100 text-green-700',
  PRESENT: 'bg-green-100 text-green-700',
  VALIDATED: 'bg-teal-soft text-teal-accent',
  COMPUTED: 'bg-blue-100 text-blue-700',
  TO_APPROVE: 'bg-amber-100 text-amber-700',
  LATE: 'bg-amber-100 text-amber-700',
  MISSING_CHECKOUT: 'bg-amber-100 text-amber-700',
  DRAFT: 'bg-gray-100 text-gray-600',
  INACTIVE: 'bg-gray-100 text-gray-600',
  EXPIRED: 'bg-gray-100 text-gray-600',
  CANCELLED: 'bg-gray-100 text-gray-600',
  REFUSED: 'bg-red-100 text-red-700',
  ABSENT: 'bg-red-100 text-red-700',
  ERROR: 'bg-red-100 text-red-700',
  WARNING: 'bg-amber-100 text-amber-700',
  INFO: 'bg-blue-100 text-blue-700',
};

export const StatusBadge = ({ value }) =>
  value ? (
    <span className={`o-badge ${STATUS_TONES[value] ?? 'bg-gray-100 text-gray-600'}`}>
      {titleCase(value)}
    </span>
  ) : (
    <span className="text-ink-soft">—</span>
  );

export const PageHeader = ({ title, subtitle, actions, breadcrumb }) => (
  <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div>
      {breadcrumb}
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const Field = ({ label, children, hint, error, required }) => (
  <label className="block">
    <span className="o-label">
      {label}
      {required && <span className="ml-0.5 text-red-500">*</span>}
    </span>
    {children}
    {hint && !error && <span className="mt-1 block text-xs text-ink-soft">{hint}</span>}
    {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
  </label>
);

export function Pagination({ page, pages, total, onPage }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-hairline px-3 py-2 text-xs text-ink-soft">
      <span>
        Page {page} of {pages} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          className="o-btn-secondary px-2 py-1"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          className="o-btn-secondary px-2 py-1"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8">
      <div className={`o-card w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} shadow-xl`}>
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button type="button" className="o-btn-ghost px-2 py-1" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

// Smart buttons on the employee form: a count above a label, per the mockup.
export const SmartButton = ({ label, count, onClick, icon: Icon }) => (
  <button
    type="button"
    onClick={onClick}
    className="o-card flex min-w-28 items-center gap-2 px-3 py-2 text-left transition-colors hover:border-odoo-300 hover:bg-odoo-50"
  >
    {Icon && <Icon size={16} className="text-odoo-500" />}
    <span>
      <span className="block text-base font-semibold leading-tight text-ink">{count ?? 0}</span>
      <span className="block text-xs text-ink-soft">{label}</span>
    </span>
  </button>
);
