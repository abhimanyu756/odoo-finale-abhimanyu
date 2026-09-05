import { z } from 'zod';

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
