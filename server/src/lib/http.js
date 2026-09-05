import { z } from 'zod';

// zod's .partial() keeps each field's .default(), so a PATCH that omits a
// defaulted key silently rewrites it (a wage-only edit would reset a contract's
// status to DRAFT). Patch schemas must strip defaults, not just add optional().
export const toPatchSchema = (objectSchema) =>
  z.object(
    Object.fromEntries(
      Object.entries(objectSchema.shape).map(([key, field]) => [
        key,
        typeof field.removeDefault === 'function'
          ? field.removeDefault().optional()
          : field.optional(),
      ]),
    ),
  );

// Shared list-query contract: every list endpoint accepts the same paging,
// search and sort params so the client table component can be generic.
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const paginate = ({ page, limit }) => ({
  skip: (page - 1) * limit,
  take: limit,
});

export const listResponse = (rows, total, { page, limit }) => ({
  rows,
  total,
  page,
  limit,
  pages: Math.max(1, Math.ceil(total / limit)),
});

export const orderBy = (sortBy, sortDir, fallback) =>
  sortBy ? { [sortBy]: sortDir } : fallback;

// Prisma Decimal serialises as an object over JSON; callers need plain numbers.
export const num = (v) => (v == null ? null : Number(v));
