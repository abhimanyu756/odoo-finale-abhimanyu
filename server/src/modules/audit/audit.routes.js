import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { authenticate, requireMinRole } from '../../middleware/auth.js';
import { listQuerySchema, paginate, listResponse } from '../../lib/http.js';
import { periodWindow } from '../../lib/dates.js';

// Read-only. Nothing writes here through the API - rows come from the Prisma
// extension - so there is no create, update or delete route by design.
const router = Router();
router.use(authenticate, requireMinRole('HR_PAYROLL_ADMIN'));

const filters = z.object({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  action: z.enum(['create', 'update', 'delete']).optional(),
  actorId: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const f = filters.parse(req.query);
    const window = periodWindow(f.year, f.month);

    const where = {
      ...(f.entity ? { entity: f.entity } : {}),
      ...(f.entityId ? { entityId: f.entityId } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(f.actorId ? { actorId: f.actorId } : {}),
      ...(window ? { at: window } : {}),
      ...(q.search
        ? {
            OR: [
              { label: { contains: q.search, mode: 'insensitive' } },
              { actorEmail: { contains: q.search, mode: 'insensitive' } },
              { entity: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, ...paginate(q), orderBy: { at: 'desc' } }),
      prisma.auditLog.count({ where }),
    ]);

    res.json(listResponse(rows, total, q));
  }),
);

// The history of one record, for a History tab on its own screen.
router.get(
  '/:entity/:entityId',
  asyncHandler(async (req, res) => {
    const rows = await prisma.auditLog.findMany({
      where: { entity: req.params.entity, entityId: req.params.entityId },
      orderBy: { at: 'desc' },
      take: 100,
    });
    res.json(rows);
  }),
);

// Distinct values, so the UI can offer real filter options.
router.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    const entities = await prisma.auditLog.findMany({
      distinct: ['entity'], select: { entity: true }, orderBy: { entity: 'asc' },
    });
    res.json({
      entities: entities.map((e) => e.entity),
      actions: ['create', 'update', 'delete'],
    });
  }),
);

export default router;
