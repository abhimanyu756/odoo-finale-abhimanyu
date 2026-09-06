import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { auditContext } from './lib/audit.js';
import auditRoutes from './modules/audit/audit.routes.js';
import assistantRoutes from './modules/assistant/assistant.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import orgRoutes from './modules/org/org.routes.js';
import employeeRoutes from './modules/employees/employees.routes.js';
import scheduleRoutes from './modules/schedules/schedules.routes.js';
import contractRoutes from './modules/contracts/contracts.routes.js';
import attendanceRoutes from './modules/attendance/attendance.routes.js';
import timeOffRoutes from './modules/timeoff/timeoff.routes.js';
import salaryRoutes from './modules/salary/salary.routes.js';
import payrollRoutes from './modules/payroll/payroll.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import userRoutes from './modules/users/users.routes.js';

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  if (env.nodeEnv === 'development') app.use(morgan('dev'));
  // Seeds the audit actor for every request; a no-op for unauthenticated ones.
  app.use(auditContext);

  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, service: 'peoplepay360', time: new Date().toISOString() }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/employees', employeeRoutes);
  app.use('/api/working-schedules', scheduleRoutes);
  app.use('/api/contracts', contractRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/time-off', timeOffRoutes);
  app.use('/api/salary', salaryRoutes);
  app.use('/api/payroll', payrollRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/assistant', assistantRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
