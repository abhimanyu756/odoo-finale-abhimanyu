export const ROLES = ['EMPLOYEE', 'HR_MANAGER', 'HR_PAYROLL_USER', 'HR_PAYROLL_ADMIN', 'ADMIN'];

const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

export const atLeast = (role, min) => (RANK[role] ?? -1) >= (RANK[min] ?? 99);
export const isHr = (role) => atLeast(role, 'HR_MANAGER');
export const isPayroll = (role) => atLeast(role, 'HR_PAYROLL_USER');
export const isPayrollAdmin = (role) => atLeast(role, 'HR_PAYROLL_ADMIN');
export const isAdmin = (role) => role === 'ADMIN';

export const ROLE_LABELS = {
  EMPLOYEE: 'Employee',
  HR_MANAGER: 'HR Manager',
  HR_PAYROLL_USER: 'Payroll User',
  HR_PAYROLL_ADMIN: 'Payroll Admin',
  ADMIN: 'Administrator',
};
