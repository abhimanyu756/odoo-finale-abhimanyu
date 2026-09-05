import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { sendMail, mailEnabled } from '../../lib/mailer.js';
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

// ------------------------------------------------------ Password reset ----
const RESET_TTL_MINUTES = 30;
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { employee: { select: { firstName: true } } },
    });

    // Always answer the same way. Revealing whether an address has an account
    // would turn this endpoint into an account-enumeration oracle.
    const generic = {
      message: 'If that email has an account, a reset link has been sent.',
    };

    if (!user || !user.isActive) return res.json(generic);

    // Any earlier unused token is invalidated, so only the newest link works.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });

    const link = `${env.clientOrigin}/reset-password?token=${raw}`;
    await sendMail({
      to: user.email,
      subject: 'Reset your PeoplePay360 password',
      text:
        `Hello ${user.employee?.firstName ?? ''},\n\n`
        + 'We received a request to reset your PeoplePay360 password.\n\n'
        + `Reset link (valid for ${RESET_TTL_MINUTES} minutes):\n${link}\n\n`
        + 'If you did not request this, you can ignore this email — your password will not change.',
    });

    // With SMTP unconfigured the mail never leaves, so the link is surfaced in
    // development only; production returns the generic message alone.
    if (!mailEnabled() && env.nodeEnv !== 'production') {
      console.log(`[password-reset] ${user.email} -> ${link}`);
      return res.json({ ...generic, devResetLink: link });
    }

    return res.json(generic);
  }),
);

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { token, newPassword } = z
      .object({
        token: z.string().min(1),
        newPassword: z.string().min(8, 'Password must be at least 8 characters'),
      })
      .parse(req.body);

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw badRequest('This reset link is invalid or has expired. Request a new one.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash: await bcrypt.hash(newPassword, 10), mustReset: false },
      });
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
      // Resetting a password ends every existing session.
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    clearRefreshCookie(res);
    res.json({ message: 'Password updated. You can now sign in.' });
  }),
);

export default router;
