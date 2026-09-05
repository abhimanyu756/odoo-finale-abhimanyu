import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole, attachEmployee, isHr } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num } from '../../lib/http.js';
import { startOfDay, endOfDay, hoursBetween } from '../../lib/dates.js';
import {
  deriveMetrics,
  scheduleLineFor,
  openSessionFor,
  todayTotals,
} from './attendance.service.js';

const router = Router();
router.use(authenticate);

const RELATIONS = {
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      department: { select: { id: true, name: true } },
      manager: { select: { id: true, firstName: true, lastName: true } },
    },
  },
};

const shape = (a) => ({
  ...a,
  workedHours: num(a.workedHours),
  overtimeHours: num(a.overtimeHours),
  employee: a.employee
    ? {
        id: a.employee.id,
        name: `${a.employee.firstName} ${a.employee.lastName}`,
        department: a.employee.department,
        manager: a.employee.manager
          ? { id: a.employee.manager.id, name: `${a.employee.manager.firstName} ${a.employee.manager.lastName}` }
          : null,
      }
    : null,
});

// --- Self-service widget ---------------------------------------------------
router.get(
  '/me/status',
  attachEmployee,
  asyncHandler(async (req, res) => {
    if (!req.employee) throw badRequest('Your login is not linked to an employee record');
    const open = await openSessionFor(req.employee.id);
    res.json({
      checkedIn: Boolean(open),
      since: open?.checkIn ?? null,
      elapsedHours: open ? Number(hoursBetween(open.checkIn, new Date()).toFixed(2)) : 0,
      todayHours: await todayTotals(req.employee.id),
    });
  }),
);

router.post(
  '/me/check-in',
  attachEmployee,
  asyncHandler(async (req, res) => {
    if (!req.employee) throw badRequest('Your login is not linked to an employee record');
    if (await openSessionFor(req.employee.id)) {
      throw badRequest('You are already checked in');
    }

    const now = new Date();
    const line = await scheduleLineFor(req.employee.id, now);
    const { status } = deriveMetrics({ checkIn: now, checkOut: null, line });

    const row = await prisma.attendance.create({
      data: {
        employeeId: req.employee.id,
        checkIn: now,
        status: status === 'MISSING_CHECKOUT' ? 'PRESENT' : status,
      },
      include: RELATIONS,
    });
    res.status(201).json(shape(row));
  }),
);

router.post(
  '/me/check-out',
  attachEmployee,
  asyncHandler(async (req, res) => {
    if (!req.employee) throw badRequest('Your login is not linked to an employee record');
    const open = await openSessionFor(req.employee.id);
    if (!open) throw badRequest('You are not currently checked in');

    const now = new Date();
    // An open session dated in the future (typically an HR-entered record)
    // cannot be closed with the current clock without inverting the interval.
    if (now <= open.checkIn) {
      throw badRequest(
        'Your open session starts in the future and cannot be checked out now; ask HR to correct it',
      );
    }
    const line = await scheduleLineFor(req.employee.id, open.checkIn);
    const metrics = deriveMetrics({ checkIn: open.checkIn, checkOut: now, line });

    const row = await prisma.attendance.update({
      where: { id: open.id },
      data: { checkOut: now, ...metrics },
      include: RELATIONS,
    });
    res.json(shape(row));
  }),
);

// --- List / detail ---------------------------------------------------------
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const { employeeId, status, from, to, today } = req.query;

    const range = today === 'true'
      ? { gte: startOfDay(new Date()), lte: endOfDay(new Date()) }
      : from || to
        ? { ...(from ? { gte: startOfDay(new Date(from)) } : {}), ...(to ? { lte: endOfDay(new Date(to)) } : {}) }
        : undefined;

    const where = {
      ...(isHr(req.user.role) ? {} : { employee: { userId: req.user.id } }),
      ...(employeeId ? { employeeId } : {}),
      ...(status ? { status } : {}),
      ...(range ? { checkIn: range } : {}),
      ...(q.search
        ? {
            OR: [
              { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        ...paginate(q),
        orderBy: q.sortBy ? { [q.sortBy]: q.sortDir } : { checkIn: 'desc' },
        include: RELATIONS,
      }),
      prisma.attendance.count({ where }),
    ]);

    res.json(listResponse(rows.map(shape), total, q));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.attendance.findUnique({
      where: { id: req.params.id },
      include: RELATIONS,
    });
    if (!row) throw notFound('Attendance record not found');
    res.json(shape(row));
  }),
);

// --- HR corrections --------------------------------------------------------
const attendanceBase = z.object({
  employeeId: z.string().uuid(),
  checkIn: z.coerce.date(),
  checkOut: z.coerce.date().nullish(),
  notes: z.string().nullish(),
  status: z.enum(['PRESENT', 'LATE', 'ABSENT', 'MISSING_CHECKOUT']).optional(),
});

const attendanceSchema = attendanceBase.refine(
  (a) => !a.checkOut || a.checkOut > a.checkIn,
  { message: 'Check out must be after check in', path: ['checkOut'] },
);

// Refinements block .partial(); the merged record is re-checked in the handler.
const attendancePatchSchema = attendanceBase.partial();

// Hours are always recomputed server-side; a client cannot post worked hours
// that disagree with the timestamps.
const withMetrics = async (data) => {
  const line = await scheduleLineFor(data.employeeId, data.checkIn);
  const metrics = deriveMetrics({ checkIn: data.checkIn, checkOut: data.checkOut ?? null, line });
  return { ...metrics, ...(data.status ? { status: data.status } : {}) };
};

router.post(
  '/',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const data = attendanceSchema.parse(req.body);
    const row = await prisma.attendance.create({
      data: {
        ...data,
        ...(await withMetrics(data)),
        isManual: true,
        editedById: req.user.id,
      },
      include: RELATIONS,
    });
    res.status(201).json(shape(row));
  }),
);

router.patch(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const patch = attendancePatchSchema.parse(req.body);
    const current = await prisma.attendance.findUnique({ where: { id: req.params.id } });
    if (!current) throw notFound('Attendance record not found');

    const merged = { ...current, ...patch };
    if (merged.checkOut && merged.checkOut <= merged.checkIn) {
      throw badRequest('Check out must be after check in');
    }

    const row = await prisma.attendance.update({
      where: { id: current.id },
      data: {
        ...patch,
        ...(await withMetrics(merged)),
        isManual: true,
        editedById: req.user.id,
      },
      include: RELATIONS,
    });
    res.json(shape(row));
  }),
);

router.delete(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    await prisma.attendance.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

export default router;
