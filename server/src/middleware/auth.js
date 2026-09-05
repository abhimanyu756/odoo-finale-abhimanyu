import { verifyAccessToken } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    return next();
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
}

// Role hierarchy: each role implicitly holds every capability below it.
const RANK = {
  EMPLOYEE: 0,
  HR_MANAGER: 1,
  HR_PAYROLL_USER: 2,
  HR_PAYROLL_ADMIN: 3,
  ADMIN: 4,
};

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };

export const requireMinRole = (role) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (RANK[req.user.role] < RANK[role]) return next(forbidden());
  return next();
};

// Attaches the caller's Employee record, so self-service routes can scope
// queries to "my" records without trusting a client-supplied employeeId.
export async function attachEmployee(req, _res, next) {
  if (!req.user) return next(unauthorized());
  const employee = await prisma.employee.findUnique({
    where: { userId: req.user.id },
    select: { id: true, firstName: true, lastName: true, departmentId: true },
  });
  req.employee = employee;
  return next();
}

export const isHr = (role) => RANK[role] >= RANK.HR_MANAGER;
export const isPayroll = (role) => RANK[role] >= RANK.HR_PAYROLL_USER;
export { RANK };
