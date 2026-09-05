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
  // Set by withEmployeeCounts(); a structure loaded without it says "unknown"
  // rather than claiming zero.
  employeeCount: s.employeeCount,
  _count: undefined,
});

// How many people this structure actually pays right now. Contracts are not a
// proxy for that: most employees carry an expired contract alongside a running
// one, so the contract count runs near double the headcount.
//
// A running contract is one-per-employee (assertNoOverlap enforces it), so
// counting running contracts is already a distinct employee count.
async function withEmployeeCounts(structures) {
  const ids = structures.map((s) => s.id);
  if (!ids.length) return structures;

  const grouped = await prisma.contract.groupBy({
    by: ['salaryStructureId'],
    where: {
      salaryStructureId: { in: ids },
      status: 'RUNNING',
      employee: { status: 'ACTIVE' },
    },
    _count: { _all: true },
  });
  const byStructure = new Map(grouped.map((g) => [g.salaryStructureId, g._count._all]));

  return structures.map((s) => ({ ...s, employeeCount: byStructure.get(s.id) ?? 0 }));
}

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

    res.json(listResponse((await withEmployeeCounts(rows)).map(structureShape), total, q));
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
    const [withCount] = await withEmployeeCounts([row]);
    res.json(structureShape(withCount));
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
    const { expression, kind } = z
      .object({
        expression: z.string().min(1),
        kind: z.enum(['expression', 'condition']).default('expression'),
      })
      .parse(req.body);

    const result = validateExpression(expression, SAMPLE_CONTEXT);
    res.json({
      ...result,
      kind,
      // A condition gates the rule, so what matters is whether the sample data
      // passes it, not the number it produced.
      ...(kind === 'condition' && result.valid
        ? { passes: Boolean(result.sample) }
        : {}),
      sampleContext: SAMPLE_CONTEXT,
    });
  }),
);

const VARIABLE_HELP = [
  { name: 'wage', about: "Monthly wage on the contract that covers this period" },
  { name: 'worked_days', about: 'Days actually attended (falls back to scheduled days less unpaid leave)' },
  { name: 'worked_hours', about: 'Hours recorded on attendance for the period' },
  { name: 'overtime_hours', about: 'Hours beyond the working schedule' },
  { name: 'scheduled_days', about: 'Days the working schedule expected' },
  { name: 'scheduled_hours', about: 'Hours the working schedule expected' },
  { name: 'leave_days', about: 'Approved leave days of every type' },
  { name: 'unpaid_leave_days', about: 'Approved leave days on unpaid types only' },
  { name: 'days_in_period', about: 'Calendar days in the payroll period' },
];

const EXPRESSION_EXAMPLES = [
  { label: '40% of basic', code: 'categories.BASIC * 0.4' },
  { label: 'PF capped at 1800', code: 'min(categories.BASIC * 0.12, 1800)' },
  { label: 'Bonus only if 20+ days worked', code: 'worked_days >= 20 ? wage * 0.05 : 0' },
  { label: 'Overtime at 1.5x hourly', code: 'overtime_hours * (wage / 176) * 1.5' },
  { label: 'Prorate on attendance', code: 'roundTo(wage * (worked_days / max(scheduled_days, 1)), 2)' },
  { label: 'Deduct unpaid leave', code: 'roundTo(wage / days_in_period * unpaid_leave_days, 2)' },
  { label: 'Gross = basic + allowances', code: 'categories.BASIC + categories.ALLOWANCE' },
  { label: 'Net = gross - deductions', code: 'categories.GROSS - categories.DEDUCTION' },
];

const CONDITION_EXAMPLES = [
  { label: 'Only when a full month was worked', code: 'worked_days >= 20' },
  { label: 'Only for higher earners', code: 'wage > 100000' },
  { label: 'Only when overtime exists', code: 'overtime_hours > 0' },
  { label: 'Two tests at once', code: 'worked_days >= 20 and wage > 50000' },
  { label: 'Either test', code: 'overtime_hours > 0 or leave_days == 0' },
  { label: 'Skip when unpaid leave was taken', code: 'not (unpaid_leave_days > 0)' },
];

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
      // Names alone do not tell an author what a variable means or what it will
      // hold, so the form shows a description and the sample value beside each.
      reference: [
        ...VARIABLE_HELP.map((v) => ({ ...v, sample: SAMPLE_CONTEXT[v.name] })),
        ...Object.entries(SAMPLE_CONTEXT.categories).map(([c, sample]) => ({
          name: `categories.${c}`,
          about: `Running total of all ${c.toLowerCase()} rules that have already run`,
          sample,
        })),
        {
          name: 'rules.CODE',
          about: "Amount produced by an earlier rule, e.g. rules.HRA. Only rules with a lower sequence are available",
          sample: null,
        },
      ],
      functionHelp: [
        { name: 'min(a, b)', about: 'Smaller of two values — caps a deduction' },
        { name: 'max(a, b)', about: 'Larger of two values — sets a floor' },
        { name: 'roundTo(v, dp)', about: 'Round to dp decimal places, e.g. roundTo(x, 2)' },
        { name: 'round(v)', about: 'Round to the nearest whole number' },
        { name: 'floor(v) / ceil(v)', about: 'Round down / up' },
        { name: 'abs(v)', about: 'Drop the sign' },
      ],
      examples: EXPRESSION_EXAMPLES,
      conditionExamples: CONDITION_EXAMPLES,
    });
  }),
);

export default router;
