import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, attachEmployee, isHr } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num, toPatchSchema } from '../../lib/http.js';
import {
  computeDuration,
  balanceFor,
  consumeAllocation,
  overlappingRequest,
} from './timeoff.service.js';

const router = Router();
router.use(authenticate);

const EMP = { select: { id: true, firstName: true, lastName: true } };
const named = (e) => (e ? { id: e.id, name: `${e.firstName} ${e.lastName}` } : null);

// The approver is a User; their display name lives on the linked Employee.
const APPROVER = { select: { id: true, email: true, employee: EMP } };
const approverName = (u) =>
  (u ? { id: u.id, email: u.email, name: u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email } : null);

// ---------------------------------------------------------------- Types ----
router.get(
  '/types',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.timeOffType.findMany({ orderBy: { name: 'asc' } }));
  }),
);

const typeSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).toUpperCase(),
  unit: z.enum(['DAYS', 'HOURS']).default('DAYS'),
  requiresAllocation: z.boolean().default(true),
  approvalMode: z.enum(['NONE', 'MANAGER', 'OFFICER']).default('MANAGER'),
  workEntry: z
    .enum(['PAID_LEAVE', 'UNPAID_LEAVE', 'SICK_LEAVE', 'COMPENSATORY_LEAVE'])
    .default('PAID_LEAVE'),
  description: z.string().nullish(),
  color: z.string().default('#714B67'),
  isActive: z.boolean().default(true),
});

// requiresApproval and isPaid are not configured directly; they follow from the
// approval mode and the payroll work entry, so the two can never disagree.
const derivePolicy = (data) => ({
  ...data,
  ...(data.approvalMode !== undefined ? { requiresApproval: data.approvalMode !== 'NONE' } : {}),
  ...(data.workEntry !== undefined ? { isPaid: data.workEntry !== 'UNPAID_LEAVE' } : {}),
});

router.post(
  '/types',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = derivePolicy(typeSchema.parse(req.body));
    res.status(201).json(await prisma.timeOffType.create({ data }));
  }),
);

router.patch(
  '/types/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = derivePolicy(toPatchSchema(typeSchema).parse(req.body));
    res.json(await prisma.timeOffType.update({ where: { id: req.params.id }, data }));
  }),
);

router.delete(
  '/types/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const used = await prisma.leaveRequest.count({ where: { timeOffTypeId: req.params.id } });
    if (used) throw badRequest(`Type is used by ${used} request(s); deactivate it instead`);
    await prisma.timeOffType.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------- Allocations ----
const allocShape = (a) => ({
  ...a,
  amount: num(a.amount),
  employee: named(a.employee),
});

router.get(
  '/allocations',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { employeeId, timeOffTypeId, status } = req.query;

    const where = {
      ...(isHr(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(employeeId ? { employeeId } : {}),
      ...(timeOffTypeId ? { timeOffTypeId } : {}),
      ...(status ? { status } : {}),
      ...(q.search
        ? {
            OR: [
              { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
              { timeOffType: { name: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.leaveAllocation.findMany({
        where,
        ...paginate(q),
        // Every allocation shares a validFrom, so ordering by it alone is
        // non-deterministic and a new row can land on a later page. Newest
        // first guarantees a just-created grant is visible immediately.
        orderBy: q.sortBy
          ? [{ [q.sortBy]: q.sortDir }, { createdAt: 'desc' }]
          : [{ createdAt: 'desc' }],
        include: { employee: EMP, timeOffType: true },
      }),
      prisma.leaveAllocation.count({ where }),
    ]);

    // Each row carries its own taken/remaining so the list can show balances.
    const enriched = await Promise.all(
      rows.map(async (a) => ({
        ...allocShape(a),
        balance: await balanceFor(a.employeeId, a.timeOffTypeId),
      })),
    );

    res.json(listResponse(enriched, total, q));
  }),
);

const allocationSchema = z.object({
  employeeId: z.string().uuid(),
  timeOffTypeId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date().nullish(),
  notes: z.string().nullish(),
  status: z.enum(['DRAFT', 'TO_APPROVE', 'APPROVED', 'REFUSED', 'CANCELLED']).default('DRAFT'),
});

router.post(
  '/allocations',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = allocationSchema.parse(req.body);
    const row = await prisma.leaveAllocation.create({
      data,
      include: { employee: EMP, timeOffType: true },
    });
    res.status(201).json(allocShape(row));
  }),
);

router.patch(
  '/allocations/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = toPatchSchema(allocationSchema).parse(req.body);
    const row = await prisma.leaveAllocation.update({
      where: { id: req.params.id },
      data,
      include: { employee: EMP, timeOffType: true },
    });
    res.json(allocShape(row));
  }),
);

router.get(
  '/allocations/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.leaveAllocation.findUnique({
      where: { id: req.params.id },
      include: { employee: EMP, timeOffType: true, requests: { include: { timeOffType: true } } },
    });
    if (!row) throw notFound('Allocation not found');
    if (!isHr(req.user.role)) {
      const own = await prisma.employee.findFirst({
        where: { id: row.employeeId, userId: req.user.id },
        select: { id: true },
      });
      if (!own) throw forbidden();
    }
    res.json({
      ...allocShape(row),
      balance: await balanceFor(row.employeeId, row.timeOffTypeId),
      // The requests that consumed this allocation, so the form can explain
      // where the balance went.
      consumedBy: row.requests
        .filter((r) => r.status === 'APPROVED')
        .map((r) => ({
          id: r.id,
          dateFrom: r.dateFrom,
          dateTo: r.dateTo,
          duration: num(r.duration),
          status: r.status,
        })),
    });
  }),
);

router.post(
  '/allocations/:id/refuse',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const { notes } = z.object({ notes: z.string().nullish() }).parse(req.body ?? {});
    const allocation = await prisma.leaveAllocation.findUnique({
      where: { id: req.params.id },
      include: { requests: true },
    });
    if (!allocation) throw notFound('Allocation not found');

    // Refusing an allocation that approved leave already draws on would push
    // the employee's balance negative.
    const consumed = allocation.requests.filter((r) => r.status === 'APPROVED').length;
    if (consumed) {
      throw badRequest(
        `This allocation is already consumed by ${consumed} approved request(s); refuse those first.`,
      );
    }

    const row = await prisma.leaveAllocation.update({
      where: { id: allocation.id },
      data: { status: 'REFUSED', ...(notes ? { notes } : {}) },
      include: { employee: EMP, timeOffType: true },
    });
    res.json(allocShape(row));
  }),
);

router.post(
  '/allocations/:id/approve',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const row = await prisma.leaveAllocation.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED' },
      include: { employee: EMP, timeOffType: true },
    });
    res.json(allocShape(row));
  }),
);

router.delete(
  '/allocations/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    await prisma.leaveAllocation.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// ------------------------------------------------------------- Balances ----
router.get(
  '/balances',
  attachEmployee,
  asyncHandler(async (req, res) => {
    const employeeId = req.query.employeeId ?? req.employee?.id;
    if (!employeeId) throw badRequest('No employee to report balances for');
    if (!isHr(req.user.role) && employeeId !== req.employee?.id) throw forbidden();

    const types = await prisma.timeOffType.findMany({ where: { isActive: true } });
    const balances = await Promise.all(
      types.map(async (t) => ({
        type: { id: t.id, name: t.name, code: t.code, unit: t.unit, color: t.color },
        ...(await balanceFor(employeeId, t.id)),
      })),
    );
    res.json(balances);
  }),
);

// ------------------------------------------------------------- Requests ----
const reqShape = (r) => ({
  ...r,
  duration: num(r.duration),
  employee: named(r.employee),
  approvedBy: approverName(r.approvedBy),
});

router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { employeeId, timeOffTypeId, status } = req.query;

    const where = {
      ...(isHr(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(employeeId ? { employeeId } : {}),
      ...(timeOffTypeId ? { timeOffTypeId } : {}),
      ...(status ? { status } : {}),
      ...(q.search
        ? {
            OR: [
              { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
              { timeOffType: { name: { contains: q.search, mode: 'insensitive' } } },
              { reason: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy
          ? [{ [q.sortBy]: q.sortDir }, { createdAt: 'desc' }]
          : [{ createdAt: 'desc' }],
        include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
      }),
      prisma.leaveRequest.count({ where }),
    ]);

    res.json(listResponse(rows.map(reqShape), total, q));
  }),
);

router.get(
  '/requests/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: { employee: EMP, timeOffType: true, allocation: true, approvedBy: APPROVER },
    });
    if (!row) throw notFound('Request not found');
    res.json(reqShape(row));
  }),
);

const requestSchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    timeOffTypeId: z.string().uuid(),
    dateFrom: z.coerce.date(),
    dateTo: z.coerce.date(),
    reason: z.string().nullish(),
  })
  .refine((r) => r.dateTo >= r.dateFrom, {
    message: 'End date must be on or after start date',
    path: ['dateTo'],
  });

router.post(
  '/requests',
  attachEmployee,
  asyncHandler(async (req, res) => {
    const data = requestSchema.parse(req.body);

    // Employees may only file for themselves; HR may file on anyone's behalf.
    const employeeId = isHr(req.user.role)
      ? (data.employeeId ?? req.employee?.id)
      : req.employee?.id;
    if (!employeeId) throw badRequest('No employee to file this request for');

    const type = await prisma.timeOffType.findUnique({ where: { id: data.timeOffTypeId } });
    if (!type) throw notFound('Time off type not found');

    const clash = await overlappingRequest({ employeeId, dateFrom: data.dateFrom, dateTo: data.dateTo });
    if (clash) throw badRequest('This period overlaps an existing request');

    const duration = await computeDuration({
      employeeId,
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
      unit: type.unit,
    });
    if (duration <= 0) throw badRequest('Selected dates contain no working days');

    const row = await prisma.leaveRequest.create({
      data: {
        employeeId,
        timeOffTypeId: data.timeOffTypeId,
        dateFrom: data.dateFrom,
        dateTo: data.dateTo,
        reason: data.reason,
        duration,
        status: type.requiresApproval ? 'TO_APPROVE' : 'APPROVED',
      },
      include: { employee: EMP, timeOffType: true },
    });

    res.status(201).json(reqShape(row));
  }),
);

router.post(
  '/requests/:id/approve',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const request = await tx.leaveRequest.findUnique({ where: { id: req.params.id } });
      if (!request) throw notFound('Request not found');
      if (request.status === 'APPROVED') throw badRequest('Request is already approved');

      const allocationId = await consumeAllocation(request, tx);

      return tx.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          allocationId,
          approvedById: req.user.id,
          approvedAt: new Date(),
        },
        include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
      });
    });
    res.json(reqShape(row));
  }),
);

router.post(
  '/requests/:id/refuse',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const { refusalReason } = z.object({ refusalReason: z.string().nullish() }).parse(req.body ?? {});
    const row = await prisma.leaveRequest.update({
      where: { id: req.params.id },
      data: {
        status: 'REFUSED',
        refusalReason,
        allocationId: null,
        approvedById: req.user.id,
        approvedAt: new Date(),
      },
      include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
    });
    res.json(reqShape(row));
  }),
);

router.delete(
  '/requests/:id',
  attachEmployee,
  asyncHandler(async (req, res) => {
    const row = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Request not found');
    // Employees may withdraw only their own, and only before approval.
    if (!isHr(req.user.role)) {
      if (row.employeeId !== req.employee?.id) throw forbidden();
      if (row.status === 'APPROVED') throw badRequest('Approved requests must be cancelled by HR');
    }
    await prisma.leaveRequest.delete({ where: { id: row.id } });
    res.status(204).end();
  }),
);

export default router;
