import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num, toPatchSchema } from '../../lib/http.js';
import { validateExpression } from './expression.js';
import { PERCENT_BASES } from './compute.js';

const router = Router();
router.use(authenticate);

// Payroll users may read configuration; only payroll admins may change it.
const canRead = requireMinRole('HR_PAYROLL_USER');
const canWrite = requireMinRole('HR_PAYROLL_ADMIN');

const ruleShape = (r) => ({
  ...r,
  amount: num(r.amount),
  percentage: num(r.percentage),
  quantity: num(r.quantity),
});

const structureShape = (s) => ({
  ...s,
  rules: s.rules?.map(ruleShape),
  ruleCount: s._count?.rules ?? s.rules?.length,
  contractCount: s._count?.contracts,
  _count: undefined,
});

// ---------------------------------------------------------- Structures ----
router.get(
  '/structures',
  canRead,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const where = q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { code: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [rows, total] = await Promise.all([
      prisma.salaryStructure.findMany({
        where,
        ...paginate(q),
        orderBy: { name: 'asc' },
        include: { _count: { select: { rules: true, contracts: true } } },
      }),
      prisma.salaryStructure.count({ where }),
    ]);

    res.json(listResponse(rows.map(structureShape), total, q));
  }),
);

router.get(
  '/structures/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const row = await prisma.salaryStructure.findUnique({
      where: { id: req.params.id },
      include: {
        rules: { orderBy: { sequence: 'asc' } },
        _count: { select: { rules: true, contracts: true } },
      },
    });
    if (!row) throw notFound('Salary structure not found');
    res.json(structureShape(row));
  }),
);

const structureSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).toUpperCase(),
  description: z.string().nullish(),
  isActive: z.boolean().default(true),
});

router.post(
  '/structures',
  canWrite,
  asyncHandler(async (req, res) => {
    const row = await prisma.salaryStructure.create({ data: structureSchema.parse(req.body) });
    res.status(201).json(structureShape(row));
  }),
);

router.patch(
  '/structures/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const data = toPatchSchema(structureSchema).parse(req.body);
    res.json(structureShape(await prisma.salaryStructure.update({ where: { id: req.params.id }, data })));
  }),
);

router.delete(
  '/structures/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const used = await prisma.payrun.count({ where: { structureId: req.params.id } });
    if (used) throw badRequest(`Structure is used by ${used} payrun(s); deactivate it instead`);
    await prisma.salaryStructure.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// --------------------------------------------------------------- Rules ----
router.get(
  '/rules',
  canRead,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { structureId, category } = req.query;

    const where = {
      ...(structureId ? { structureId } : {}),
      ...(category ? { category } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { code: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.salaryRule.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { sequence: 'asc' },
        include: { structure: { select: { id: true, name: true } } },
      }),
      prisma.salaryRule.count({ where }),
    ]);

    res.json(listResponse(rows.map(ruleShape), total, q));
  }),
);

router.get(
  '/rules/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const row = await prisma.salaryRule.findUnique({
      where: { id: req.params.id },
      include: { structure: { select: { id: true, name: true } } },
    });
    if (!row) throw notFound('Salary rule not found');
    res.json(ruleShape(row));
  }),
);

const ruleBase = z.object({
  structureId: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().min(1).toUpperCase(),
  category: z.enum(['BASIC', 'ALLOWANCE', 'GROSS', 'DEDUCTION', 'NET']),
  sequence: z.coerce.number().int().min(0).default(10),
  computeType: z.enum(['FIXED', 'PERCENTAGE', 'FORMULA']).default('FIXED'),
  amount: z.coerce.number().nullish(),
  percentage: z.coerce.number().nullish(),
  baseExpr: z.string().nullish(),
  expression: z.string().nullish(),
  condition: z.string().nullish(),
  quantity: z.coerce.number().default(1),
  isActive: z.boolean().default(true),
});

// Each computation type needs its own field populated, otherwise the rule
// silently contributes zero to every payslip.
const requiredForType = (r) => {
  if (r.computeType === 'FIXED') return r.amount != null || 'FIXED rules need an amount';
  if (r.computeType === 'PERCENTAGE') return r.percentage != null || 'PERCENTAGE rules need a percentage';
  if (r.computeType === 'FORMULA') return Boolean(r.expression) || 'FORMULA rules need an expression';
  return true;
};

const SAMPLE_CONTEXT = {
  wage: 100000,
  worked_days: 22,
  worked_hours: 176,
  overtime_hours: 0,
  scheduled_days: 22,
  scheduled_hours: 176,
  leave_days: 0,
  unpaid_leave_days: 0,
  days_in_period: 30,
  categories: { BASIC: 50000, ALLOWANCE: 15000, GROSS: 65000, DEDUCTION: 5000, NET: 60000 },
  rules: {},
};

const assertValid = (rule) => {
  const check = requiredForType(rule);
  if (check !== true) throw badRequest(check);

  for (const [field, src] of [['expression', rule.expression], ['condition', rule.condition]]) {
    if (!src) continue;
    const result = validateExpression(src, SAMPLE_CONTEXT);
    if (!result.valid) throw badRequest(`Invalid ${field}: ${result.error}`, result.details);
  }

  if (rule.computeType === 'PERCENTAGE' && rule.baseExpr && !PERCENT_BASES[rule.baseExpr.toUpperCase()]) {
    const result = validateExpression(rule.baseExpr, SAMPLE_CONTEXT);
    if (!result.valid) {
      throw badRequest(
        `Base must be one of ${Object.keys(PERCENT_BASES).join(', ')} or a valid expression: ${result.error}`,
      );
    }
  }
};

router.post(
  '/rules',
  canWrite,
  asyncHandler(async (req, res) => {
    const data = ruleBase.parse(req.body);
    assertValid(data);
    res.status(201).json(ruleShape(await prisma.salaryRule.create({ data })));
  }),
);

router.patch(
  '/rules/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const patch = toPatchSchema(ruleBase).parse(req.body);
    const current = await prisma.salaryRule.findUnique({ where: { id: req.params.id } });
    if (!current) throw notFound('Salary rule not found');

    assertValid({ ...current, ...patch });
    res.json(ruleShape(await prisma.salaryRule.update({ where: { id: current.id }, data: patch })));
  }),
);

router.delete(
  '/rules/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    await prisma.salaryRule.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// Lets the rule form check an expression before it reaches a payrun.
router.post(
  '/rules/validate',
  canRead,
  asyncHandler(async (req, res) => {
    const { expression } = z.object({ expression: z.string().min(1) }).parse(req.body);
    res.json({
      ...validateExpression(expression, SAMPLE_CONTEXT),
      sampleContext: SAMPLE_CONTEXT,
    });
  }),
);

router.get(
  '/rules-meta',
  canRead,
  asyncHandler(async (_req, res) => {
    res.json({
      categories: ['BASIC', 'ALLOWANCE', 'GROSS', 'DEDUCTION', 'NET'],
      computeTypes: ['FIXED', 'PERCENTAGE', 'FORMULA'],
      percentBases: Object.keys(PERCENT_BASES),
      variables: Object.keys(SAMPLE_CONTEXT).filter((k) => typeof SAMPLE_CONTEXT[k] !== 'object'),
      categoryRefs: Object.keys(SAMPLE_CONTEXT.categories).map((c) => `categories.${c}`),
      functions: ['min', 'max', 'round', 'roundTo', 'floor', 'ceil', 'abs'],
    });
  }),
);

export default router;
