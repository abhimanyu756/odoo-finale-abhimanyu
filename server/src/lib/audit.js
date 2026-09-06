import { AsyncLocalStorage } from 'node:async_hooks';
import { verifyAccessToken } from './tokens.js';

/*
 * Audit trail, bolted on rather than woven in.
 *
 * Route code is untouched: writes are captured by a Prisma client extension,
 * and the actor travels through the request in AsyncLocalStorage instead of
 * being threaded through every function signature.
 *
 * Three rules keep this from affecting anything that already works:
 *   1. Never throw. A failed audit write is swallowed - losing a log line must
 *      never fail a payroll operation.
 *   2. Never block. The log row is written after the operation returns, not
 *      inside its transaction.
 *   3. Never touch high-volume or security tables. Payslip lines, attendance
 *      rows and token tables would bury the signal in noise.
 */

const store = new AsyncLocalStorage();

export const withActor = (actor, fn) => store.run({ actor }, fn);
export const currentActor = () => store.getStore()?.actor ?? null;

// Express middleware: seeds the actor for the whole request.
//
// It decodes the bearer token itself rather than reading req.user, so it can sit
// ahead of the auth middleware and no existing file has to change. An invalid or
// absent token simply means an unattributed row.
export const auditContext = (req, _res, next) => {
  let actor = null;
  try {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      const p = verifyAccessToken(header.slice(7));
      actor = { id: p.sub, role: p.role, email: p.email };
    }
  } catch {
    // Unauthenticated or expired: the request is logged without an actor.
  }
  return withActor(actor, () => next());
};

// Models worth a trail: master data and anything that moves money or approval.
const TRACKED = new Set([
  'Employee', 'User', 'Contract', 'Department', 'JobPosition', 'WorkingSchedule',
  'TimeOffType', 'LeaveAllocation', 'LeaveRequest',
  'SalaryStructure', 'SalaryRule', 'Payrun', 'Payslip',
]);

// Never logged: too high-volume to be readable, or security-sensitive.
const IGNORED = new Set([
  'AuditLog', 'PayslipLine', 'Attendance', 'PayrollWarning',
  'RefreshToken', 'PasswordResetToken', 'WorkingScheduleLine',
]);

const ACTIONS = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  upsert: 'update',
};

// Fields that would leak a secret or bury the diff in noise.
const REDACTED = new Set(['passwordHash', 'tokenHash']);
const NOISE = new Set(['updatedAt', 'createdAt']);

const label = (model, row) => {
  if (!row) return null;
  if (row.number) return row.number;           // payslip
  if (row.reference) return row.reference;     // contract
  if (row.firstName) return `${row.firstName} ${row.lastName ?? ''}`.trim();
  if (row.name) return row.name;
  if (row.email) return row.email;
  if (row.code) return row.code;
  return null;
};

// A write that returns `include`d relations would otherwise diff whole nested
// records against nothing and drown the real change. Only column values are
// compared: primitives, dates, and Prisma Decimals (which are objects but do
// carry toFixed).
const isColumnValue = (v) =>
  v === null
  || v === undefined
  || typeof v !== 'object'
  || v instanceof Date
  || typeof v.toFixed === 'function';

// Only what actually moved, so an update of one field reads as one line.
const diff = (before, after) => {
  if (!after) return null;
  const out = {};
  for (const [k, to] of Object.entries(after)) {
    if (NOISE.has(k)) continue;
    if (!isColumnValue(to)) continue;
    const from = before ? before[k] : undefined;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    // Redacted fields are reported as having changed, never with their values.
    out[k] = REDACTED.has(k) ? { from: '***', to: '***' } : { from: from ?? null, to };
  }
  return Object.keys(out).length ? out : null;
};

// A sign-in stamps lastLoginAt on the user row. Logging that would bury every
// real change under one row per login, so an update that touched nothing else
// is dropped.
const isNoiseOnly = (changes) =>
  changes !== null && Object.keys(changes).length === 1 && 'lastLoginAt' in changes;

// Computing a payrun rewrites every payslip in it - 87 rows of machine output
// per click, which would drown the human decisions the trail exists to record.
// The payrun's own status change already records that a compute happened, so a
// payslip is logged only for the decisions taken on it: cancelled, validated,
// paid. Recomputation of its figures is not one.
const isMachineChurn = (model, changes) =>
  model === 'Payslip'
  && (!changes?.status || changes.status.to === 'COMPUTED');

// Creating a payrun for 87 people is one decision, not 87. The payrun's own
// create row records it; the payslips are its expansion.
const isBulkExpansion = (model, action) => model === 'Payslip' && action === 'create';

export function auditExtension(base) {
  return base.$extends({
    name: 'audit',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const action = ACTIONS[operation];
          if (!action || IGNORED.has(model) || !TRACKED.has(model)) {
            return query(args);
          }

          // The previous state, so an update can be diffed rather than dumped.
          let before = null;
          if (action !== 'create' && args?.where) {
            before = await base[model[0].toLowerCase() + model.slice(1)]
              .findFirst({ where: args.where })
              .catch(() => null);
          }

          const result = await query(args);

          // Fire and forget: the operation has already succeeded by here.
          const actor = currentActor();
          const row = action === 'delete' ? before : result;
          const changes = action === 'delete' ? null : diff(before, row);
          if (isBulkExpansion(model, action)) return result;
          if (action === 'update'
            && (changes === null || isNoiseOnly(changes) || isMachineChurn(model, changes))) {
            return result;
          }

          base.auditLog
            .create({
              data: {
                actorId: actor?.id ?? null,
                actorEmail: actor?.email ?? null,
                actorRole: actor?.role ?? null,
                action,
                entity: model,
                entityId: row?.id ?? before?.id ?? null,
                label: label(model, row) ?? label(model, before),
                changes,
              },
            })
            .catch(() => {});

          return result;
        },
      },
    },
  });
}
