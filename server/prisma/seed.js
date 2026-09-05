import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';
import { runRules, buildContext } from '../src/modules/salary/compute.js';
import { isoDayOfWeek, parseHHMM } from '../src/lib/dates.js';

const CURRENT = new Date('2026-09-05T00:00:00Z');
const pad = (n, w = 4) => String(n).padStart(w, '0');
const money = (n) => Number(n.toFixed(2));

console.log('Clearing existing data...');
// Order matters: children before parents.
for (const model of [
  'payrollWarning', 'payslipLine', 'payslip', 'payrun',
  'leaveRequest', 'leaveAllocation', 'timeOffType',
  'attendance', 'contract', 'salaryRule', 'salaryStructure',
  'workingScheduleLine', 'workingSchedule',
  'refreshToken',
]) {
  await prisma[model].deleteMany();
}
await prisma.employee.updateMany({ data: { userId: null, managerId: null } });
await prisma.employee.deleteMany();
await prisma.user.deleteMany();
await prisma.jobPosition.deleteMany();
await prisma.department.deleteMany();
await prisma.company.deleteMany();

console.log('Company, departments, positions...');
const company = await prisma.company.create({ data: { name: 'OxP Pvt Ltd', currency: 'INR' } });

const deptNames = ['Finance', 'Engineering', 'Sales', 'Human Resources', 'Operations'];
const depts = {};
for (const name of deptNames) {
  depts[name] = await prisma.department.create({ data: { name, companyId: company.id } });
}

const posNames = [
  'Payroll Specialist', 'Software Engineer', 'Senior Engineer', 'Sales Executive',
  'HR Manager', 'Operations Analyst', 'Finance Manager', 'QA Engineer',
];
const positions = {};
for (const name of posNames) {
  positions[name] = await prisma.jobPosition.create({ data: { name } });
}

console.log('Working schedules...');
const weekday = (start, end, brk) =>
  [0, 1, 2, 3, 4].map((d) => ({ dayOfWeek: d, startTime: start, endTime: end, breakHours: brk }));

const hoursOf = (lines) =>
  money(lines.reduce((s, l) => s + parseHHMM(l.endTime) - parseHHMM(l.startTime) - l.breakHours, 0));

const scheduleDefs = [
  { name: '40 Hours / Week', scheduleType: 'FULL_TIME', lines: weekday('09:00', '18:00', 1) },
  { name: 'Night Shift', scheduleType: 'FULL_TIME', lines: weekday('22:00', '23:59', 0).map((l, i) => ({ ...l, startTime: '14:00', endTime: '23:00', breakHours: 1 })) },
  { name: 'Part-time 20h', scheduleType: 'PART_TIME', lines: [0, 1, 2, 3].map((d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '14:00', breakHours: 0 })) },
  { name: 'Flexible Hybrid', scheduleType: 'FLEXIBLE', lines: weekday('10:00', '18:30', 1) },
];

const schedules = {};
for (const def of scheduleDefs) {
  schedules[def.name] = await prisma.workingSchedule.create({
    data: {
      name: def.name,
      scheduleType: def.scheduleType,
      companyId: company.id,
      hoursPerWeek: hoursOf(def.lines),
      lines: { create: def.lines },
    },
    include: { lines: true },
  });
}

console.log('Salary structure and rules...');
const structure = await prisma.salaryStructure.create({
  data: { name: 'Regular Salary', code: 'REG', description: 'Standard monthly salary structure' },
});

const rules = [
  { name: 'Basic Salary', code: 'BASIC', category: 'BASIC', sequence: 1, computeType: 'PERCENTAGE', percentage: 50, baseExpr: 'WAGE' },
  { name: 'House Rent Allowance', code: 'HRA', category: 'ALLOWANCE', sequence: 10, computeType: 'PERCENTAGE', percentage: 20, baseExpr: 'BASIC' },
  { name: 'Standard Allowance', code: 'STD', category: 'ALLOWANCE', sequence: 20, computeType: 'FIXED', amount: 2000 },
  { name: 'Performance Bonus', code: 'BONUS', category: 'ALLOWANCE', sequence: 30, computeType: 'FORMULA', expression: 'worked_days >= 20 ? wage * 0.05 : 0' },
  { name: 'Leave Travel Allowance', code: 'LTA', category: 'ALLOWANCE', sequence: 40, computeType: 'PERCENTAGE', percentage: 8, baseExpr: 'BASIC' },
  { name: 'Fixed Allowance', code: 'FIX', category: 'ALLOWANCE', sequence: 50, computeType: 'FIXED', amount: 1500 },
  { name: 'Gross Salary', code: 'GROSS', category: 'GROSS', sequence: 60, computeType: 'FORMULA', expression: 'categories.BASIC + categories.ALLOWANCE' },
  { name: 'Provident Fund', code: 'PF', category: 'DEDUCTION', sequence: 70, computeType: 'FORMULA', expression: "min(categories['BASIC'] * 0.12, 1800)" },
  { name: 'Professional Tax', code: 'PT', category: 'DEDUCTION', sequence: 75, computeType: 'FIXED', amount: 200 },
  { name: 'Income Tax (TDS)', code: 'TDS', category: 'DEDUCTION', sequence: 80, computeType: 'FORMULA', expression: 'categories.GROSS > 50000 ? categories.GROSS * 0.1 : 0' },
  { name: 'Unpaid Leave Deduction', code: 'ULD', category: 'DEDUCTION', sequence: 85, computeType: 'FORMULA', expression: 'unpaid_leave_days > 0 ? roundTo(wage / days_in_period * unpaid_leave_days, 2) : 0' },
  { name: 'Net Salary', code: 'NET', category: 'NET', sequence: 90, computeType: 'FORMULA', expression: 'categories.GROSS - categories.DEDUCTION' },
];
for (const r of rules) {
  await prisma.salaryRule.create({ data: { ...r, structureId: structure.id } });
}

console.log('Time off types...');
const types = {};
for (const t of [
  { name: 'Paid Time Off', code: 'PTO', unit: 'DAYS', requiresAllocation: true, isPaid: true, color: '#714B67' },
  { name: 'Sick Leave', code: 'SICK', unit: 'DAYS', requiresAllocation: true, isPaid: true, color: '#017E84' },
  { name: 'Unpaid Leave', code: 'UNPAID', unit: 'DAYS', requiresAllocation: false, isPaid: false, color: '#B4506B' },
  { name: 'Compensatory Off', code: 'COMP', unit: 'DAYS', requiresAllocation: true, isPaid: true, color: '#8F7A4E' },
]) {
  types[t.code] = await prisma.timeOffType.create({ data: t });
}

console.log('Employees and users...');
const people = [
  ['Aarav', 'Mehta', 'Finance', 'Payroll Specialist', 'HR_PAYROLL_ADMIN', 95000, '40 Hours / Week', 'FULL_TIME', 'Mumbai'],
  ['Sara', 'Khan', 'Human Resources', 'HR Manager', 'HR_MANAGER', 88000, '40 Hours / Week', 'FULL_TIME', 'Mumbai'],
  ['Rohan', 'Patel', 'Engineering', 'Senior Engineer', 'EMPLOYEE', 120000, '40 Hours / Week', 'FULL_TIME', 'Bengaluru'],
  ['Maya', 'Shah', 'Engineering', 'Software Engineer', 'EMPLOYEE', 78000, 'Flexible Hybrid', 'FULL_TIME', 'Bengaluru'],
  ['Nisha', 'Rao', 'Finance', 'Finance Manager', 'HR_PAYROLL_USER', 110000, '40 Hours / Week', 'FULL_TIME', 'Mumbai'],
  ['John', 'Dsouza', 'Sales', 'Sales Executive', 'EMPLOYEE', 65000, '40 Hours / Week', 'FULL_TIME', 'Pune'],
  ['Neha', 'Patel', 'Sales', 'Sales Executive', 'EMPLOYEE', 62000, '40 Hours / Week', 'FULL_TIME', 'Pune'],
  ['Vikram', 'Singh', 'Operations', 'Operations Analyst', 'EMPLOYEE', 70000, 'Night Shift', 'FULL_TIME', 'Delhi'],
  ['Priya', 'Nair', 'Engineering', 'QA Engineer', 'EMPLOYEE', 68000, '40 Hours / Week', 'FULL_TIME', 'Bengaluru'],
  ['Arjun', 'Verma', 'Engineering', 'Software Engineer', 'EMPLOYEE', 45000, 'Part-time 20h', 'PART_TIME', 'Remote'],
  ['Kiran', 'Joshi', 'Operations', 'Operations Analyst', 'EMPLOYEE', 40000, 'Part-time 20h', 'CONTRACT', 'Remote'],
  ['Ananya', 'Gupta', 'Human Resources', 'HR Manager', 'EMPLOYEE', 30000, '40 Hours / Week', 'INTERN', 'Mumbai'],
];

const employees = [];
for (const [first, last, dept, pos, role, wage, sched, type, loc] of people) {
  const email = `${first.toLowerCase()}@oxp.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash('Pass@1234', 10), role },
  });
  const emp = await prisma.employee.create({
    data: {
      firstName: first, lastName: last, workEmail: email,
      personalEmail: `${first.toLowerCase()}.${last.toLowerCase()}@gmail.com`,
      phone: `+91 9${Math.floor(100000000 + Math.random() * 899999999)}`,
      employeeType: type, status: 'ACTIVE', workLocation: loc,
      hireDate: new Date('2024-04-01'),
      dateOfBirth: new Date('1995-06-15'),
      address: `${loc}, India`,
      // One employee is deliberately missing bank details to demo the warning.
      bankAccount: first === 'Kiran' ? null : `HDFC00${pad(Math.floor(Math.random() * 9999999), 7)}`,
      identificationNo: `ID-${pad(employees.length + 1, 4)}`,
      companyId: company.id,
      departmentId: depts[dept].id,
      jobPositionId: positions[pos].id,
      workingScheduleId: schedules[sched].id,
      userId: user.id,
    },
  });
  employees.push({ ...emp, wage, sched });
}

// Admin account, not an employee-facing role.
const adminUser = await prisma.user.create({
  data: { email: 'admin@oxp.com', passwordHash: await bcrypt.hash('Admin@123', 10), role: 'ADMIN' },
});
await prisma.employee.create({
  data: {
    firstName: 'System', lastName: 'Admin', workEmail: 'admin@oxp.com',
    companyId: company.id, departmentId: depts['Human Resources'].id,
    userId: adminUser.id, bankAccount: 'HDFC0009999999',
  },
});

// Managers
const sara = employees.find((e) => e.firstName === 'Sara');
const rohan = employees.find((e) => e.firstName === 'Rohan');
const nisha = employees.find((e) => e.firstName === 'Nisha');
for (const e of employees) {
  const managerId =
    e.departmentId === depts.Engineering.id ? rohan.id
    : e.departmentId === depts.Finance.id ? nisha.id
    : sara.id;
  if (managerId !== e.id) {
    await prisma.employee.update({ where: { id: e.id }, data: { managerId } });
  }
}

console.log('Contracts...');
let conSeq = { 2025: 0, 2026: 0 };
for (const e of employees) {
  // Historic contract at a lower wage, then the current running one.
  conSeq[2025] += 1;
  await prisma.contract.create({
    data: {
      reference: `CON/2025/${pad(conSeq[2025])}`,
      name: `${e.firstName} ${e.lastName} - 2025`,
      employeeId: e.id, startDate: new Date('2025-04-01'), endDate: new Date('2025-12-31'),
      wage: money(e.wage * 0.9), status: 'EXPIRED',
      departmentId: e.departmentId, jobPositionId: e.jobPositionId,
      workingScheduleId: e.workingScheduleId, salaryStructureId: structure.id,
    },
  });
  conSeq[2026] += 1;
  await prisma.contract.create({
    data: {
      reference: `CON/2026/${pad(conSeq[2026])}`,
      name: `${e.firstName} ${e.lastName} - 2026`,
      employeeId: e.id, startDate: new Date('2026-01-01'), endDate: null,
      wage: e.wage, status: 'RUNNING',
      departmentId: e.departmentId, jobPositionId: e.jobPositionId,
      workingScheduleId: e.workingScheduleId, salaryStructureId: structure.id,
    },
  });
}

console.log('Attendance (Jun-Sep 2026)...');
const attendanceRows = [];
for (const e of employees) {
  const lines = schedules[e.sched].lines;
  for (let d = new Date('2026-06-01'); d <= CURRENT; d.setDate(d.getDate() + 1)) {
    const line = lines.find((l) => l.dayOfWeek === isoDayOfWeek(d));
    if (!line) continue;

    const roll = Math.random();
    if (roll < 0.04) continue;                     // absent, no record
    const missingCheckout = roll > 0.985;          // forgot to check out

    const [sh, sm] = line.startTime.split(':').map(Number);
    const jitter = Math.random() < 0.15 ? 20 + Math.random() * 40 : Math.random() * 12;
    const checkIn = new Date(d);
    checkIn.setHours(sh, sm + Math.round(jitter), 0, 0);

    const scheduled = parseHHMM(line.endTime) - parseHHMM(line.startTime);
    const worked = scheduled + (Math.random() < 0.2 ? Math.random() * 1.5 : Math.random() * 0.4 - 0.2);
    const checkOut = missingCheckout ? null : new Date(checkIn.getTime() + worked * 3_600_000);

    const workedHours = checkOut ? money((checkOut - checkIn) / 3_600_000) : 0;
    const expected = scheduled - line.breakHours;
    const overtimeHours = checkOut ? money(Math.max(0, workedHours - line.breakHours - expected)) : 0;
    const late = checkIn.getHours() * 60 + checkIn.getMinutes() > sh * 60 + sm + 15;

    attendanceRows.push({
      employeeId: e.id,
      checkIn: new Date(checkIn),
      checkOut,
      workedHours,
      overtimeHours,
      status: !checkOut ? 'MISSING_CHECKOUT' : late ? 'LATE' : 'PRESENT',
      isManual: Math.random() < 0.03,
    });
  }
}
await prisma.attendance.createMany({ data: attendanceRows });

console.log('Time off allocations and requests...');
for (const e of employees) {
  for (const [code, amount] of [['PTO', 18], ['SICK', 10], ['COMP', 5]]) {
    await prisma.leaveAllocation.create({
      data: {
        employeeId: e.id, timeOffTypeId: types[code].id, amount,
        status: 'APPROVED', validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'),
        notes: `${new Date().getFullYear()} annual allocation`,
      },
    });
  }
}

const leavePlan = [
  ['Aarav', 'PTO', '2026-07-13', '2026-07-15', 'APPROVED'],
  ['Maya', 'SICK', '2026-07-22', '2026-07-23', 'APPROVED'],
  ['Rohan', 'PTO', '2026-08-10', '2026-08-14', 'APPROVED'],
  ['John', 'UNPAID', '2026-08-19', '2026-08-21', 'APPROVED'],
  ['Priya', 'SICK', '2026-08-27', '2026-08-27', 'APPROVED'],
  ['Neha', 'PTO', '2026-09-14', '2026-09-18', 'TO_APPROVE'],
  ['Vikram', 'COMP', '2026-09-21', '2026-09-22', 'TO_APPROVE'],
  ['Arjun', 'PTO', '2026-09-28', '2026-09-30', 'TO_APPROVE'],
  ['Kiran', 'SICK', '2026-09-09', '2026-09-10', 'TO_APPROVE'],
  ['Ananya', 'PTO', '2026-06-15', '2026-06-16', 'REFUSED'],
];

for (const [first, code, from, to, status] of leavePlan) {
  const e = employees.find((x) => x.firstName === first);
  const lines = schedules[e.sched].lines;
  let days = 0;
  for (let d = new Date(from); d <= new Date(to); d.setDate(d.getDate() + 1)) {
    if (lines.some((l) => l.dayOfWeek === isoDayOfWeek(d))) days += 1;
  }
  if (!days) continue;

  const allocation = code === 'UNPAID' ? null
    : await prisma.leaveAllocation.findFirst({
        where: { employeeId: e.id, timeOffTypeId: types[code].id, status: 'APPROVED' },
      });

  await prisma.leaveRequest.create({
    data: {
      employeeId: e.id, timeOffTypeId: types[code].id,
      dateFrom: new Date(from), dateTo: new Date(to), duration: days, status,
      reason: status === 'REFUSED' ? 'Insufficient notice' : 'Personal',
      allocationId: status === 'APPROVED' ? allocation?.id ?? null : null,
      ...(status === 'APPROVED' ? { approvedById: sara.userId, approvedAt: new Date(from) } : {}),
      ...(status === 'REFUSED' ? { refusalReason: 'Insufficient notice given' } : {}),
    },
  });
}

console.log('Payruns (Jul, Aug paid; Sep draft)...');
const structureWithRules = await prisma.salaryStructure.findUnique({
  where: { id: structure.id }, include: { rules: true },
});

let slipSeq = 0;
const periods = [
  ['Payrun / July 2026', '2026-07-01', '2026-07-31', 'PAID'],
  ['Payrun / August 2026', '2026-08-01', '2026-08-31', 'PAID'],
  ['Payrun / September 2026', '2026-09-01', '2026-09-30', 'DRAFT'],
];

for (const [name, from, to, finalStatus] of periods) {
  const periodStart = new Date(from);
  const periodEnd = new Date(`${to}T23:59:59.999Z`);

  const payrun = await prisma.payrun.create({
    data: { name, structureId: structure.id, periodStart, periodEnd },
  });

  for (const e of employees) {
    const contract = await prisma.contract.findFirst({
      where: {
        employeeId: e.id, status: 'RUNNING',
        startDate: { lte: periodEnd },
        OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
      },
      include: { workingSchedule: { include: { lines: true } } },
    });
    if (!contract) continue;

    slipSeq += 1;
    const prefix = `SLIP/${periodStart.getUTCFullYear()}${pad(periodStart.getUTCMonth() + 1, 2)}/`;
    const slip = await prisma.payslip.create({
      data: {
        number: `${prefix}${pad(slipSeq)}`,
        payrunId: payrun.id, employeeId: e.id, contractId: contract.id,
        periodStart, periodEnd,
      },
    });

    if (finalStatus === 'DRAFT') continue;

    const employee = await prisma.employee.findUnique({
      where: { id: e.id }, include: { workingSchedule: { include: { lines: true } } },
    });
    const ctx = await buildContext({ employee, contract, periodStart, periodEnd });
    const { lines: slipLines, totals } = runRules(structureWithRules.rules, ctx);

    await prisma.payslip.update({
      where: { id: slip.id },
      data: {
        status: 'PAID',
        workedDays: ctx.worked_days, workedHours: ctx.worked_hours, leaveDays: ctx.leave_days,
        basic: totals.basic, allowance: totals.allowance, gross: totals.gross,
        deduction: totals.deduction, net: totals.net,
        lines: { create: slipLines },
      },
    });
  }

  if (finalStatus === 'PAID') {
    await prisma.payrun.update({
      where: { id: payrun.id },
      data: {
        status: 'PAID',
        computedAt: periodEnd, validatedAt: periodEnd, paidAt: periodEnd,
      },
    });
  }
}

const counts = {
  employees: await prisma.employee.count(),
  contracts: await prisma.contract.count(),
  attendance: await prisma.attendance.count(),
  allocations: await prisma.leaveAllocation.count(),
  requests: await prisma.leaveRequest.count(),
  rules: await prisma.salaryRule.count(),
  payruns: await prisma.payrun.count(),
  payslips: await prisma.payslip.count(),
};
console.log('\nSeed complete:', counts);
console.log('\nLogins (all non-admin passwords: Pass@1234)');
console.log('  admin@oxp.com  / Admin@123    ADMIN');
console.log('  aarav@oxp.com  / Pass@1234    HR_PAYROLL_ADMIN');
console.log('  nisha@oxp.com  / Pass@1234    HR_PAYROLL_USER');
console.log('  sara@oxp.com   / Pass@1234    HR_MANAGER');
console.log('  rohan@oxp.com  / Pass@1234    EMPLOYEE');

await prisma.$disconnect();
