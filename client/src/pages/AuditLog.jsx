import { History, Search, Plus, Pencil, Trash2 } from 'lucide-react';
import { useList, useFetch } from '../hooks/useApi';
import { dateTime } from '../lib/format';
import {
  PageHeader, Spinner, EmptyState, ErrorState, Pagination, PagerBar,
  SearchSelect, PeriodFilter,
} from '../components/ui';

const ACTION_STYLE = {
  create: { icon: Plus, tone: 'bg-emerald-100 text-emerald-700' },
  update: { icon: Pencil, tone: 'bg-blue-100 text-blue-700' },
  delete: { icon: Trash2, tone: 'bg-red-100 text-red-700' },
};

// Renders { field: { from, to } } as one line per field that moved.
function Changes({ changes }) {
  if (!changes) return <span className="text-ink-soft">—</span>;
  const entries = Object.entries(changes);
  return (
    <div className="space-y-0.5">
      {entries.slice(0, 4).map(([field, { from, to }]) => (
        <div key={field} className="flex flex-wrap items-baseline gap-1 text-[11px]">
          <span className="font-mono text-ink-soft">{field}</span>
          <span className="max-w-40 truncate text-red-600 line-through">{String(from ?? '—')}</span>
          <span className="text-ink-soft">→</span>
          <span className="max-w-40 truncate font-medium text-emerald-700">{String(to ?? '—')}</span>
        </div>
      ))}
      {entries.length > 4 && (
        <p className="text-[11px] text-ink-soft">+{entries.length - 4} more field(s)</p>
      )}
    </div>
  );
}

export default function AuditLog() {
  const list = useList('/audit', { limit: 50 });
  const { data: meta } = useFetch('/audit/meta');

  return (
    <>
      <PageHeader
        title="Audit Trail"
        subtitle="Every create, update and delete across master data, approvals and payroll — recorded automatically"
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input className="o-input pl-8" placeholder="Search record or actor…"
            value={list.params.search ?? ''}
            onChange={(e) => list.setParam({ search: e.target.value || undefined })} />
        </div>
        <SearchSelect
          className="w-auto min-w-40"
          value={list.params.entity ?? ''}
          onChange={(v) => list.setParam({ entity: v || undefined })}
          searchPlaceholder="Search records…"
          options={[{ value: '', label: 'All records' },
            ...(meta?.entities ?? []).map((e) => ({ value: e, label: e }))]}
        />
        <select className="o-input w-auto" value={list.params.action ?? ''}
          onChange={(e) => list.setParam({ action: e.target.value || undefined })}>
          <option value="">Any action</option>
          <option value="create">Created</option>
          <option value="update">Updated</option>
          <option value="delete">Deleted</option>
        </select>
        <PeriodFilter
          year={list.params.year}
          month={list.params.month}
          onChange={(v) => list.setParam(v)}
        />
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      <div className="o-card overflow-hidden">
        {list.loading ? <Spinner label="Loading audit trail" />
          : list.error ? <ErrorState message={list.error} onRetry={list.refetch} />
          : !list.rows.length ? <EmptyState icon={History} title="Nothing recorded yet"
              hint="Changes made through the app appear here automatically." />
          : (
            <div className="overflow-x-auto">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>When</th><th>Who</th><th>Action</th>
                    <th>Record</th><th>What changed</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => {
                    const a = ACTION_STYLE[r.action] ?? ACTION_STYLE.update;
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-xs text-ink-soft">{dateTime(r.at)}</td>
                        <td>
                          <span className="block text-xs font-medium text-ink">
                            {r.actorEmail ?? 'System'}
                          </span>
                          {r.actorRole && (
                            <span className="block text-[11px] text-ink-soft">
                              {r.actorRole.replace(/_/g, ' ')}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`o-badge ${a.tone}`}>
                            <a.icon size={11} /> {r.action}
                          </span>
                        </td>
                        <td>
                          <span className="block text-xs font-medium text-ink">{r.label ?? '—'}</span>
                          <span className="block text-[11px] text-ink-soft">{r.entity}</span>
                        </td>
                        <td><Changes changes={r.changes} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        <Pagination page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>
    </>
  );
}
