import { useEffect, useRef, useState } from 'react';
import { MessageCircle, X, Send, Sparkles, AlertTriangle, Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useFetch } from '../hooks/useApi';

/*
 * Ask HR - a natural-language front door to queries the app can already answer.
 *
 * Entirely additive: it mounts as a floating button and talks to /api/assistant,
 * which calls the same scoped queries the screens use. Nothing here can write,
 * and no existing flow routes through it.
 *
 * The answer text and the result table come from the same response, and the
 * table is rendered from the server's rows rather than from anything the model
 * wrote - so the sentence can never disagree with the numbers beside it.
 */

const money = (v) =>
  typeof v === 'number' && Math.abs(v) >= 1000
    ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : v;

function ResultTable({ result }) {
  if (!result?.rows?.length) {
    return <p className="mt-2 text-xs text-ink-soft">No matching records.</p>;
  }
  return (
    <div className="mt-2 max-h-56 overflow-auto rounded border border-hairline bg-white">
      <table className="o-table text-xs">
        <thead className="[&>tr>th]:sticky [&>tr>th]:top-0">
          <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {result.columns.map((c) => (
                <td key={c} className={typeof r[c] === 'number' ? 'text-right tabular-nums' : ''}>
                  {money(r[c]) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// What the assistant actually asked the system, in plain words.
function ToolChip({ toolCall }) {
  if (!toolCall) return null;
  const args = Object.entries(toolCall.args ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1 text-[10px] text-ink-soft">
      <Search size={10} />
      <span className="font-mono">{toolCall.name}</span>
      {args.map((a) => (
        <span key={a} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono">{a}</span>
      ))}
    </p>
  );
}

export default function AskHr() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: status } = useFetch('/assistant/status', { skip: !open });
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, busy]);

  const ask = async (question) => {
    const q = (question ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setTurns((t) => [...t, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const { data } = await api.post('/assistant/chat', {
        message: q,
        // Only prior text is replayed; result tables stay on the client.
        // A model turn keeps its wording in `answer`, a user turn in `text` -
        // reading the wrong one sent `undefined` and failed validation.
        history: turns
          .slice(-6)
          .map((t) => ({
            role: t.role === 'user' ? 'user' : 'model',
            text: (t.role === 'user' ? t.text : t.answer ?? t.text) ?? '',
          }))
          .filter((t) => t.text.trim()),
      });
      setTurns((t) => [...t, { role: 'model', ...data }]);
    } catch (err) {
      setTurns((t) => [...t, { role: 'model', text: errorMessage(err), failed: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Floating entry point. Fixed, so it never affects any page's layout. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close Ask HR' : 'Open Ask HR'}
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full
                   bg-odoo-500 text-white shadow-lg transition hover:bg-odoo-600 hover:shadow-xl"
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-40 flex h-[32rem] w-[min(30rem,calc(100vw-2.5rem))]
                        flex-col overflow-hidden rounded-xl border border-hairline bg-canvas shadow-2xl">
          <div className="flex items-center gap-2 border-b border-hairline bg-white px-3 py-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-odoo-100 text-odoo-600">
              <Sparkles size={14} />
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold text-ink">Ask HR</span>
              <span className="block text-[11px] text-ink-soft">
                Answers from your live data — read only
              </span>
            </span>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {turns.length === 0 && (
              <>
                <p className="text-xs text-ink-soft">
                  Ask about employees, attendance, time off or payroll. Every answer runs a
                  real query against your data, scoped to what you are allowed to see.
                </p>
                <div className="grid gap-1.5">
                  {(status?.examples ?? []).map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => ask(ex)}
                      className="rounded-md border border-hairline bg-white px-2.5 py-1.5 text-left
                                 text-xs text-ink-soft transition hover:border-odoo-300 hover:text-odoo-700"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
                {status && !status.enabled && (
                  <p className="flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    GEMINI_API_KEY is not set, so the assistant is offline. The rest of the app is unaffected.
                  </p>
                )}
              </>
            )}

            {turns.map((t, i) =>
              t.role === 'user' ? (
                <p key={i} className="ml-auto max-w-[85%] rounded-lg bg-odoo-500 px-2.5 py-1.5 text-xs text-white">
                  {t.text}
                </p>
              ) : (
                <div key={i} className="max-w-full rounded-lg border border-hairline bg-white px-2.5 py-2">
                  <p className={`whitespace-pre-wrap text-xs ${t.failed ? 'text-red-600' : 'text-ink'}`}>
                    {t.answer ?? t.text}
                  </p>
                  {t.result && <ResultTable result={t.result} />}
                  <ToolChip toolCall={t.toolCall} />
                </div>
              ),
            )}

            {busy && <p className="text-xs text-ink-soft">Thinking…</p>}
            <div ref={bottomRef} />
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); ask(); }}
            className="flex items-center gap-2 border-t border-hairline bg-white px-3 py-2"
          >
            <input
              className="o-input py-1.5 text-xs"
              placeholder="Ask about your HR data…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="o-btn-primary px-2.5 py-1.5" disabled={busy || !input.trim()}>
              <Send size={14} />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
