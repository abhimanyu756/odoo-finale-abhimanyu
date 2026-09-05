import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { atLeast } from './lib/roles';
import { Spinner } from './components/ui';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Employees from './pages/Employees';
import EmployeeForm from './pages/EmployeeForm';
import Contracts from './pages/Contracts';
import Attendance from './pages/Attendance';
import WorkingSchedules from './pages/WorkingSchedules';
import TimeOffRequests from './pages/TimeOffRequests';
import TimeOffAllocations from './pages/TimeOffAllocations';
import TimeOffTypes from './pages/TimeOffTypes';
import SalaryStructures from './pages/SalaryStructures';
import SalaryRules from './pages/SalaryRules';
import Payruns from './pages/Payruns';
import PayrunDetail from './pages/PayrunDetail';
import Payslips from './pages/Payslips';
import PayslipDetail from './pages/PayslipDetail';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';

// Blocks a route the current role cannot reach, rather than letting the page
// mount and fail with a 403 from every request it makes.
function Guard({ min, children }) {
  const { role } = useAuth();
  if (!atLeast(role, min)) return <Navigate to="/employees" replace />;
  return children;
}

function Home() {
  const { role } = useAuth();
  return <Navigate to={atLeast(role, 'HR_PAYROLL_USER') ? '/payroll/dashboard' : '/employees'} replace />;
}

export default function App() {
  const { user, booting } = useAuth();

  if (booting) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Starting PeoplePay360" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />

        <Route path="/employees" element={<Employees />} />
        <Route path="/employees/:id" element={<EmployeeForm />} />

        <Route path="/contracts" element={<Guard min="HR_MANAGER"><Contracts /></Guard>} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/working-schedules" element={<Guard min="HR_MANAGER"><WorkingSchedules /></Guard>} />

        <Route path="/time-off/requests" element={<TimeOffRequests />} />
        <Route path="/time-off/allocations" element={<TimeOffAllocations />} />
        <Route path="/time-off/types" element={<Guard min="HR_MANAGER"><TimeOffTypes /></Guard>} />

        <Route path="/payroll/dashboard" element={<Guard min="HR_PAYROLL_USER"><Dashboard /></Guard>} />
        <Route path="/payroll/payruns" element={<Guard min="HR_PAYROLL_USER"><Payruns /></Guard>} />
        <Route path="/payroll/payruns/:id" element={<Guard min="HR_PAYROLL_USER"><PayrunDetail /></Guard>} />
        <Route path="/payroll/payslips" element={<Payslips />} />
        <Route path="/payroll/payslips/:id" element={<PayslipDetail />} />
        <Route path="/payroll/structures" element={<Guard min="HR_PAYROLL_USER"><SalaryStructures /></Guard>} />
        <Route path="/payroll/rules" element={<Guard min="HR_PAYROLL_USER"><SalaryRules /></Guard>} />

        <Route path="/admin/users" element={<Guard min="ADMIN"><Users /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
