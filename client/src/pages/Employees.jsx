import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutGrid, List as ListIcon, Plus, Search, Users, Users2 } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { useFetch } from '../hooks/useApi';
import { useAuth } from '../context/AuthContext';
import { isHr } from '../lib/roles';
import { initials, titleCase } from '../lib/format';
import { PageHeader, Spinner, EmptyState, ErrorState, StatusBadge, Pagination, SearchSelect, PagerBar, ExportButton } from '../components/ui';
import EmployeeCreateModal from '../components/EmployeeCreateModal';

function KanbanCard({ e }) {
  return (
    <Link
      to={`/employees/${e.id}`}
      className="o-card block p-3 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-odoo-100 text-sm font-semibold text-odoo-600">
          {initials(e.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{e.name}</p>
          <p className="truncate text-xs text-ink-soft">{e.jobPosition?.name ?? 'No position'}</p>
          <p className="mt-1 truncate text-xs text-ink-soft">{e.workEmail}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge value={e.status} />
            {e.department && (
              <span className="o-badge bg-odoo-50 text-odoo-600">{e.department.name}</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function Employees() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState('kanban');
  const [creating, setCreating] = useState(false);
  const list = useList('/employees', { limit: 24 });
  const { data: depts } = useFetch('/org/departments');

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="Central hub for all HR interactions"
        actions={
          <>
            <div className="flex rounded-md border border-hairline bg-white p-0.5">
              <button
                type="button"
                onClick={() => setView('kanban')}
                className={`rounded px-2 py-1 ${view === 'kanban' ? 'bg-odoo-50 text-odoo-600' : 'text-ink-soft'}`}
                title="Kanban view"
              >
                <LayoutGrid size={15} />
              </button>
              <button
                type="button"
                onClick={() => setView('list')}
                className={`rounded px-2 py-1 ${view === 'list' ? 'bg-odoo-50 text-odoo-600' : 'text-ink-soft'}`}
                title="List view"
              >
                <ListIcon size={15} />
              </button>
            </div>
            {isHr(role) && (
              <button type="button" className="o-btn-primary" onClick={() => setCreating(true)}>
                <Plus size={15} /> New
              </button>
            )}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input
            className="o-input pl-8"
            placeholder="Search employees…"
            value={list.params.search ?? ''}
            onChange={(e) => list.setParam({ search: e.target.value || undefined })}
          />
        </div>
        {/* "My Team" from the mockup: the requester's own direct reports.
            Available to everyone, since a line manager is usually a plain
            employee - that is precisely who needs it. */}
        <button
          type="button"
          onClick={() => list.setParam({ scope: list.params.scope === 'team' ? undefined : 'team' })}
          className={`o-badge border px-2.5 py-1.5 text-xs transition-colors ${
            list.params.scope === 'team'
              ? 'border-odoo-300 bg-odoo-50 text-odoo-700'
              : 'border-hairline bg-white text-ink-soft hover:bg-odoo-50'}`}
          title="Show only employees who report to me"
        >
          <Users2 size={13} />
          My Team
        </button>
        <SearchSelect
          className="w-auto min-w-44"
          value={list.params.departmentId ?? ''}
          onChange={(v) => list.setParam({ departmentId: v || undefined })}
          searchPlaceholder="Search departments…"
          options={[{ value: '', label: 'All departments' },
            ...(depts ?? []).map((d) => ({ value: d.id, label: d.name }))]}
        />
        <select
          className="o-input w-auto"
          onChange={(e) => list.setParam({ employeeType: e.target.value || undefined })}
        >
          <option value="">All types</option>
          {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((t) => (
            <option key={t} value={t}>{titleCase(t)}</option>
          ))}
        </select>
        <select
          className="o-input w-auto"
          onChange={(e) => list.setParam({ status: e.target.value || undefined })}
        >
          <option value="">Any status</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <ExportButton path={'/employees/export'} params={list.params} name="employees" />
        <PagerBar page={list.page} pages={list.pages} total={list.total}
          limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
      </div>

      {list.loading ? (
        <Spinner label="Loading employees" />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.refetch} />
      ) : !list.rows.length ? (
        <EmptyState icon={Users} title="No employees found" hint="Adjust your filters or add a new employee." />
      ) : view === 'kanban' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {list.rows.map((e) => <KanbanCard key={e.id} e={e} />)}
          </div>
          <div className="o-card mt-3">
            <Pagination page={list.page} pages={list.pages} total={list.total}
            limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
          </div>
        </>
      ) : (
        <div className="o-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Work Email</th>
                  <th>Department</th>
                  <th>Job Position</th>
                  <th>Manager</th>
                  <th>HR Responsible</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/employees/${e.id}`)}
                  >
                    <td className="font-medium text-ink">{e.name}</td>
                    <td className="text-ink-soft">{e.workEmail}</td>
                    <td>{e.department?.name ?? '—'}</td>
                    <td>{e.jobPosition?.name ?? '—'}</td>
                    <td>{e.manager?.name ?? '—'}</td>
                    <td className="text-ink-soft">{e.hrResponsible?.name ?? '—'}</td>
                    <td>{titleCase(e.employeeType)}</td>
                    <td><StatusBadge value={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.page} pages={list.pages} total={list.total}
            limit={list.params.limit} onPage={(p) => list.setParam({ page: p })} />
        </div>
      )}

      {creating && (
        <EmployeeCreateModal
          onClose={() => setCreating(false)}
          onCreated={(emp) => {
            setCreating(false);
            navigate(`/employees/${emp.id}`);
          }}
        />
      )}
    </>
  );
}
