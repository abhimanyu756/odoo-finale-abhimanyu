import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, isPayroll } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num } from '../../lib/http.js';
import { contractForPeriod } from '../contracts/contracts.service.js';
import { renderPayslipPdf } from './payslip.pdf.js';
import { sendMail, mailEnabled } from '../../lib/mailer.js';
import {
  eligibleEmployees,
  nextPayslipNumber,
  computePayrun,
  collectWarnings,
  persistWarnings,
} from './payroll.service.js';

const router = Router();
router.use(authenticate);

const canRead = requireMinRole('HR_PAYROLL_USER');
const canWrite = requireMinRole('HR_PAYROLL_USER');
const canFinalise = requireMinRole('HR_PAYROLL_ADMIN');

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
  employee: s.employee
    ? { id: s.employee.id, name: `${s.employee.firstName} ${s.employee.lastName}`, workEmail: s.employee.workEmail }
    : undefined,
});

const runShape = (p) => ({
  ...p,
  payslips: p.payslips?.map(slipShape),
  payslipCount: p._count?.payslips ?? p.payslips?.length,
  totals: p.payslips
    ? {
        gross: Number(p.payslips.reduce((s, x) => s + Number(x.gross), 0).toFixed(2)),
        deduction: Number(p.payslips.reduce((s, x) => s + Number(x.deduction), 0).toFixed(2)),
        net: Number(p.payslips.reduce((s, x) => s + Number(x.net), 0).toFixed(2)),
      }
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
    const { status } = req.query;

    const where = {
      ...(status ? { status } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.payrun.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { periodStart: 'desc' },
        include: {
          structure: { select: { id: true, name: true } },
          _count: { select: { payslips: true } },
          payslips: { select: { gross: true, deduction: true, net: true } },
        },
      }),
      prisma.payrun.count({ where }),
    ]);

    res.json(listResponse(rows.map((r) => ({ ...runShape(r), payslips: undefined })), total, q));
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
          include: { employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } } },
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

    res.json({ ...runShape(updated), warnings });
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

// ------------------------------------------------------------ Payslips ----
router.get(
  '/payslips',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { payrunId, employeeId, status } = req.query;

    const where = {
      // Employees may read their own payslips; payroll roles see everything.
      ...(isPayroll(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(payrunId ? { payrunId } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(status ? { status } : {}),
      ...(q.search ? { number: { contains: q.search, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.payslip.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { periodStart: 'desc' },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, workEmail: true } },
          payrun: { select: { id: true, name: true } },
        },
      }),
      prisma.payslip.count({ where }),
    ]);

    res.json(listResponse(rows.map(slipShape), total, q));
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

    const results = { sent: 0, skipped: [], failed: [] };

    for (const slip of slips) {
      if (!slip.employee.workEmail) {
        results.skipped.push({ payslip: slip.number, reason: 'No work email' });
        continue;
      }
      try {
        const pdf = await renderPayslipPdf(slip);
        const { subject, text } = mailBody(slip);
        await sendMail({
          to: slip.employee.workEmail,
          subject,
          text,
          attachments: [{ filename: `${slip.number.replace(/\//g, '-')}.pdf`, content: pdf }],
        });
        await prisma.payslip.update({
          where: { id: slip.id },
          data: { emailSentAt: new Date() },
        });
        results.sent += 1;
      } catch (err) {
        results.failed.push({ payslip: slip.number, reason: err.message });
      }
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
