import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, isPayroll } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num } from '../../lib/http.js';
import { contractForPeriod } from '../contracts/contracts.service.js';
import { periodWindow } from '../../lib/dates.js';
import { sendCsv, EXPORT_LIMIT } from '../../lib/csv.js';
import { renderPayslipPdf } from './payslip.pdf.js';
import { sendMail, mailEnabled } from '../../lib/mailer.js';
import {
  eligibleEmployees,
  nextPayslipNumber,
  computePayrun,
  computeOnePayslip,
  collectWarnings,
  persistWarnings,
} from './payroll.service.js';

const router = Router();
router.use(authenticate);

const payrunFilterSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

const canRead = requireMinRole('HR_PAYROLL_USER');
const canWrite = requireMinRole('HR_PAYROLL_USER');
const canFinalise = requireMinRole('HR_PAYROLL_ADMIN');

// The list and its CSV export must filter identically, so each where clause is
// built once and shared. Export drops only the pagination.
const payrunWhereFor = (req) => {
  const q = listQuerySchema.parse(req.query);
  const { status, structureId } = req.query;
  const f = payrunFilterSchema.parse(req.query);
  // Year and month narrow on periodStart, which is what "the March payrun"
  // means - a run is named for the period it pays, not when it was created.
  const window = periodWindow(f.year, f.month);
  return {
    ...(status ? { status } : {}),
    ...(structureId ? { structureId } : {}),
    ...(window ? { periodStart: window } : {}),
    ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
  };
};

const payslipWhereFor = (req) => {
  const q = listQuerySchema.parse(req.query);
  const { payrunId, employeeId, status } = req.query;
  const f = payrunFilterSchema.parse(req.query);
  const window = periodWindow(f.year, f.month);
  return {
    // Employees may read their own payslips; payroll roles see everything.
    ...(isPayroll(req.user.role) ? {} : { employee: { userId: req.user.id } }),
    ...(payrunId ? { payrunId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(status ? { status } : {}),
    ...(window ? { periodStart: window } : {}),
    ...(q.search ? { number: { contains: q.search, mode: 'insensitive' } } : {}),
  };
};

// Compact labels matching the mockup's Warning column ("A/C missing", "Duplicate").
const WARNING_LABELS = {
  MISSING_BANK: 'A/C missing',
  MISSING_EMAIL: 'No email',
  DUPLICATE_PAYSLIP: 'Duplicate',
  NEGATIVE_NET: 'Negative net',
  ZERO_NET: 'Zero net',
  CONTRACT_NOT_RUNNING: 'Contract',
};

const slipShape = (s) => ({
  ...s,
  workedDays: num(s.workedDays),
  workedHours: num(s.workedHours),
  leaveDays: num(s.leaveDays),
  basic: num(s.basic),
  allowance: num(s.allowance),
  gross: num(s.gross),
  deduction: num(s.deduction),
  net: num(s.net),
  lines: s.lines?.map((l) => ({ ...l, amount: num(l.amount) })),
  // Short label for the list's Warning column; full messages stay in `warnings`.
  warningLabel: s.warnings?.length
    ? WARNING_LABELS[s.warnings[0].code] ?? 'Attention'
    : null,
  warningSeverity: s.warnings?.some((w) => w.severity === 'ERROR') ? 'ERROR' : (s.warnings?.length ? 'WARNING' : null),
  // Rebuilt rather than spread so `name` is composed once, but every other
  // selected field must be carried through: dropping bankAccount here made the
  // payslip page report "Not provided" for employees who do have one.
  employee: s.employee
    ? {
        id: s.employee.id,
        name: `${s.employee.firstName} ${s.employee.lastName}`,
        workEmail: s.employee.workEmail,
        bankAccount: s.employee.bankAccount,
        department: s.employee.department,
        jobPosition: s.employee.jobPosition,
      }
    : undefined,
});

const runShape = (p) => ({
  ...p,
  payslips: p.payslips?.map(slipShape),
  payslipCount: p._count?.payslips ?? p.payslips?.length,
  // Accumulated tally for the list's Warnings column. Errors are counted
  // separately because they block validation while advisories do not.
  // Left undefined when the relation was not loaded, so a caller can tell
  // "no warnings" apart from "not asked for".
  warningCount: p.warnings ? p.warnings.length : undefined,
  errorCount: p.warnings ? p.warnings.filter((w) => w.severity === 'ERROR').length : undefined,
  totals: p.payslips
    ? (() => {
        const live = p.payslips.filter((x) => x.status !== 'CANCELLED');
        const sum = (k) => Number(live.reduce((s, x) => s + Number(x[k]), 0).toFixed(2));
        return { gross: sum('gross'), deduction: sum('deduction'), net: sum('net') };
      })()
    : undefined,
  _count: undefined,
});

// ------------------------------------------------- Wizard: step 2 preview --
// Step 1 of the wizard collects scope only; nothing is persisted until the
// user confirms a selection, so this endpoint just previews who is eligible.
router.get(
  '/payruns/eligible',
  canRead,
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
        departmentId: z.string().uuid().optional(),
        employeeType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']).optional(),
      })
      .parse(req.query);

    if (q.periodEnd < q.periodStart) throw badRequest('Period end must be after period start');
    res.json(await eligibleEmployees(q));
  }),
);

// ------------------------------------------------------------- Payruns ----
router.get(
  '/payruns',
  canRead,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const where = payrunWhereFor(req);

    const [rows, total] = await Promise.all([
      prisma.payrun.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { periodStart: 'desc' },
        include: {
          structure: { select: { id: true, name: true } },
          _count: { select: { payslips: true } },
          payslips: { select: { gross: true, deduction: true, net: true } },
          warnings: { select: { severity: true } },
        },
      }),
      prisma.payrun.count({ where }),
    ]);

    res.json(listResponse(
      rows.map((r) => ({ ...runShape(r), payslips: undefined, warnings: undefined })),
      total,
      q,
    ));
  }),
);

// CSV of the payruns currently on screen - same filters, no pagination.
router.get(
  '/payruns/export',
  canRead,
  asyncHandler(async (req, res) => {
    const rows = await prisma.payrun.findMany({
      where: payrunWhereFor(req),
      orderBy: { periodStart: 'desc' },
      take: EXPORT_LIMIT,
      include: {
        structure: { select: { name: true } },
        payslips: { select: { gross: true, deduction: true, net: true, status: true } },
        warnings: { select: { id: true } },
      },
    });
    sendCsv(res, 'payruns', PAYRUN_CSV, rows);
  }),
);

router.get(
  '/payruns/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const row = await prisma.payrun.findUnique({
      where: { id: req.params.id },
      include: {
        structure: { select: { id: true, name: true, code: true } },
        warnings: { orderBy: { severity: 'asc' } },
        payslips: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
            // Drives the per-row Warning column, so an issue is visible against
            // the payslip it belongs to and not only in the summary banner.
            warnings: { select: { id: true, code: true, message: true, severity: true } },
          },
          orderBy: { number: 'asc' },
        },
      },
    });
    if (!row) throw notFound('Payrun not found');
    res.json(runShape(row));
  }),
);

const createPayrunSchema = z
  .object({
    name: z.string().min(1),
    structureId: z.string().uuid(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    employeeIds: z.array(z.string().uuid()).min(1, 'Select at least one employee'),
  })
  .refine((p) => p.periodEnd >= p.periodStart, {
    message: 'Period end must be after period start',
    path: ['periodEnd'],
  });

// Wizard "Create Payrun": the run and its payslips are created together, so a
// payrun never exists in a half-built state.
router.post(
  '/payruns',
  canWrite,
  asyncHandler(async (req, res) => {
    const data = createPayrunSchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      const structure = await tx.salaryStructure.findUnique({ where: { id: data.structureId } });
      if (!structure) throw notFound('Salary structure not found');

      const payrun = await tx.payrun.create({
        data: {
          name: data.name,
          structureId: data.structureId,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
        },
      });

      const skipped = [];
      for (const employeeId of data.employeeIds) {
        const contract = await contractForPeriod(employeeId, data.periodStart, data.periodEnd, tx);
        if (!contract) {
          skipped.push(employeeId);
          continue;
        }
        await tx.payslip.create({
          data: {
            number: await nextPayslipNumber(data.periodStart, tx),
            payrunId: payrun.id,
            employeeId,
            contractId: contract.id,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
          },
        });
      }

      if (skipped.length === data.employeeIds.length) {
        throw badRequest('None of the selected employees have a contract covering this period');
      }

      return { payrun, skipped };
    });

    const full = await prisma.payrun.findUnique({
      where: { id: created.payrun.id },
      include: {
        structure: { select: { id: true, name: true } },
        payslips: { include: { employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } } } },
      },
    });

    res.status(201).json({ ...runShape(full), skippedEmployeeIds: created.skipped });
  }),
);

// ------------------------------------------------------------ Workflow ----
// Renaming is always allowed; the period and structure define what the payslips
// were computed from, so they can only move while the run is still DRAFT.
const updatePayrunSchema = z
  .object({
    name: z.string().min(1).optional(),
    structureId: z.string().uuid().optional(),
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

router.patch(
  '/payruns/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const body = updatePayrunSchema.parse(req.body);
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');

    const structural = ['structureId', 'periodStart', 'periodEnd'].filter((k) => k in body);
    if (structural.length && payrun.status !== 'DRAFT') {
      throw badRequest(
        `This payrun is ${payrun.status.toLowerCase()}; only its name can be changed. `
        + 'Reset it to draft by recomputing, or create a new run.',
      );
    }

    const periodStart = body.periodStart ?? payrun.periodStart;
    const periodEnd = body.periodEnd ?? payrun.periodEnd;
    if (periodEnd < periodStart) throw badRequest('Period end must be after period start');

    await prisma.payrun.update({
      where: { id: payrun.id },
      data: { ...body, periodStart, periodEnd },
    });

    // A moved period changes every payslip's window, so the stored figures are
    // stale until recompute; say so rather than leaving a silent mismatch.
    if (structural.length) {
      await prisma.payslip.updateMany({
        where: { payrunId: payrun.id },
        data: { periodStart, periodEnd },
      });
    }

    const full = await prisma.payrun.findUnique({
      where: { id: payrun.id },
      include: {
        structure: { select: { id: true, name: true, code: true } },
        warnings: { orderBy: { severity: 'asc' } },
        payslips: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
            warnings: { select: { id: true, code: true, message: true, severity: true } },
          },
          orderBy: { number: 'asc' },
        },
      },
    });
    res.json({ ...runShape(full), needsRecompute: structural.length > 0 });
  }),
);

// Adds employees to an existing run. Together with removing a payslip this
// makes the roster editable, so forgetting someone does not mean deleting the
// payrun and rebuilding it.
const addPayslipsSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1, 'Select at least one employee'),
});

router.post(
  '/payruns/:id/payslips',
  canWrite,
  asyncHandler(async (req, res) => {
    const { employeeIds } = addPayslipsSchema.parse(req.body);
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');
    if (!['DRAFT', 'COMPUTED'].includes(payrun.status)) {
      throw badRequest(
        `This payrun is ${payrun.status.toLowerCase()}; its roster can no longer be changed`,
      );
    }

    const added = [];
    const skipped = [];
    await prisma.$transaction(async (tx) => {
      const already = new Set(
        (await tx.payslip.findMany({
          where: { payrunId: payrun.id }, select: { employeeId: true },
        })).map((p) => p.employeeId),
      );

      for (const employeeId of employeeIds) {
        if (already.has(employeeId)) {
          skipped.push({ employeeId, reason: 'Already in this payrun' });
          continue;
        }
        const contract = await contractForPeriod(employeeId, payrun.periodStart, payrun.periodEnd, tx);
        if (!contract) {
          skipped.push({ employeeId, reason: 'No contract covers this period' });
          continue;
        }
        await tx.payslip.create({
          data: {
            number: await nextPayslipNumber(payrun.periodStart, tx),
            payrunId: payrun.id,
            employeeId,
            contractId: contract.id,
            periodStart: payrun.periodStart,
            periodEnd: payrun.periodEnd,
          },
        });
        added.push(employeeId);
      }
    });

    // New payslips arrive as DRAFT, so the run drops back to DRAFT rather than
    // claiming to be computed while some of its rows hold no figures.
    if (added.length && payrun.status === 'COMPUTED') {
      await prisma.payrun.update({
        where: { id: payrun.id }, data: { status: 'DRAFT', computedAt: null },
      });
    }

    const fresh = await prisma.payrun.findUnique({ where: { id: payrun.id } });
    await persistWarnings(fresh.id, await collectWarnings(fresh));

    const full = await prisma.payrun.findUnique({
      where: { id: payrun.id },
      include: {
        structure: { select: { id: true, name: true, code: true } },
        warnings: { orderBy: { severity: 'asc' } },
        payslips: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
            warnings: { select: { id: true, code: true, message: true, severity: true } },
          },
          orderBy: { number: 'asc' },
        },
      },
    });
    res.json({ added: added.length, skipped, payrun: runShape(full) });
  }),
);

router.post(
  '/payruns/:id/compute',
  canWrite,
  asyncHandler(async (req, res) => {
    await computePayrun(req.params.id);
    const row = await prisma.payrun.findUnique({
      where: { id: req.params.id },
      include: {
        structure: { select: { id: true, name: true } },
        warnings: true,
        payslips: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
            lines: { orderBy: { sequence: 'asc' } },
          },
        },
      },
    });
    res.json(runShape(row));
  }),
);

router.post(
  '/payruns/:id/validate',
  canFinalise,
  asyncHandler(async (req, res) => {
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');
    if (payrun.status !== 'COMPUTED') {
      throw badRequest('Only a computed payrun can be validated');
    }

    // ERROR-level warnings are blocking; WARNING-level ones are advisory.
    const warnings = await persistWarnings(payrun.id, await collectWarnings(payrun));
    const blocking = warnings.filter((w) => w.severity === 'ERROR');
    if (blocking.length) {
      throw badRequest('Resolve blocking payroll errors before validating', { warnings: blocking });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.payslip.updateMany({ where: { payrunId: payrun.id }, data: { status: 'VALIDATED' } });
      return tx.payrun.update({
        where: { id: payrun.id },
        data: { status: 'VALIDATED', validatedAt: new Date() },
      });
    });

    // Fold the freshly collected warnings in before shaping, so the counts on
    // the response match the list they are derived from.
    res.json(runShape({ ...updated, warnings }));
  }),
);

router.post(
  '/payruns/:id/mark-paid',
  canFinalise,
  asyncHandler(async (req, res) => {
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');
    if (payrun.status !== 'VALIDATED') throw badRequest('Only a validated payrun can be marked paid');

    const updated = await prisma.$transaction(async (tx) => {
      await tx.payslip.updateMany({ where: { payrunId: payrun.id }, data: { status: 'PAID' } });
      return tx.payrun.update({
        where: { id: payrun.id },
        data: { status: 'PAID', paidAt: new Date() },
      });
    });

    res.json(runShape(updated));
  }),
);

router.delete(
  '/payruns/:id',
  canFinalise,
  asyncHandler(async (req, res) => {
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');
    // Paid runs are historical records and must survive.
    if (payrun.status === 'PAID') throw badRequest('A paid payrun cannot be deleted');
    await prisma.payrun.delete({ where: { id: payrun.id } });
    res.status(204).end();
  }),
);

// Removes one payslip from a run. This is the fix for a roster mistake - an
// employee who should not have been included, or a duplicate that blocks
// validation - so the whole payrun does not have to be deleted and rebuilt.
//
// Only before validation: once a run is validated or paid its payslips are
// financial records, and the way to retract one of those is to cancel the run.
router.delete(
  '/payslips/:id',
  canFinalise,
  asyncHandler(async (req, res) => {
    const slip = await prisma.payslip.findUnique({
      where: { id: req.params.id },
      include: { payrun: true, employee: { select: { firstName: true, lastName: true } } },
    });
    if (!slip) throw notFound('Payslip not found');

    if (['VALIDATED', 'PAID'].includes(slip.payrun.status)) {
      throw badRequest(
        `This payrun is ${slip.payrun.status.toLowerCase()}; its payslips can no longer be removed`,
      );
    }
    if (['VALIDATED', 'PAID'].includes(slip.status)) {
      throw badRequest('A validated or paid payslip cannot be removed');
    }

    // Lines and this payslip's own warnings cascade away with it; the run-level
    // warnings are then recollected so a cleared DUPLICATE_PAYSLIP stops
    // blocking validation straight away.
    await prisma.payslip.delete({ where: { id: slip.id } });

    const payrun = await prisma.payrun.findUnique({ where: { id: slip.payrunId } });
    await persistWarnings(payrun.id, await collectWarnings(payrun));

    const full = await prisma.payrun.findUnique({
      where: { id: payrun.id },
      include: {
        structure: { select: { id: true, name: true, code: true } },
        warnings: { orderBy: { severity: 'asc' } },
        payslips: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
            warnings: { select: { id: true, code: true, message: true, severity: true } },
          },
          orderBy: { number: 'asc' },
        },
      },
    });
    res.json({
      removed: `${slip.employee.firstName} ${slip.employee.lastName}`,
      payrun: runShape(full),
    });
  }),
);

// ------------------------------------------------------------ Payslips ----
router.get(
  '/payslips',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const where = payslipWhereFor(req);

    const [rows, total] = await Promise.all([
      prisma.payslip.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { periodStart: 'desc' },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
          payrun: { select: { id: true, name: true, structure: { select: { name: true } } } },
          warnings: { select: { code: true, message: true, severity: true } },
        },
      }),
      prisma.payslip.count({ where }),
    ]);

    res.json(listResponse(rows.map(slipShape), total, q));
  }),
);

const PAYSLIP_CSV = [
  { header: 'Payslip', value: (r) => r.number },
  { header: 'Employee', value: (r) => `${r.employee.firstName} ${r.employee.lastName}` },
  { header: 'Work Email', value: (r) => r.employee.workEmail },
  { header: 'Bank Account', value: (r) => r.employee.bankAccount },
  { header: 'Payrun', value: (r) => r.payrun?.name },
  { header: 'Structure', value: (r) => r.payrun?.structure?.name },
  { header: 'Period Start', value: (r) => r.periodStart },
  { header: 'Period End', value: (r) => r.periodEnd },
  { header: 'Worked Days', value: (r) => num(r.workedDays) },
  { header: 'Worked Hours', value: (r) => num(r.workedHours) },
  { header: 'Leave Days', value: (r) => num(r.leaveDays) },
  { header: 'Basic', value: (r) => num(r.basic) },
  { header: 'Allowances', value: (r) => num(r.allowance) },
  { header: 'Gross', value: (r) => num(r.gross) },
  { header: 'Deductions', value: (r) => num(r.deduction) },
  { header: 'Net', value: (r) => num(r.net) },
  { header: 'Status', value: (r) => r.status },
  { header: 'Warnings', value: (r) => r.warnings.map((w) => w.message).join('; ') },
];

const PAYRUN_CSV = [
  { header: 'Payrun', value: (r) => r.name },
  { header: 'Structure', value: (r) => r.structure?.name },
  { header: 'Period Start', value: (r) => r.periodStart },
  { header: 'Period End', value: (r) => r.periodEnd },
  { header: 'Status', value: (r) => r.status },
  { header: 'Payslips', value: (r) => r.payslips.length },
  { header: 'Gross', value: (r) => r.payslips.reduce((s, x) => s + Number(x.gross), 0).toFixed(2) },
  { header: 'Deductions', value: (r) => r.payslips.reduce((s, x) => s + Number(x.deduction), 0).toFixed(2) },
  { header: 'Net', value: (r) => r.payslips.reduce((s, x) => s + Number(x.net), 0).toFixed(2) },
  { header: 'Warnings', value: (r) => r.warnings.length },
  { header: 'Paid At', value: (r) => r.paidAt },
];

const PAYSLIP_DETAIL = {
  employee: {
    select: {
      id: true, firstName: true, lastName: true, workEmail: true, bankAccount: true,
      department: { select: { id: true, name: true } },
      jobPosition: { select: { id: true, name: true } },
    },
  },
  contract: { select: { id: true, reference: true, wage: true, status: true } },
  payrun: { select: { id: true, name: true, status: true, structure: { select: { id: true, name: true } } } },
  lines: { orderBy: { sequence: 'asc' } },
  warnings: true,
};

const loadPayslip = async (id) => {
  const row = await prisma.payslip.findUnique({ where: { id }, include: PAYSLIP_DETAIL });
  return { ...slipShape(row), contract: { ...row.contract, wage: num(row.contract.wage) } };
};

// CSV of the payslips currently on screen. This is the register a payroll team
// actually hands to finance, so it carries the bank account and the warnings.
router.get(
  '/payslips/export',
  asyncHandler(async (req, res) => {
    const rows = await prisma.payslip.findMany({
      where: payslipWhereFor(req),
      orderBy: { periodStart: 'desc' },
      take: EXPORT_LIMIT,
      include: {
        employee: { select: { firstName: true, lastName: true, workEmail: true, bankAccount: true } },
        payrun: { select: { name: true, structure: { select: { name: true } } } },
        warnings: { select: { message: true } },
      },
    });
    sendCsv(res, 'payslips', PAYSLIP_CSV, rows);
  }),
);

router.get(
  '/payslips/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.payslip.findUnique({
      where: { id: req.params.id },
      include: {
        employee: {
          select: {
            id: true, firstName: true, lastName: true, workEmail: true, bankAccount: true,
            department: { select: { id: true, name: true } },
            jobPosition: { select: { id: true, name: true } },
          },
        },
        contract: { select: { id: true, reference: true, wage: true, status: true } },
        payrun: { select: { id: true, name: true, status: true, structure: { select: { id: true, name: true } } } },
        lines: { orderBy: { sequence: 'asc' } },
        warnings: true,
      },
    });
    if (!row) throw notFound('Payslip not found');
    if (!isPayroll(req.user.role) && row.employee.id) {
      const own = await prisma.employee.findFirst({
        where: { id: row.employee.id, userId: req.user.id },
        select: { id: true },
      });
      if (!own) throw forbidden();
    }

    res.json({ ...slipShape(row), contract: { ...row.contract, wage: num(row.contract.wage) } });
  }),
);

router.post(
  '/payslips/:id/compute',
  canWrite,
  asyncHandler(async (req, res) => {
    const slip = await prisma.payslip.findUnique({
      where: { id: req.params.id },
      include: { payrun: { include: { structure: { include: { rules: true } } } } },
    });
    if (!slip) throw notFound('Payslip not found');
    if (['VALIDATED', 'PAID'].includes(slip.payrun.status)) {
      throw badRequest(`This payslip belongs to a ${slip.payrun.status.toLowerCase()} payrun and cannot be recomputed`);
    }
    if (!slip.payrun.structure.rules.length) {
      throw badRequest(`Structure ${slip.payrun.structure.name} has no salary rules`);
    }

    await prisma.$transaction(
      (tx) => computeOnePayslip(slip.id, slip.payrun.structure.rules, slip.payrun, tx),
      { timeout: 20_000 },
    );

    // Warnings are payrun-wide, so recompute them for the whole run.
    await persistWarnings(slip.payrunId, await collectWarnings(slip.payrun));

    res.json(await loadPayslip(slip.id));
  }),
);

router.post(
  '/payslips/:id/validate',
  canFinalise,
  asyncHandler(async (req, res) => {
    const slip = await prisma.payslip.findUnique({
      where: { id: req.params.id },
      include: { payrun: true, warnings: true },
    });
    if (!slip) throw notFound('Payslip not found');
    if (slip.status === 'DRAFT') throw badRequest('Compute this payslip before validating it');
    if (['VALIDATED', 'PAID'].includes(slip.status)) {
      throw badRequest('This payslip is already validated');
    }

    // Only this payslip's own blocking issues stop it; a problem on someone
    // else's payslip should not hold this one up.
    const blocking = slip.warnings.filter((w) => w.severity === 'ERROR');
    if (blocking.length) {
      throw badRequest(
        `Resolve this payslip's blocking issue: ${blocking.map((w) => w.message).join('; ')}`,
        { warnings: blocking },
      );
    }

    await prisma.payslip.update({ where: { id: slip.id }, data: { status: 'VALIDATED' } });

    // Once every payslip is validated, the run itself is validated.
    const pending = await prisma.payslip.count({
      where: { payrunId: slip.payrunId, status: { in: ['DRAFT', 'COMPUTED'] } },
    });
    if (!pending && slip.payrun.status === 'COMPUTED') {
      await prisma.payrun.update({
        where: { id: slip.payrunId },
        data: { status: 'VALIDATED', validatedAt: new Date() },
      });
    }

    res.json(await loadPayslip(slip.id));
  }),
);

router.post(
  '/payslips/:id/mark-paid',
  canFinalise,
  asyncHandler(async (req, res) => {
    const slip = await prisma.payslip.findUnique({
      where: { id: req.params.id },
      include: { payrun: true },
    });
    if (!slip) throw notFound('Payslip not found');
    // The payslip itself must be validated first; the payrun follows along as
    // its payslips are validated, so there is no need to leave this screen.
    if (slip.status === 'DRAFT') throw badRequest('Compute and validate this payslip first');
    if (slip.status === 'COMPUTED') throw badRequest('Validate this payslip before marking it paid');
    if (slip.status === 'PAID') throw badRequest('This payslip is already marked paid');

    await prisma.payslip.update({ where: { id: slip.id }, data: { status: 'PAID' } });

    // When every payslip is paid, the run itself is paid.
    const outstanding = await prisma.payslip.count({
      where: { payrunId: slip.payrunId, status: { not: 'PAID' } },
    });
    if (!outstanding && slip.payrun.status !== 'PAID') {
      await prisma.payrun.update({
        where: { id: slip.payrunId },
        data: { status: 'PAID', paidAt: new Date() },
      });
    }

    res.json(await loadPayslip(slip.id));
  }),
);

// ----------------------------------------------------- PDF & delivery ----
const PDF_INCLUDE = {
  employee: {
    include: {
      company: { select: { name: true } },
      department: { select: { name: true } },
      jobPosition: { select: { name: true } },
    },
  },
  contract: { select: { reference: true, wage: true } },
  payrun: { select: { name: true, structure: { select: { name: true } } } },
  lines: { orderBy: { sequence: 'asc' } },
};

const loadForPdf = (where) => prisma.payslip.findFirst({ where, include: PDF_INCLUDE });

// Voids a payslip without erasing it.
//
// Deleting is only right before validation, when the roster was simply wrong.
// After that a payslip is a financial record, and the way to retract one is to
// cancel it: the row, its lines and its figures all survive for audit, but it
// stops counting toward the payrun totals and stops triggering the duplicate
// warning - which is exactly how an overlapping payslip gets resolved on a run
// that has already been validated or paid.
router.post(
  '/payslips/:id/cancel',
  canFinalise,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {});

    const slip = await prisma.payslip.findUnique({
      where: { id: req.params.id },
      include: { payrun: true },
    });
    if (!slip) throw notFound('Payslip not found');
    if (slip.status === 'CANCELLED') throw badRequest('This payslip is already cancelled');

    const updated = await prisma.payslip.update({
      where: { id: slip.id },
      data: { status: 'CANCELLED' },
      include: PAYSLIP_DETAIL,
    });

    // Recollect so a DUPLICATE_PAYSLIP raised against this slip clears at once.
    await persistWarnings(slip.payrunId, await collectWarnings(slip.payrun));

    res.json({ ...slipShape(updated), cancelReason: reason ?? null });
  }),
);

router.get(
  '/payslips/:id/pdf',
  asyncHandler(async (req, res) => {
    const slip = await loadForPdf({ id: req.params.id });
    if (!slip) throw notFound('Payslip not found');

    // Employees may print only their own payslip.
    if (!isPayroll(req.user.role)) {
      const own = await prisma.employee.findFirst({
        where: { id: slip.employeeId, userId: req.user.id },
        select: { id: true },
      });
      if (!own) throw forbidden();
    }

    const pdf = await renderPayslipPdf(slip);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${slip.number.replace(/\//g, '-')}.pdf"`,
    );
    res.send(pdf);
  }),
);

const mailBody = (slip) => {
  const period = new Date(slip.periodStart).toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric',
  });
  const net = Number(slip.net).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  return {
    subject: `Payslip for ${period} — ${slip.number}`,
    text:
      `Hello ${slip.employee.firstName},\n\n`
      + `Your payslip for ${period} is attached.\n\n`
      + `Payslip: ${slip.number}\nNet salary: INR ${net}\n\n`
      + 'This is an automated message from PeoplePay360.',
  };
};

// Bulk delivery from the payrun screen: one PDF per payslip, attached and sent.
// Dry-run view of exactly what "Send Payslips" will do.
//
// The whole roster comes back in one request - who receives, who is skipped and
// why, and each person's rendered subject and body - so the UI can show the list
// and switch between recipients without another round trip. Bodies come from the
// same mailBody() the sender uses, so the preview cannot drift from reality.
//
// PDFs are not rendered here: only the attachment filename is reported, which
// keeps a preview of 87 payslips instant.
router.get(
  '/payruns/:id/send-preview',
  canFinalise,
  asyncHandler(async (req, res) => {
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');

    const slips = await prisma.payslip.findMany({
      where: { payrunId: payrun.id },
      include: PDF_INCLUDE,
      orderBy: { number: 'asc' },
    });

    const recipients = slips.map((slip) => {
      // Cancelled payslips are void and are never sent.
      const blocked = !slip.employee.workEmail
        ? 'No work email on file'
        : slip.status === 'CANCELLED'
          ? 'Payslip is cancelled'
          : null;
      const { subject, text } = mailBody(slip);
      return {
        payslipId: slip.id,
        number: slip.number,
        employeeId: slip.employee.id,
        name: `${slip.employee.firstName} ${slip.employee.lastName}`,
        to: slip.employee.workEmail,
        deliverable: !blocked,
        reason: blocked,
        subject,
        text,
        attachment: `${slip.number.replace(/\//g, '-')}.pdf`,
        alreadySentAt: slip.emailSentAt,
      };
    });

    res.json({
      payrun: { id: payrun.id, name: payrun.name, status: payrun.status },
      // Says up front whether this will actually leave the server.
      smtp: { configured: mailEnabled() },
      canSend: ['VALIDATED', 'PAID'].includes(payrun.status),
      summary: {
        total: recipients.length,
        deliverable: recipients.filter((r) => r.deliverable).length,
        skipped: recipients.filter((r) => !r.deliverable).length,
        resend: recipients.filter((r) => r.deliverable && r.alreadySentAt).length,
      },
      recipients,
    });
  }),
);

router.post(
  '/payruns/:id/send',
  canFinalise,
  asyncHandler(async (req, res) => {
    const payrun = await prisma.payrun.findUnique({ where: { id: req.params.id } });
    if (!payrun) throw notFound('Payrun not found');
    if (!['VALIDATED', 'PAID'].includes(payrun.status)) {
      throw badRequest('Only a validated or paid payrun can be sent');
    }

    const slips = await prisma.payslip.findMany({
      where: { payrunId: payrun.id },
      include: PDF_INCLUDE,
    });

    const results = { sent: 0, prepared: 0, skipped: [], failed: [] };

    const deliverable = slips.filter((slip) => {
      if (slip.employee.workEmail) return true;
      results.skipped.push({ payslip: slip.number, reason: 'No work email' });
      return false;
    });

    // A Gmail round trip is several seconds, so sending a whole payrun in
    // series would hold the request open for a minute. Send in small
    // concurrent batches instead - fast, but well under Gmail's rate limits.
    const BATCH = 4;
    const sendOne = async (slip) => {
      try {
        const pdf = await renderPayslipPdf(slip);
        const { subject, text } = mailBody(slip);
        const outcome = await sendMail({
          to: slip.employee.workEmail,
          subject,
          text,
          attachments: [{ filename: `${slip.number.replace(/\//g, '-')}.pdf`, content: pdf }],
        });

        // Only a real delivery counts as sent. A dry run still renders every
        // PDF, but stamping emailSentAt would claim a delivery that never left.
        if (outcome.delivered) {
          await prisma.payslip.update({
            where: { id: slip.id },
            data: { emailSentAt: new Date() },
          });
          results.sent += 1;
        } else {
          results.prepared += 1;
        }
      } catch (err) {
        results.failed.push({ payslip: slip.number, reason: err.message });
      }
    };

    for (let i = 0; i < deliverable.length; i += BATCH) {
      await Promise.all(deliverable.slice(i, i + BATCH).map(sendOne));
    }

    await prisma.payrun.update({ where: { id: payrun.id }, data: { sentAt: new Date() } });

    res.json({
      ...results,
      // Surfaced so the UI can tell the user nothing actually left the building.
      dryRun: !mailEnabled(),
    });
  }),
);

export default router;
