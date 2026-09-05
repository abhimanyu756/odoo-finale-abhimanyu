import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, ChevronDown, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isHr, isPayroll, isAdmin, ROLE_LABELS } from '../lib/roles';
import { initials } from '../lib/format';
import AttendanceWidget from './AttendanceWidget';

// Top navigation mirrors the mockup: Employees, Contracts, Attendance,
// Time Off, Payroll — with dropdowns where the mockup shows a caret.
const navFor = (role) => {
  const items = [];
  // The mockup's "Menus under Employees" annotation groups the people-master
  // screens under one caret: Employees, Contracts, Departments, Working
  // Schedules. A plain employee sees only their own record, so for them it
  // stays a single link rather than a dropdown with one item.
  if (isHr(role)) {
    items.push({
      label: 'Employees',
      children: [
        { label: 'Employees', to: '/employees' },
        { label: 'Contracts', to: '/contracts' },
        { label: 'Departments', to: '/departments' },
        { label: 'Working Schedules', to: '/working-schedules' },
      ],
    });
  } else {
    items.push({ label: 'Employees', to: '/employees' });
  }
  items.push({ label: 'Attendance', to: '/attendance' });
  items.push({
    label: 'Time Off',
    children: [
      { label: 'Requests', to: '/time-off/requests' },
      { label: 'Allocations', to: '/time-off/allocations' },
      ...(isHr(role) ? [{ label: 'Types', to: '/time-off/types' }] : []),
    ],
  });
  if (isPayroll(role)) {
    items.push({
      label: 'Payroll',
      children: [
        { label: 'Dashboard', to: '/payroll/dashboard' },
        { label: 'Payruns', to: '/payroll/payruns' },
        { label: 'Payslips', to: '/payroll/payslips' },
        { label: 'Salary Structures', to: '/payroll/structures' },
        { label: 'Salary Rules', to: '/payroll/rules' },
      ],
    });
  } else {
    items.push({ label: 'My Payslips', to: '/payroll/payslips' });
  }
  if (isAdmin(role)) items.push({ label: 'User Access', to: '/admin/users' });
  return items;
};

const linkClass = ({ isActive }) =>
  `rounded px-2.5 py-1.5 text-sm transition-colors ${
    isActive ? 'bg-odoo-50 font-medium text-odoo-600' : 'text-ink-soft hover:bg-odoo-50 hover:text-odoo-600'
  }`;

function NavDropdown({ item }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);

  // The nav scrolls horizontally, and overflow-x:auto also clips vertically —
  // an absolutely positioned menu is cut off by the 56px-tall header row. A
  // fixed-position panel anchored to the button escapes that clipping box.
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.bottom + 4, left: r.left });
  };

  const toggle = () => {
    if (!open) place();
    setOpen((o) => !o);
  };

  // Opening on hover meant the menu was already open by the time a click
  // landed, so the click's toggle immediately closed it again. Click-only,
  // with outside-click and Escape to dismiss.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // useLocation re-renders on navigation; window.location would go stale.
  const { pathname } = useLocation();
  const active = item.children.some((c) => pathname.startsWith(c.to));

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center gap-1 rounded px-2.5 py-1.5 text-sm transition-colors
          hover:bg-odoo-50 hover:text-odoo-600 ${
            open || active ? 'bg-odoo-50 font-medium text-odoo-600' : 'text-ink-soft'
          }`}
      >
        {item.label}
        <ChevronDown size={13} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>
      {open && coords && (
        <div role="menu"
          style={{ top: coords.top, left: coords.left }}
          className="fixed z-50 w-52 rounded-md border border-hairline bg-white py-1 shadow-lg">
          {item.children.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block px-3 py-1.5 text-sm ${
                  isActive ? 'bg-odoo-50 font-medium text-odoo-600' : 'text-ink hover:bg-odoo-50'
                }`
              }
            >
              {c.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [widgetOpen, setWidgetOpen] = useState(false);
  const nav = navFor(user?.role);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hairline bg-white">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-1 px-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="mr-2 flex items-center gap-2"
          >
            <span className="grid h-8 w-8 place-items-center rounded-md bg-odoo-500 text-xs font-bold text-white">
              PP
            </span>
            <span className="hidden text-sm font-semibold text-ink sm:block">PeoplePay360</span>
          </button>

          <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {nav.map((item) =>
              item.children ? (
                <NavDropdown key={item.label} item={item} />
              ) : (
                <NavLink key={item.to} to={item.to} className={linkClass}>
                  {item.label}
                </NavLink>
              ),
            )}
          </nav>

          <button
            type="button"
            onClick={() => setWidgetOpen((o) => !o)}
            title="Check in / Check out"
            className="relative rounded-full border border-hairline p-1.5 text-odoo-500 hover:bg-odoo-50"
          >
            <Clock size={16} />
          </button>

          <div className="ml-2 flex items-center gap-2 border-l border-hairline pl-3">
            <div className="hidden text-right sm:block">
              <div className="text-xs font-medium leading-tight text-ink">
                {user?.employee?.name ?? user?.email}
              </div>
              <div className="text-[11px] leading-tight text-ink-soft">
                {ROLE_LABELS[user?.role] ?? user?.role}
              </div>
            </div>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-odoo-100 text-xs font-semibold text-odoo-600">
              {initials(user?.employee?.name ?? user?.email ?? '')}
            </span>
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
              className="o-btn-ghost px-2 py-1"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </header>

      {widgetOpen && <AttendanceWidget onClose={() => setWidgetOpen(false)} />}

      <main className="mx-auto max-w-[1600px] px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
