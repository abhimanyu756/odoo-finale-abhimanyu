import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, unauthorized } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from '../../lib/tokens.js';

const router = Router();

const publicUser = (user, employee) => ({
  id: user.id,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  employee: employee
    ? {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        departmentId: employee.departmentId,
        jobPositionId: employee.jobPositionId,
      }
    : null,
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { employee: true },
    });

    // Same response whether the email is unknown or the password is wrong,
    // so the endpoint cannot be used to enumerate accounts.
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) throw unauthorized('Invalid email or password');
    if (!user.isActive) throw unauthorized('Account is deactivated');

    const { raw, expiresAt } = await issueRefreshToken(user.id);
    setRefreshCookie(res, raw, expiresAt);
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.json({
      accessToken: signAccessToken(user),
      user: publicUser(user, user.employee),
    });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const raw = readRefreshCookie(req);
    if (!raw) throw unauthorized('No refresh token');

    const result = await rotateRefreshToken(raw);
    if (result.error) {
      clearRefreshCookie(res);
      throw unauthorized(
        result.error === 'reused'
          ? 'Refresh token reuse detected; all sessions revoked'
          : 'Refresh token invalid or expired',
      );
    }

    setRefreshCookie(res, result.raw, result.expiresAt);
    res.json({ accessToken: signAccessToken(result.user) });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const raw = readRefreshCookie(req);
    if (raw) await revokeRefreshToken(raw);
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { employee: true },
    });
    if (!user) throw unauthorized();
    res.json({ user: publicUser(user, user.employee) });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustReset: false },
    });

    // Force every other session to re-authenticate with the new password.
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    clearRefreshCookie(res);

    res.status(204).end();
  }),
);

export default router;
