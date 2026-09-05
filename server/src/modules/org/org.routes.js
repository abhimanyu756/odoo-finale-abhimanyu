import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { toPatchSchema } from '../../lib/http.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';

const router = Router();
router.use(authenticate);

const hrOnly = requireMinRole('HR_MANAGER');

// --- Companies -------------------------------------------------------------
router.get(
  '/companies',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.company.findMany({ orderBy: { name: 'asc' } }));
  }),
);

router.post(
  '/companies',
  requireMinRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1), currency: z.string().default('INR') }).parse(req.body);
    res.status(201).json(await prisma.company.create({ data: body }));
  }),
);

// --- Departments -----------------------------------------------------------
router.get(
  '/departments',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.department.findMany({
      orderBy: { name: 'asc' },
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { employees: true, contracts: true } },
      },
    });
    res.json(rows.map((d) => ({
      ...d,
      employeeCount: d._count.employees,
      contractCount: d._count.contracts,
      _count: undefined,
    })));
  }),
);

const departmentSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().uuid(),
});

router.post(
  '/departments',
  hrOnly,
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.department.create({ data: departmentSchema.parse(req.body) }));
  }),
);

router.patch(
  '/departments/:id',
  hrOnly,
  asyncHandler(async (req, res) => {
    const data = toPatchSchema(departmentSchema).parse(req.body);
    res.json(await prisma.department.update({ where: { id: req.params.id }, data }));
  }),
);

router.delete(
  '/departments/:id',
  hrOnly,
  asyncHandler(async (req, res) => {
    await prisma.department.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// --- Job positions ---------------------------------------------------------
router.get(
  '/job-positions',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.jobPosition.findMany({ orderBy: { name: 'asc' } }));
  }),
);

router.post(
  '/job-positions',
  hrOnly,
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    res.status(201).json(await prisma.jobPosition.create({ data: body }));
  }),
);

router.patch(
  '/job-positions/:id',
  hrOnly,
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    res.json(await prisma.jobPosition.update({ where: { id: req.params.id }, data: body }));
  }),
);

router.delete(
  '/job-positions/:id',
  hrOnly,
  asyncHandler(async (req, res) => {
    await prisma.jobPosition.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

export default router;
