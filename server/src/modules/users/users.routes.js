import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse } from '../../lib/http.js';

const router = Router();
router.use(authenticate, requireMinRole('ADMIN'));

const ROLES = ['EMPLOYEE', 'HR_MANAGER', 'HR_PAYROLL_USER', 'HR_PAYROLL_ADMIN', 'ADMIN'];

const shape = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  isActive: u.isActive,
  mustReset: u.mustReset,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
  employee: u.employee
    ? {
        id: u.employee.id,
        name: `${u.employee.firstName} ${u.employee.lastName}`,
        workEmail: u.employee.workEmail,
        department: u.employee.department,
      }
    : null,
});

const EMPLOYEE_INCLUDE = {
  employee: {
    select: {
      id: true, firstName: true, lastName: true, workEmail: true,
      department: { select: { id: true, name: true } },
    },
  },
};

// Losing the last active administrator locks everyone out of user management,
// with no way back in through the app.
async function assertNotLastAdmin(userId, next) {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || target.role !== 'ADMIN' || !target.isActive) return;

  const stillAdmin = next.role === 'ADMIN' && next.isActive !== false;
  if (stillAdmin) return;

  const others = await prisma.user.count({
    where: { role: 'ADMIN', isActive: true, id: { not: userId } },
  });
  if (others === 0) {
    throw badRequest('This is the last active administrator; promote another admin first.');
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { role, status } = req.query;

    const where = {
      ...(role ? { role } : {}),
      ...(status === 'active' ? { isActive: true } : status === 'inactive' ? { isActive: false } : {}),
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search, mode: 'insensitive' } },
              { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
              { employee: { workEmail: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { email: 'asc' },
        include: EMPLOYEE_INCLUDE,
      }),
      prisma.user.count({ where }),
    ]);

    res.json(listResponse(rows.map(shape), total, q));
  }),
);

// Employees who can still be given a login, for the "New User" picker.
router.get(
  '/assignable-employees',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.employee.findMany({
      where: { userId: null },
      select: { id: true, firstName: true, lastName: true, workEmail: true },
      orderBy: { firstName: 'asc' },
    });
    res.json(rows.map((e) => ({ ...e, name: `${e.firstName} ${e.lastName}` })));
  }),
);

router.get(
  '/roles',
  asyncHandler(async (_req, res) => res.json({ roles: ROLES })),
);

const createSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(ROLES),
  isActive: z.boolean().default(true),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    const employee = await prisma.employee.findUnique({ where: { id: body.employeeId } });
    if (!employee) throw notFound('Employee not found');
    if (employee.userId) throw badRequest('This employee already has a user account');

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email.toLowerCase(),
          passwordHash: await bcrypt.hash(body.password, 10),
          role: body.role,
          isActive: body.isActive,
          mustReset: true,
        },
      });
      await tx.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
      return tx.user.findUnique({ where: { id: user.id }, include: EMPLOYEE_INCLUDE });
    });

    res.status(201).json(shape(created));
  }),
);

const updateSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
});

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const patch = updateSchema.parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found');

    // An admin changing their own role or switching themselves off would take
    // effect on their next request and lock them out mid-session.
    if (target.id === req.user.id) {
      if (patch.role && patch.role !== target.role) {
        throw badRequest('You cannot change your own role. Ask another administrator.');
      }
      if (patch.isActive === false) {
        throw badRequest('You cannot deactivate your own account.');
      }
    }

    await assertNotLastAdmin(target.id, { role: patch.role ?? target.role, isActive: patch.isActive });

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: target.id },
        data: { ...patch, ...(patch.email ? { email: patch.email.toLowerCase() } : {}) },
        include: EMPLOYEE_INCLUDE,
      });
      // Deactivating or demoting must end existing sessions, or the old access
      // level survives until the refresh token expires.
      if (patch.isActive === false || (patch.role && patch.role !== target.role)) {
        await tx.refreshToken.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return u;
    });

    res.json(shape(updated));
  }),
);

router.post(
  '/:id/reset-password',
  asyncHandler(async (req, res) => {
    const { password } = z
      .object({ password: z.string().min(8, 'Password must be at least 8 characters') })
      .parse(req.body);

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found');

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { passwordHash: await bcrypt.hash(password, 10), mustReset: true },
      });
      await tx.refreshToken.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    res.status(204).end();
  }),
);

// Revokes the login but keeps the employee record intact.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found');
    if (target.id === req.user.id) throw badRequest('You cannot delete your own account.');
    await assertNotLastAdmin(target.id, { role: null, isActive: false });

    await prisma.user.delete({ where: { id: target.id } });
    res.status(204).end();
  }),
);

export default router;
