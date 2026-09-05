import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

export const notFoundHandler = (req, res) =>
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  if (err?.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        error: `Duplicate value for ${err.meta?.target ?? 'unique field'}`,
      });
    }
    if (err.code === 'P2025') return res.status(404).json({ error: 'Record not found' });
    if (err.code === 'P2003') {
      return res.status(409).json({ error: 'Related record missing or still referenced' });
    }
  }

  console.error(err);
  return res.status(500).json({
    error: 'Internal server error',
    ...(env.nodeEnv === 'development' ? { message: err.message } : {}),
  });
}
