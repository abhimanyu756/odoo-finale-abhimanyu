import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Loader2, Inbox, AlertTriangle, ChevronLeft, ChevronRight, Eye, EyeOff,
  ChevronDown, ChevronsLeft, ChevronsRight, Search, Check,
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

// A drop-in replacement for <select> on lists long enough that scrolling them is
// the slow part - employees, job positions, salary structures. Options are
// `{ value, label, hint }`; include a `value: ''` entry to offer "no selection",
// exactly as an <option value=""> would.
//
// The trigger toggles on mousedown rather than click: these usually sit inside
// <Field>, whose <label> forwards its own clicks to the control it wraps, which
// would otherwise open and immediately re-close the popover.
export function SearchSelect({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  disabled = false,
  required = false,
  className = '',
  id,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const autoId = useId();
  const listId = `${id ?? autoId}-listbox`;

  const current = String(value ?? '');
  const selected = options.find((o) => String(o.value) === current);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        String(o.label).toLowerCase().includes(q)
        || String(o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, query]);

  // Reopening should start from the current selection, not wherever the last
  // search left the cursor.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const i = options.findIndex((o) => String(o.value) === current);
    setActive(i < 0 ? 0 : i);
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (option) => {
    onChange(option.value);
    setOpen(false);
    // Hand focus back to the trigger so Tab continues through the form.
    triggerRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => {
        if (!filtered.length) return 0;
        return (i + step + filtered.length) % filtered.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (!open) { e.preventDefault(); setOpen(true); return; }
      // Enter inside a form must pick an option, not submit the form.
      e.preventDefault();
      if (filtered[active]) commit(filtered[active]);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        id={id ?? autoId}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-required={required || undefined}
        onMouseDown={(e) => {
          e.preventDefault();
          if (!disabled) setOpen((o) => !o);
        }}
        onKeyDown={onKeyDown}
        className="o-input flex items-center justify-between gap-2 text-left"
      >
        <span className={`truncate ${selected && selected.value !== '' ? 'text-ink' : 'text-gray-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={15} className="shrink-0 text-ink-soft" />
      </button>

      {/*
        A <button> cannot be `required`, so a mirror input keeps native form
        validation. It must stay in the layout - a display:none required control
        blocks submission with an unfocusable-control error instead of a bubble.
      */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={current}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          className="pointer-events-none absolute bottom-1 left-2 h-px w-px opacity-0"
        />
      )}

      {open && (
        <div
          // The popover renders inside <Field>'s <label>, which activates its
          // control on any click that is not itself interactive content. That
          // would yank focus out of the search box, so stop the default here.
          onClick={(e) => e.preventDefault()}
          className="absolute z-50 mt-1 w-full min-w-56 overflow-hidden rounded-md border border-hairline bg-white shadow-lg"
        >
          <div className="flex items-center gap-1.5 border-b border-hairline px-2">
            <Search size={14} className="shrink-0 text-ink-soft" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="w-full bg-transparent py-2 text-sm text-ink placeholder:text-gray-400 focus:outline-none"
            />
          </div>

          <ul ref={listRef} id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-ink-soft">No matches</li>
            )}
            {filtered.map((o, i) => {
              const isSelected = String(o.value) === current;
              return (
                <li key={String(o.value)}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(o)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm
                                ${i === active ? 'bg-odoo-50 text-odoo-700' : 'text-ink'}`}
                  >
                    <span className="truncate">
                      {o.label}
                      {o.hint && <span className="ml-1.5 text-xs text-ink-soft">{o.hint}</span>}
                    </span>
                    {isSelected && <Check size={14} className="shrink-0 text-odoo-500" />}
                  </button>
                </li>
              );
            })}
          </ul>

          {options.length > 12 && (
            <div className="border-t border-hairline px-3 py-1.5 text-xs text-ink-soft">
              {filtered.length} of {options.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Page numbers around the current page, with 1 and the last page always
// reachable and '…' standing in for the pages that were dropped.
function pageWindow(page, pages, span = 1) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);

  const keep = new Set([1, pages]);
  for (let i = page - span; i <= page + span; i += 1) {
    if (i >= 1 && i <= pages) keep.add(i);
  }
  // Keep the strip a stable width so the buttons do not shift as you page.
  if (page <= 3) [2, 3, 4].forEach((i) => keep.add(i));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((i) => keep.add(i));

  const out = [];
  let prev = 0;
  for (const n of [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)) {
    if (n - prev > 1) out.push(`gap-${n}`);
    out.push(n);
    prev = n;
  }
  return out;
}

// A page-number box that only commits on Enter or blur, so typing "12" does not
// fire a request for page 1 on the way there.
function PageJump({ page, pages, onPage, label = 'Go to page' }) {
  const [draft, setDraft] = useState(String(page));
  // Resync when the page moves for any other reason - the sibling pager, or a
  // filter change resetting to page 1. Adjusting during render rather than in
  // an effect avoids rendering the stale number first.
  const [seen, setSeen] = useState(page);
  if (seen !== page) {
    setSeen(page);
    setDraft(String(page));
  }

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 1 || n > pages) { setDraft(String(page)); return; }
    if (n !== page) onPage(n);
  };

  return (
    <input
      type="number"
      min={1}
      max={pages}
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') setDraft(String(page));
      }}
      className="o-input w-14 px-1.5 py-0.5 text-center text-xs tabular-nums
                 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none
                 [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

const rangeText = (page, total, limit) => {
  if (!limit) return `${total} record${total === 1 ? '' : 's'}`;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return `${from}\u2013${to} of ${total}`;
};

const navBtn = 'o-btn-secondary px-2 py-1';

// The full pager that sits under a list: a record range, numbered pages, and a
// jump box once the number strip has to start hiding pages.
export function Pagination({ page, pages, total, limit, onPage }) {
  if (!total) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-3 py-2 text-xs text-ink-soft">
      <span className="tabular-nums">{rangeText(page, total, limit)}</span>

      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button type="button" className={navBtn} disabled={page <= 1}
            onClick={() => onPage(1)} aria-label="First page">
            <ChevronsLeft size={14} />
          </button>
          <button type="button" className={navBtn} disabled={page <= 1}
            onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft size={14} />
          </button>

          {pageWindow(page, pages).map((n) =>
            typeof n === 'string' ? (
              <span key={n} className="px-1 text-ink-soft">…</span>
            ) : (
              <button
                key={n}
                type="button"
                aria-label={`Page ${n}`}
                aria-current={n === page ? 'page' : undefined}
                onClick={() => onPage(n)}
                className={`min-w-7 rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors
                  ${n === page
                    ? 'bg-odoo-500 text-white'
                    : 'border border-hairline bg-white text-ink hover:bg-odoo-50'}`}
              >
                {n}
              </button>
            ))}

          <button type="button" className={navBtn} disabled={page >= pages}
            onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight size={14} />
          </button>
          <button type="button" className={navBtn} disabled={page >= pages}
            onClick={() => onPage(pages)} aria-label="Last page">
            <ChevronsRight size={14} />
          </button>

          {pages > 7 && (
            <span className="ml-2 flex items-center gap-1.5">
              Go to
              <PageJump page={page} pages={pages} onPage={onPage} />
              of {pages}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// The compact pager for a page's filter row. A long list otherwise forces a
// scroll to the bottom just to reach the next page.
export function PagerBar({ page, pages, total, limit, onPage }) {
  if (!total || pages <= 1) return null;

  return (
    <div className="ml-auto flex items-center gap-1.5 text-xs text-ink-soft">
      <span className="hidden tabular-nums sm:inline">{rangeText(page, total, limit)}</span>
      <button type="button" className={navBtn} disabled={page <= 1}
        onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft size={14} />
      </button>
      <PageJump page={page} pages={pages} onPage={onPage} />
      <span className="tabular-nums">/ {pages}</span>
      <button type="button" className={navBtn} disabled={page >= pages}
        onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
// A window around the current year is enough for a payroll archive, and it
// keeps the picker a fixed list rather than one query away.
const YEARS = Array.from({ length: 7 }, (_, i) => new Date().getFullYear() + 1 - i);

// The year/month pair every list screen shares. Emits `{ year, month }` as
// strings (or undefined), matching the ?year=&month= the API accepts.
export function PeriodFilter({ year, month, onChange, label = 'Period' }) {
  const set = (patch) => onChange({ year, month, ...patch });

  return (
    <span className="flex items-center gap-1.5" aria-label={label}>
      <SearchSelect
        className="w-auto min-w-28"
        value={year ?? ''}
        // Clearing the year clears the month too: a bare month would span
        // every year at once, which is never what anyone means.
        onChange={(v) => set({ year: v || undefined, month: v ? month : undefined })}
        searchPlaceholder="Search years…"
        options={[{ value: '', label: 'All years' },
          ...YEARS.map((y) => ({ value: String(y), label: String(y) }))]}
      />
      <SearchSelect
        className="w-auto min-w-32"
        value={month ?? ''}
        disabled={!year}
        onChange={(v) => set({ month: v || undefined })}
        searchPlaceholder="Search months…"
        options={[{ value: '', label: 'All months' },
          ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))]}
      />
    </span>
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
