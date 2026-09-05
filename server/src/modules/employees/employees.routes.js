import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, isHr } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, toPatchSchema } from '../../lib/http.js';

const router = Router();
router.use(authenticate);

const RELATIONS = {
  company: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  jobPosition: { select: { id: true, name: true } },
  workingSchedule: { select: { id: true, name: true, hoursPerWeek: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
  user: { select: { id: true, email: true, role: true, isActive: true } },
};

const shape = (e) => ({
  ...e,
  name: `${e.firstName} ${e.lastName}`,
  workingSchedule: e.workingSchedule
    ? { ...e.workingSchedule, hoursPerWeek: Number(e.workingSchedule.hoursPerWeek) }
    : null,
  manager: e.manager ? { id: e.manager.id, name: `${e.manager.firstName} ${e.manager.lastName}` } : null,
});

// Employees see only their own record; HR and above see everyone.
const scopeFor = (req) => {
  if (isHr(req.user.role)) return {};
  return { userId: req.user.id };
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { departmentId, status, employeeType } = req.query;

    const where = {
      ...scopeFor(req),
      ...(departmentId ? { departmentId } : {}),
      ...(status ? { status } : {}),
      ...(employeeType ? { employeeType } : {}),
      ...(q.search
        ? {
            OR: [
              { firstName: { contains: q.search, mode: 'insensitive' } },
              { lastName: { contains: q.search, mode: 'insensitive' } },
              { workEmail: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { firstName: 'asc' },
        include: RELATIONS,
      }),
      prisma.employee.count({ where }),
    ]);

    res.json(listResponse(rows.map(shape), total, q));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: {
        ...RELATIONS,
        // Smart-button counts, matching the mockup: Time Off / Contracts / Attendance
        _count: { select: { contracts: true, attendances: true, leaveRequests: true } },
      },
    });
    if (!employee) throw notFound('Employee not found');
    if (!isHr(req.user.role) && employee.userId !== req.user.id) throw forbidden();

    const { _count, ...rest } = employee;
    res.json({
      ...shape(rest),
      counts: {
        contracts: _count.contracts,
        attendance: _count.attendances,
        timeOff: _count.leaveRequests,
      },
    });
  }),
);

const employeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  workEmail: z.string().email(),
  personalEmail: z.string().email().nullish(),
  phone: z.string().nullish(),
  employeeType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']).default('FULL_TIME'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  workLocation: z.string().nullish(),
  dateOfBirth: z.coerce.date().nullish(),
  hireDate: z.coerce.date().nullish(),
  address: z.string().nullish(),
  bankAccount: z.string().nullish(),
  identificationNo: z.string().nullish(),
  companyId: z.string().uuid(),
  departmentId: z.string().uuid().nullish(),
  jobPositionId: z.string().uuid().nullish(),
  workingScheduleId: z.string().uuid().nullish(),
  managerId: z.string().uuid().nullish(),
});

router.post(
  '/',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = employeeSchema.parse(req.body);
    const created = await prisma.employee.create({
      data: { ...data, workEmail: data.workEmail.toLowerCase() },
      include: RELATIONS,
    });
    res.status(201).json(shape(created));
  }),
);

router.patch(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = toPatchSchema(employeeSchema).parse(req.body);
    if (data.managerId && data.managerId === req.params.id) {
      throw badRequest('An employee cannot be their own manager');
    }
    const updated = await prisma.employee.update({
      where: { id: req.params.id },
      data,
      include: RELATIONS,
    });
    res.json(shape(updated));
  }),
);

router.delete(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    await prisma.employee.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// --- Admin-only user provisioning -----------------------------------------
// Mirrors the User Management screen: pick an existing employee, set the work
// email and role, and a login is created and linked to that employee.
const provisionSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['EMPLOYEE', 'HR_MANAGER', 'HR_PAYROLL_USER', 'HR_PAYROLL_ADMIN', 'ADMIN']),
  isActive: z.boolean().default(true),
});

router.post(
  '/:id/user',
  requireMinRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const body = provisionSchema.parse(req.body);
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!employee) throw notFound('Employee not found');
    if (employee.userId) throw badRequest('This employee already has a user account');

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: body.email.toLowerCase(),
          passwordHash: await bcrypt.hash(body.password, 10),
          role: body.role,
          isActive: body.isActive,
          mustReset: true,
        },
      });
      await tx.employee.update({ where: { id: employee.id }, data: { userId: u.id } });
      return u;
    });

    res.status(201).json({ id: user.id, email: user.email, role: user.role, isActive: user.isActive });
  }),
);

export default router;
