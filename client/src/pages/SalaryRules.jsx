import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, Calculator, CheckCircle2, XCircle, Search, HelpCircle, ChevronDown,
} from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isPayrollAdmin } from '../lib/roles';
import { money, titleCase } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Modal, Field, SearchSelect } from '../components/ui';

const CATEGORY_TONES = {
  BASIC: 'bg-odoo-100 text-odoo-700',
  ALLOWANCE: 'bg-teal-soft text-teal-accent',
  GROSS: 'bg-blue-100 text-blue-700',
  DEDUCTION: 'bg-red-100 text-red-700',
  NET: 'bg-green-100 text-green-700',
};

export default function SalaryRules() {
  const [sp] = useSearchParams();
  const { role } = useAuth();
  const structureId = sp.get('structureId') ?? undefined;
  const list = useList('/salary/rules', { limit: 100, structureId });
  const { data: structures } = useFetch('/salary/structures', { params: { limit: 100 } });
  const { data: meta } = useFetch('/salary/rules-meta');
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Salary Rules"
        subtitle="Rules run in ascending sequence; later totals build on earlier ones"
        actions={
          isPayrollAdmin(role) && (
            <button type="button" className="o-btn-primary"
              onClick={() => setEditing({ structureId: structureId ?? structures?.rows?.[0]?.id })}>
              <Plus size={15} /> New Rule
            </button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search salary rules…"
            value={list.params.search ?? ''}
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <SearchSelect
          className="w-auto min-w-48"
          value={list.params.structureId ?? ''}
          onChange={(v) => list.setParam({ structureId: v || undefined })}
          searchPlaceholder="Search structures…"
          options={[{ value: '', label: 'All structures' },
            ...(structures?.rows ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.code }))]}
        />
        <select className="o-input w-auto" value={list.params.category ?? ''}
          onChange={(e) => list.setParam({ category: e.target.value || undefined })}>
          <option value="">All categories</option>
          {(meta?.categories ?? []).map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
        </select>
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading rules" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={Calculator} title="No salary rules" />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th className="w-16 text-right">Seq</th><th>Rule Name</th><th>Code</th>
                    <th>Category</th><th>Structure</th><th>Computation</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer" onClick={() => setEditing(r)}>
                      <td className="text-right tabular-nums text-ink-soft">{r.sequence}</td>
                      <td className="font-medium text-ink">{r.name}</td>
                      <td className="font-mono text-xs text-ink-soft">{r.code}</td>
                      <td>
                        <span className={`o-badge ${CATEGORY_TONES[r.category]}`}>{titleCase(r.category)}</span>
                      </td>
                      <td className="text-ink-soft">{r.structure?.name}</td>
                      <td className="text-xs">
                        {r.computeType === 'FIXED' && <span>Fixed {money(r.amount)}</span>}
                        {r.computeType === 'PERCENTAGE' && (
                          <span>{r.percentage}% of {titleCase(r.baseExpr ?? 'WAGE')}</span>
                        )}
                        {r.computeType === 'FORMULA' && (
                          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-ink">
                            {r.expression}
                          </code>
                        )}
                        {r.quantity !== 1 && <span className="ml-1 text-ink-soft">× {r.quantity}</span>}
                      </td>
                      <td><StatusBadge value={r.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {editing && (
        <RuleModal rule={editing} structures={structures?.rows ?? []} meta={meta}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.refetch(); }} />
      )}
    </>
  );
}

function RuleModal({ rule, structures, meta, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !rule.id;
  const [form, setForm] = useState({
    structureId: rule.structureId ?? rule.structure?.id ?? '',
    name: rule.name ?? '', code: rule.code ?? '',
    category: rule.category ?? 'ALLOWANCE', sequence: rule.sequence ?? 10,
    computeType: rule.computeType ?? 'FIXED',
    amount: rule.amount ?? '', percentage: rule.percentage ?? '',
    baseExpr: rule.baseExpr ?? 'WAGE', expression: rule.expression ?? '',
    condition: rule.condition ?? '', quantity: rule.quantity ?? 1,
    isActive: rule.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [check, setCheck] = useState(null);
  const [condCheck, setCondCheck] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Validate the expression against the server's sample context as it is typed,
  // so an author sees the result before the rule ever reaches a payrun.
  useEffect(() => {
    if (form.computeType !== 'FORMULA' || !form.expression.trim()) {
      setCheck(null);
      return undefined;
    }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post('/salary/rules/validate', { expression: form.expression });
        setCheck(data);
      } catch (err) {
        setCheck({ valid: false, error: errorMessage(err) });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [form.expression, form.computeType]);

  // A broken condition silently skips the rule at payrun time, so it gets the
  // same live check the expression does.
  useEffect(() => {
    if (!form.condition.trim()) {
      setCondCheck(null);
      return undefined;
    }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post('/salary/rules/validate', {
          expression: form.condition, kind: 'condition',
        });
        setCondCheck(data);
      } catch (err) {
        setCondCheck({ valid: false, error: errorMessage(err) });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [form.condition]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        amount: form.computeType === 'FIXED' ? Number(form.amount) : null,
        percentage: form.computeType === 'PERCENTAGE' ? Number(form.percentage) : null,
        baseExpr: form.computeType === 'PERCENTAGE' ? form.baseExpr : null,
        expression: form.computeType === 'FORMULA' ? form.expression : null,
        condition: form.condition || null,
        quantity: Number(form.quantity) || 1,
        sequence: Number(form.sequence),
      };
      if (isNew) await api.post('/salary/rules', payload);
      else await api.patch(`/salary/rules/${rule.id}`, payload);
      toast.success('Rule saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await api.delete(`/salary/rules/${rule.id}`);
      toast.success('Rule deleted');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Modal open wide title={isNew ? 'New Salary Rule' : `Salary Rule / ${rule.name}`} onClose={onClose}
      footer={
        <>
          {!isNew && <button type="button" className="o-btn-danger mr-auto" onClick={remove}>Delete</button>}
          <button type="button" className="o-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="rule-form" className="o-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      <form id="rule-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Rule Name" required>
          <input className="o-input" value={form.name} onChange={set('name')} required />
        </Field>
        <Field label="Salary Structure" required>
          <SearchSelect
            required
            value={form.structureId}
            onChange={(v) => setForm((f) => ({ ...f, structureId: v }))}
            placeholder="Select structure"
            searchPlaceholder="Search structures…"
            options={[{ value: '', label: 'Select structure' },
              ...structures.map((s) => ({ value: s.id, label: s.name, hint: s.code }))]}
          />
        </Field>
        <Field label="Code" required hint="Referenced by other rules as rules.CODE">
          <input className="o-input font-mono uppercase" value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} required />
        </Field>
        <Field label="Category" required>
          <select className="o-input" value={form.category} onChange={set('category')}>
            {(meta?.categories ?? []).map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </select>
        </Field>
        <Field label="Sequence" required hint="Lower runs first">
          <input type="number" className="o-input" value={form.sequence} onChange={set('sequence')} required />
        </Field>
        <Field label="Quantity" hint="Multiplier applied to the result">
          <input type="number" step="0.5" className="o-input" value={form.quantity} onChange={set('quantity')} />
        </Field>

        <div className="sm:col-span-2 rounded-md border border-hairline p-3">
          <Field label="Computation">
            <select className="o-input" value={form.computeType} onChange={set('computeType')}>
              <option value="FIXED">Fixed Amount</option>
              <option value="PERCENTAGE">Percentage of a base</option>
              <option value="FORMULA">Formula / Expression</option>
            </select>
          </Field>

          {form.computeType === 'FIXED' && (
            <div className="mt-3">
              <Field label="Amount" required>
                <input type="number" step="0.01" className="o-input" value={form.amount} onChange={set('amount')} required />
              </Field>
            </div>
          )}

          {form.computeType === 'PERCENTAGE' && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Percentage" required>
                <input type="number" step="0.001" className="o-input" value={form.percentage} onChange={set('percentage')} required />
              </Field>
              <Field label="Base">
                <select className="o-input" value={form.baseExpr} onChange={set('baseExpr')}>
                  {(meta?.percentBases ?? ['WAGE', 'BASIC', 'GROSS', 'NET']).map((b) => (
                    <option key={b} value={b}>
                      {b === 'WAGE' ? 'Contract Wage' : `${titleCase(b)} Salary`}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {form.computeType === 'FORMULA' && (
            <div className="mt-3">
              <Field label="Expression" required
                hint="e.g. categories['BASIC'] * 0.4  or  min(categories.BASIC * 0.12, 1800)">
                <textarea className="o-input font-mono text-xs" rows={2}
                  value={form.expression} onChange={set('expression')} required />
              </Field>
              {check && (
                <div className={`mt-2 flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${
                  check.valid ? 'border-green-200 bg-green-50 text-green-800'
                              : 'border-red-200 bg-red-50 text-red-700'}`}>
                  {check.valid ? <CheckCircle2 size={14} className="mt-0.5" /> : <XCircle size={14} className="mt-0.5" />}
                  <span>
                    {check.valid
                      ? `Valid — evaluates to ${money(check.sample, true)} against sample data`
                      : check.error}
                  </span>
                </div>
              )}
              <ExpressionHelp
                meta={meta}
                open={helpOpen}
                onToggle={() => setHelpOpen((v) => !v)}
                examples={meta?.examples}
                onInsert={(code) => setForm((f) => ({ ...f, expression: code }))}
              />
            </div>
          )}
        </div>

        <div className="sm:col-span-2">
          <Field label="Condition"
            hint="Optional. Leave empty and the rule always applies. Otherwise the rule is skipped entirely whenever this is false.">
            <input className="o-input font-mono text-xs" value={form.condition} onChange={set('condition')}
              placeholder="worked_days >= 20" />
          </Field>

          {condCheck && (
            <div className={`mt-2 flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${
              !condCheck.valid ? 'border-red-200 bg-red-50 text-red-700'
                : condCheck.passes ? 'border-green-200 bg-green-50 text-green-800'
                : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
              {condCheck.valid ? <CheckCircle2 size={14} className="mt-0.5" /> : <XCircle size={14} className="mt-0.5" />}
              <span>
                {!condCheck.valid ? condCheck.error
                  : condCheck.passes
                    ? 'Valid — true for the sample employee, so the rule would apply'
                    : 'Valid — false for the sample employee, so the rule would be skipped'}
              </span>
            </div>
          )}

          {meta?.conditionExamples && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {meta.conditionExamples.map((ex) => (
                <button key={ex.code} type="button" title={ex.code}
                  onClick={() => setForm((f) => ({ ...f, condition: ex.code }))}
                  className="rounded border border-hairline bg-white px-2 py-0.5 text-[11px] text-ink-soft hover:bg-odoo-50 hover:text-odoo-700">
                  {ex.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
          Active
        </label>

        {error && (
          <p className="sm:col-span-2 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>
        )}
      </form>
    </Modal>
  );
}

// The reference an author needs while writing a formula: what each variable
// means, what it will hold, and a set of working starting points. Collapsed by
// default so it does not crowd the form once you know the vocabulary.
function ExpressionHelp({ meta, open, onToggle, examples, onInsert }) {
  if (!meta) return null;

  return (
    <div className="mt-3 rounded-md border border-hairline bg-gray-50">
      <button type="button" onClick={onToggle}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-xs font-medium text-ink">
        <span className="flex items-center gap-1.5">
          <HelpCircle size={13} className="text-odoo-500" />
          What can I write here?
        </span>
        <ChevronDown size={14} className={`text-ink-soft transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-hairline px-2.5 py-2 text-[11px]">
          <p className="mb-2 text-ink-soft">
            An expression is plain arithmetic over the values below. It must produce a
            number. Write the amount only — no <code className="font-mono">result =</code> needed,
            though it is accepted.
          </p>

          <p className="mb-1 font-semibold text-ink">Start from an example</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(examples ?? []).map((ex) => (
              <button key={ex.code} type="button" title={ex.code} onClick={() => onInsert(ex.code)}
                className="rounded border border-hairline bg-white px-2 py-0.5 text-ink-soft hover:bg-odoo-50 hover:text-odoo-700">
                {ex.label}
              </button>
            ))}
          </div>

          <p className="mb-1 font-semibold text-ink">
            Values you can use
            <span className="ml-1 font-normal text-ink-soft">
              (sample column shows what the live check tests against)
            </span>
          </p>
          <div className="mb-3 max-h-52 overflow-y-auto rounded border border-hairline bg-white">
            <table className="w-full">
              <tbody>
                {(meta.reference ?? []).map((v) => (
                  <tr key={v.name} className="border-b border-gray-100 last:border-0">
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-odoo-700">{v.name}</td>
                    <td className="px-2 py-1 text-ink-soft">{v.about}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-ink">
                      {v.sample ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mb-1 font-semibold text-ink">Functions</p>
          <ul className="mb-3 grid gap-0.5 sm:grid-cols-2">
            {(meta.functionHelp ?? []).map((f) => (
              <li key={f.name} className="text-ink-soft">
                <code className="font-mono text-odoo-700">{f.name}</code> — {f.about}
              </li>
            ))}
          </ul>

          <p className="text-ink-soft">
            <strong className="text-ink">Order matters.</strong> A rule can only read
            totals that earlier rules produced, so <code className="font-mono">categories.GROSS</code> is
            only meaningful in a rule whose sequence is higher than the one that sets it.
          </p>
        </div>
      )}
    </div>
  );
}
