// Assigns each employee an HR responsible, preferring someone from their own
// department who holds an HR role, and falling back to the HR department's own
// officers. Additive and re-runnable: it only fills blanks, so a hand-picked
// assignment is never overwritten.
import { prisma } from '../src/lib/prisma.js';

const HR_ROLES = ['HR_MANAGER', 'HR_PAYROLL_ADMIN', 'ADMIN'];

const officers = await prisma.employee.findMany({
  where: { status: 'ACTIVE', user: { role: { in: HR_ROLES }, isActive: true } },
  select: { id: true, firstName: true, lastName: true, departmentId: true },
});

if (!officers.length) {
  console.error('No active employees hold an HR role — nothing to assign.');
  process.exit(1);
}

const byDept = new Map();
for (const o of officers) {
  if (!o.departmentId) continue;
  if (!byDept.has(o.departmentId)) byDept.set(o.departmentId, []);
  byDept.get(o.departmentId).push(o);
}

// Round-robin within a department so one officer does not own everyone.
const cursor = new Map();
const nextFrom = (list) => {
  const i = cursor.get(list) ?? 0;
  cursor.set(list, (i + 1) % list.length);
  return list[i];
};

const pending = await prisma.employee.findMany({
  where: { hrResponsibleId: null },
  select: { id: true, departmentId: true },
});

let assigned = 0;
let skipped = 0;
for (const e of pending) {
  const pool = (byDept.get(e.departmentId) ?? officers).filter((o) => o.id !== e.id);
  if (!pool.length) { skipped += 1; continue; }
  await prisma.employee.update({
    where: { id: e.id },
    data: { hrResponsibleId: nextFrom(pool).id },
  });
  assigned += 1;
}

console.log(`HR responsible assigned to ${assigned} employee(s); ${skipped} skipped.`);
console.log(`${officers.length} active HR officers available.`);
await prisma.$disconnect();
