import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Calculator, CheckCircle2, XCircle } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isPayrollAdmin } from '../lib/roles';
import { money, titleCase } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Modal, Field } from '../components/ui';

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
        <select className="o-input w-auto" value={list.params.structureId ?? ''}
          onChange={(e) => list.setParam({ structureId: e.target.value || undefined })}>
          <option value="">All structures</option>
          {(structures?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="o-input w-auto" onChange={(e) => list.setParam({ category: e.target.value || undefined })}>
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
          <select className="o-input" value={form.structureId} onChange={set('structureId')} required>
            <option value="">Select structure</option>
            {structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
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
              {meta && (
                <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
                  <strong>Variables:</strong> {meta.variables.join(', ')}<br />
                  <strong>Categories:</strong> {meta.categoryRefs.join(', ')}<br />
                  <strong>Functions:</strong> {meta.functions.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="sm:col-span-2">
          <Field label="Condition" hint="Optional — the rule only applies when this evaluates true, e.g. worked_days > 20">
            <input className="o-input font-mono text-xs" value={form.condition} onChange={set('condition')} />
          </Field>
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
