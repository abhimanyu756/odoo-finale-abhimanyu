import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { auditExtension } from './audit.js';

const base = new PrismaClient({
  log: env.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

// The audit extension only observes: it forwards every query untouched and
// writes its own row afterwards. Existing code keeps the same `prisma` import
// and the same behaviour.
export const prisma = auditExtension(base);
