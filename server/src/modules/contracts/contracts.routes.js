import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, isHr } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num, toPatchSchema } from '../../lib/http.js';
import { periodWindow } from '../../lib/dates.js';
import { nextReference, assertNoOverlap } from './contracts.service.js';

const contractFilterSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  expiringDays: z.coerce.number().int().min(1).max(365).optional(),
});

const router = Router();
router.use(authenticate);

const RELATIONS = {
  employee: { select: { id: true, firstName: true, lastName: true } },
  department: { select: { id: true, name: true } },
  jobPosition: { select: { id: true, name: true } },
  workingSchedule: { select: { id: true, name: true } },
  salaryStructure: { select: { id: true, name: true } },
};

const shape = (c) => ({
  ...c,
  wage: num(c.wage),
  employee: c.employee
    ? { id: c.employee.id, name: `${c.employee.firstName} ${c.employee.lastName}` }
    : null,
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const {
      employeeId, status, departmentId, jobPositionId, salaryStructureId, workingScheduleId,
    } = req.query;
    const f = contractFilterSchema.parse(req.query);

    // A contract is dated by when it starts, matching how the list is sorted.
    const window = periodWindow(f.year, f.month);

    // "Expiring" is the operational question this screen exists to answer -
    // which running contracts run out soon and need renewing. Open-ended ones
    // (endDate null) never expire, so the null check excludes them.
    const now = new Date();
    const expiringBefore = f.expiringDays
      ? new Date(now.getTime() + f.expiringDays * 86400000)
      : null;

    const where = {
      ...(isHr(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(employeeId ? { employeeId } : {}),
      ...(status ? { status } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(jobPositionId ? { jobPositionId } : {}),
      ...(salaryStructureId ? { salaryStructureId } : {}),
      ...(workingScheduleId ? { workingScheduleId } : {}),
      ...(window ? { startDate: window } : {}),
      ...(expiringBefore
        ? { status: 'RUNNING', endDate: { not: null, gte: now, lte: expiringBefore } }
        : {}),
      ...(q.search
        ? {
            OR: [
              { reference: { contains: q.search, mode: 'insensitive' } },
              { name: { contains: q.search, mode: 'insensitive' } },
              { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { startDate: 'desc' },
        include: RELATIONS,
      }),
      prisma.contract.count({ where }),
    ]);

    res.json(listResponse(rows.map(shape), total, q));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.contract.findUnique({
      where: { id: req.params.id },
      include: RELATIONS,
    });
    if (!row) throw notFound('Contract not found');
    res.json(shape(row));
  }),
);

const contractBase = z.object({
  name: z.string().min(1),
  employeeId: z.string().uuid(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullish(),
  wage: z.coerce.number().positive(),
  status: z.enum(['DRAFT', 'RUNNING', 'EXPIRED', 'CANCELLED']).default('DRAFT'),
  notes: z.string().nullish(),
  departmentId: z.string().uuid().nullish(),
  jobPositionId: z.string().uuid().nullish(),
  workingScheduleId: z.string().uuid().nullish(),
  salaryStructureId: z.string().uuid().nullish(),
});

const endAfterStart = (c) => !c.endDate || !c.startDate || c.endDate > c.startDate;

const contractSchema = contractBase.refine(endAfterStart, {
  message: 'End date must be after start date',
  path: ['endDate'],
});

// Refinements block .partial(), so patches validate against the bare object
// and re-check the cross-field rule against the merged record.
const contractPatchSchema = toPatchSchema(contractBase);

router.post(
  '/',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = contractSchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      if (data.status === 'RUNNING') await assertNoOverlap(data, tx);
      return tx.contract.create({
        data: { ...data, reference: await nextReference(data.startDate, tx) },
        include: RELATIONS,
      });
    });

    res.status(201).json(shape(created));
  }),
);

router.patch(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = contractPatchSchema.parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.contract.findUnique({ where: { id: req.params.id } });
      if (!current) throw notFound('Contract not found');

      const merged = { ...current, ...data };
      if (!endAfterStart(merged)) throw badRequest('End date must be after start date');
      if (merged.status === 'RUNNING') {
        await assertNoOverlap(
          {
            employeeId: merged.employeeId,
            startDate: merged.startDate,
            endDate: merged.endDate,
            excludeId: current.id,
          },
          tx,
        );
      }

      return tx.contract.update({ where: { id: current.id }, data, include: RELATIONS });
    });

    res.json(shape(updated));
  }),
);

router.delete(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const used = await prisma.payslip.count({ where: { contractId: req.params.id } });
    if (used) throw badRequest(`Contract is referenced by ${used} payslip(s) and cannot be deleted`);
    await prisma.contract.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

export default router;
