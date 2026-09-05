import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';

const REFRESH_COOKIE = 'pp360_rt';

export const signAccessToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl },
  );

export const verifyAccessToken = (token) =>
  jwt.verify(token, env.jwt.accessSecret);

// Refresh tokens are random opaque strings; only their SHA-256 hash is stored,
// so a database leak cannot be replayed against the API.
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export async function issueRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const ttlDays = Number(String(env.jwt.refreshTtl).replace(/\D/g, '')) || 7;
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000);

  await prisma.refreshToken.create({
    data: { userId, tokenHash: hash(raw), expiresAt },
  });
  return { raw, expiresAt };
}

// Rotation: the presented token is revoked and replaced. Presenting a token
// that is already revoked means it leaked, so the whole family is killed.
export async function rotateRefreshToken(raw) {
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: hash(raw) },
    include: { user: true },
  });

  if (!existing) return { error: 'invalid' };

  if (existing.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { error: 'reused' };
  }

  if (existing.expiresAt < new Date()) return { error: 'expired' };
  if (!existing.user.isActive) return { error: 'inactive' };

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  const next = await issueRefreshToken(existing.userId);
  return { user: existing.user, ...next };
}

export const revokeRefreshToken = (raw) =>
  prisma.refreshToken.updateMany({
    where: { tokenHash: hash(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });

export function setRefreshCookie(res, raw, expiresAt) {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.nodeEnv === 'production',
    expires: expiresAt,
    path: '/api/auth',
  });
}

export const clearRefreshCookie = (res) =>
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });

export const readRefreshCookie = (req) => req.cookies?.[REFRESH_COOKIE];
