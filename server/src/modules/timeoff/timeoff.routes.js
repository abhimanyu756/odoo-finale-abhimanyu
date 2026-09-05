import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { periodWindow } from '../../lib/dates.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, attachEmployee, isHr } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num, toPatchSchema } from '../../lib/http.js';
import {
  computeDuration,
  balanceFor,
  consumeAllocation,
  overlappingRequest,
} from './timeoff.service.js';

// The coarse ?year=&month= picker every list screen shares.
const periodFilterSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

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
  approvedBy: approverName(a.approvedBy),
});

router.get(
  '/allocations',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { employeeId, timeOffTypeId, status } = req.query;
    const { year, month } = periodFilterSchema.parse(req.query);
    // An allocation is dated by when it becomes usable.
    const window = periodWindow(year, month);

    const where = {
      ...(isHr(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(employeeId ? { employeeId } : {}),
      ...(timeOffTypeId ? { timeOffTypeId } : {}),
      ...(status ? { status } : {}),
      ...(window ? { validFrom: window } : {}),
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
        include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
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

// Any write that lands an allocation on APPROVED stamps who did it. Moving it
// back off APPROVED clears the stamp, so a re-approval cannot inherit a stale
// approver.
const approvalStamp = (status, req) => {
  if (status === 'APPROVED') return { approvedById: req.user.id, approvedAt: new Date() };
  if (status) return { approvedById: null, approvedAt: null };
  return {};
};

router.post(
  '/allocations',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = allocationSchema.parse(req.body);
    const row = await prisma.leaveAllocation.create({
      // Creating one already set to APPROVED is an approval - it just skips the
      // approve endpoint - so the creator is recorded as the approver. Without
      // this the form reads "Not approved yet" on an approved allocation.
      data: { ...data, ...approvalStamp(data.status, req) },
      include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
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
      // Editing a draft up to APPROVED is the same decision as pressing Approve.
      data: { ...data, ...approvalStamp(data.status, req) },
      include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
    });
    res.json(allocShape(row));
  }),
);

router.get(
  '/allocations/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.leaveAllocation.findUnique({
      where: { id: req.params.id },
      include: {
        employee: EMP, timeOffType: true, approvedBy: APPROVER,
        requests: { include: { timeOffType: true } },
      },
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
    const existing = await prisma.leaveAllocation.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Allocation not found');
    await assertNotSelf(existing, req);

    const row = await prisma.leaveAllocation.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: new Date() },
      include: { employee: EMP, timeOffType: true, approvedBy: APPROVER },
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
    const { employeeId, timeOffTypeId, status, scope } = req.query;
    const { year, month } = periodFilterSchema.parse(req.query);
    // A request is filed against the day it starts, so a leave spanning a month
    // boundary belongs to the month it began in.
    const window = periodWindow(year, month);

    // "My Team" scopes the list to the requester's own direct reports. A user
    // with no employee record manages nobody, so it must match nothing rather
    // than falling through to everyone.
    let teamFilter;
    if (scope === 'team') {
      const me = await prisma.employee.findFirst({
        where: { userId: req.user.id }, select: { id: true },
      });
      teamFilter = { managerId: me?.id ?? '__none__' };
    }

    const where = {
      ...(isHr(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(teamFilter ? { employee: teamFilter } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(timeOffTypeId ? { timeOffTypeId } : {}),
      ...(status ? { status } : {}),
      ...(window ? { dateFrom: window } : {}),
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

// Nobody signs off their own leave. This mirrors the rule already enforced on
// user roles: an approval is a control, and a control you can apply to yourself
// is not one. Applies to admins too - the answer there is a second approver,
// not an exemption.
async function assertNotSelf(record, req, tx = prisma) {
  const employee = await tx.employee.findUnique({
    where: { id: record.employeeId },
    select: { userId: true },
  });
  if (employee?.userId && employee.userId === req.user.id) {
    throw badRequest(
      'You cannot approve or refuse your own time off request. Ask another approver.',
    );
  }
}

// Enforces the type's approvalMode, which was previously stored but never read -
// MANAGER and OFFICER behaved identically because both endpoints were gated on
// the HR_MANAGER role alone, so an employee's actual line manager got a 403.
//
//   OFFICER - an HR time off officer (HR_MANAGER and above) only.
//   MANAGER - the employee's own line manager, with officers still able to act
//             so a manager on leave, or an employee with no manager set, cannot
//             deadlock the queue.
//   NONE    - never reaches here; those requests are approved on submission.
//
// The modes are two kinds of approver, not two roles: MANAGER is a per-employee
// relationship, OFFICER is a role. The payroll roles are deliberately not
// options - they govern pay, not leave.
async function assertCanDecide(request, req, tx = prisma) {
  await assertNotSelf(request, req, tx);
  if (isHr(req.user.role)) return;

  const type = await tx.timeOffType.findUnique({
    where: { id: request.timeOffTypeId },
    select: { approvalMode: true, name: true },
  });

  if (type?.approvalMode === 'MANAGER') {
    const [employee, me] = await Promise.all([
      tx.employee.findUnique({ where: { id: request.employeeId }, select: { managerId: true } }),
      tx.employee.findFirst({ where: { userId: req.user.id }, select: { id: true } }),
    ]);
    if (me && employee?.managerId && employee.managerId === me.id) return;
    throw forbidden(`${type.name} is approved by the employee's manager or an HR officer`);
  }

  // OFFICER mode: the employee's own HR responsible is the named officer for
  // this case, so they can decide even without a blanket HR role.
  const [employee, me] = await Promise.all([
    tx.employee.findUnique({ where: { id: request.employeeId }, select: { hrResponsibleId: true } }),
    tx.employee.findFirst({ where: { userId: req.user.id }, select: { id: true } }),
  ]);
  if (me && employee?.hrResponsibleId && employee.hrResponsibleId === me.id) return;

  throw forbidden(
    `${type?.name ?? 'This leave type'} is approved by an HR officer or the employee's HR responsible`,
  );
}

router.post(
  '/requests/:id/approve',
  // Authorisation is per-request here, not per-role: see assertCanDecide.
  attachEmployee,
  asyncHandler(async (req, res) => {
    const row = await prisma.$transaction(async (tx) => {
      const request = await tx.leaveRequest.findUnique({ where: { id: req.params.id } });
      if (!request) throw notFound('Request not found');
      if (request.status === 'APPROVED') throw badRequest('Request is already approved');
      await assertCanDecide(request, req, tx);

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
  attachEmployee,
  asyncHandler(async (req, res) => {
    const { refusalReason } = z.object({ refusalReason: z.string().nullish() }).parse(req.body ?? {});

    const existing = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Request not found');
    await assertCanDecide(existing, req);

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
