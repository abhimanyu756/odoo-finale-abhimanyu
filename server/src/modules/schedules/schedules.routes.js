import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse, num } from '../../lib/http.js';
import { parseHHMM } from '../../lib/dates.js';

const router = Router();
router.use(authenticate);

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const lineSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM'),
    breakHours: z.coerce.number().min(0).max(12).default(0),
  })
  .refine((l) => parseHHMM(l.endTime) > parseHHMM(l.startTime), {
    message: 'End time must be after start time',
  });

const scheduleSchema = z.object({
  name: z.string().min(1),
  scheduleType: z.enum(['FULL_TIME', 'PART_TIME', 'FLEXIBLE']).default('FULL_TIME'),
  timezone: z.string().default('Asia/Kolkata'),
  companyId: z.string().uuid().nullish(),
  isActive: z.boolean().default(true),
  lines: z.array(lineSchema).default([]),
});

// Hours are always derived from the lines; the client never sends a total.
const lineHours = (l) =>
  Math.max(0, parseHHMM(l.endTime) - parseHHMM(l.startTime) - Number(l.breakHours || 0));

const weeklyHours = (lines) =>
  Number(lines.reduce((sum, l) => sum + lineHours(l), 0).toFixed(2));

const shape = (s) => ({
  ...s,
  hoursPerWeek: num(s.hoursPerWeek),
  daysPerWeek: s.lines ? new Set(s.lines.map((l) => l.dayOfWeek)).size : undefined,
  lines: s.lines
    ?.map((l) => ({
      ...l,
      breakHours: num(l.breakHours),
      dayName: DAYS[l.dayOfWeek],
      hours: Number(lineHours({ ...l, breakHours: num(l.breakHours) }).toFixed(2)),
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const where = q.search
      ? { name: { contains: q.search, mode: 'insensitive' } }
      : {};

    const [rows, total] = await Promise.all([
      prisma.workingSchedule.findMany({
        where,
        ...paginate(q),
        orderBy: { name: 'asc' },
        include: { lines: true, company: { select: { id: true, name: true } } },
      }),
      prisma.workingSchedule.count({ where }),
    ]);

    res.json(listResponse(rows.map(shape), total, q));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.workingSchedule.findUnique({
      where: { id: req.params.id },
      include: { lines: true, company: { select: { id: true, name: true } } },
    });
    if (!row) throw notFound('Working schedule not found');
    res.json(shape(row));
  }),
);

router.post(
  '/',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const { lines, ...data } = scheduleSchema.parse(req.body);
    if (new Set(lines.map((l) => l.dayOfWeek)).size !== lines.length) {
      throw badRequest('Each day can only appear once in a schedule');
    }

    const created = await prisma.workingSchedule.create({
      data: {
        ...data,
        hoursPerWeek: weeklyHours(lines),
        lines: { create: lines },
      },
      include: { lines: true, company: { select: { id: true, name: true } } },
    });
    res.status(201).json(shape(created));
  }),
);

router.put(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const { lines, ...data } = scheduleSchema.parse(req.body);
    if (new Set(lines.map((l) => l.dayOfWeek)).size !== lines.length) {
      throw badRequest('Each day can only appear once in a schedule');
    }

    // Lines are replaced wholesale so the derived total can never drift.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.workingScheduleLine.deleteMany({ where: { scheduleId: req.params.id } });
      return tx.workingSchedule.update({
        where: { id: req.params.id },
        data: {
          ...data,
          hoursPerWeek: weeklyHours(lines),
          lines: { create: lines },
        },
        include: { lines: true, company: { select: { id: true, name: true } } },
      });
    });
    res.json(shape(updated));
  }),
);

router.delete(
  '/:id',
  requireMinRole('HR_MANAGER'),
  asyncHandler(async (req, res) => {
    const inUse = await prisma.employee.count({ where: { workingScheduleId: req.params.id } });
    if (inUse) throw badRequest(`Schedule is assigned to ${inUse} employee(s)`);
    await prisma.workingSchedule.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

export default router;
