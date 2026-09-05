// ---------------------------------------------------------------------------
// Bulk demo data loader.
//
// Unlike prisma/seed.js this script NEVER deletes anything: it tops the live
// database up to the target row counts below, so records added by hand through
// the UI survive a re-run. Re-running it is a no-op once the targets are met.
//
//   node scripts/bulk-data.js            # top up to the targets
//   node scripts/bulk-data.js --dry-run  # report what it would create
//
// Payslips are produced by the app's own rule engine (buildContext/runRules),
// so pressing "Recompute" in the UI reproduces exactly these numbers.
// ---------------------------------------------------------------------------
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';
import { buildContext, runRules } from '../src/modules/salary/compute.js';
import { collectWarnings, persistWarnings } from '../src/modules/payroll/payroll.service.js';
import { isoDayOfWeek, parseHHMM } from '../src/lib/dates.js';

const DRY = process.argv.includes('--dry-run');

const TARGET_EMPLOYEES = 200;
const PASSWORD = 'Pass@1234';
const TODAY = new Date('2026-09-05T00:00:00Z');
// Attendance window. Kept to ~3 months: the dashboard loads every row in its
// period, and 200 employees x 12 months would make it crawl.
const ATT_FROM = new Date('2026-06-01T00:00:00Z');

// Deterministic RNG so a re-run of the same size produces the same people.
let _seed = 20260905;
const rnd = () => {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 4) => String(n).padStart(w, '0');
const money = (n) => Number(Number(n).toFixed(2));
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

// Small concurrency pool: payslip computation is query-bound, so running a
// handful in parallel cuts the wall time without swamping the connection pool.
async function pool(items, size, fn) {
  const out = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const log = (...a) => console.log(...a);
const created = {};
const note = (key, n = 1) => { created[key] = (created[key] ?? 0) + n; };

// ---------------------------------------------------------------------------
// 1. Company, departments, job positions
// ---------------------------------------------------------------------------
log('Company / departments / job positions...');

let company = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
if (!company) {
  company = await prisma.company.create({ data: { name: 'Odoo', currency: 'INR' } });
  note('companies');
}

const DEPT_NAMES = [
  'Finance', 'Engineering', 'Sales', 'Human Resources', 'Operations',
  'Marketing', 'Legal', 'IT Support', 'Customer Success',
  'Research & Development', 'Procurement', 'Quality Assurance',
];
const depts = {};
for (const name of DEPT_NAMES) {
  const existing = await prisma.department.findFirst({ where: { companyId: company.id, name } });
  depts[name] = existing
    ?? (DRY ? { id: `dry-${name}`, name } : (note('departments'), await prisma.department.create({ data: { name, companyId: company.id } })));
}

const POSITIONS = [
  'Payroll Specialist', 'Software Engineer', 'Senior Engineer', 'Sales Executive',
  'HR Manager', 'Operations Analyst', 'Finance Manager', 'QA Engineer',
  'Engineering Manager', 'Staff Engineer', 'Product Manager', 'UX Designer',
  'Data Analyst', 'DevOps Engineer', 'Support Specialist', 'Account Manager',
  'Marketing Executive', 'Content Strategist', 'Legal Counsel', 'Recruiter',
  'Compensation Analyst', 'Procurement Officer', 'Customer Success Manager',
  'Technical Writer',
];
const positions = {};
for (const name of POSITIONS) {
  const existing = await prisma.jobPosition.findUnique({ where: { name } });
  positions[name] = existing
    ?? (DRY ? { id: `dry-${name}`, name } : (note('jobPositions'), await prisma.jobPosition.create({ data: { name } })));
}

// Which positions make sense in which department, so the org chart reads right.
const DEPT_POSITIONS = {
  Finance: ['Payroll Specialist', 'Finance Manager', 'Compensation Analyst', 'Data Analyst'],
  Engineering: ['Software Engineer', 'Senior Engineer', 'Staff Engineer', 'Engineering Manager', 'DevOps Engineer'],
  Sales: ['Sales Executive', 'Account Manager'],
  'Human Resources': ['HR Manager', 'Recruiter', 'Compensation Analyst'],
  Operations: ['Operations Analyst', 'Procurement Officer'],
  Marketing: ['Marketing Executive', 'Content Strategist', 'Product Manager'],
  Legal: ['Legal Counsel'],
  'IT Support': ['Support Specialist', 'DevOps Engineer'],
  'Customer Success': ['Customer Success Manager', 'Support Specialist'],
  'Research & Development': ['Staff Engineer', 'Data Analyst', 'Technical Writer'],
  Procurement: ['Procurement Officer', 'Operations Analyst'],
  'Quality Assurance': ['QA Engineer', 'Technical Writer'],
};

// ---------------------------------------------------------------------------
// 2. Working schedules
// ---------------------------------------------------------------------------
log('Working schedules...');

const days = (list, start, end, brk) =>
  list.map((d) => ({ dayOfWeek: d, startTime: start, endTime: end, breakHours: brk }));
const hoursOf = (lines) =>
  money(lines.reduce((s, l) => s + parseHHMM(l.endTime) - parseHHMM(l.startTime) - l.breakHours, 0));

const SCHEDULE_DEFS = [
  { name: '40 Hours / Week', scheduleType: 'FULL_TIME', lines: days([0, 1, 2, 3, 4], '09:00', '18:00', 1) },
  { name: '35 Hours / Week', scheduleType: 'FULL_TIME', lines: days([0, 1, 2, 3, 4], '09:30', '17:30', 1) },
  { name: 'Night Shift', scheduleType: 'FULL_TIME', lines: days([0, 1, 2, 3, 4], '14:00', '23:00', 1) },
  { name: 'Early Shift 06-14', scheduleType: 'FULL_TIME', lines: days([0, 1, 2, 3, 4], '06:00', '14:00', 0.5) },
  { name: 'Part-time 20h', scheduleType: 'PART_TIME', lines: days([0, 1, 2, 3], '09:00', '14:00', 0) },
  { name: 'Part-time 24h', scheduleType: 'PART_TIME', lines: days([0, 1, 2], '09:00', '17:00', 0) },
  { name: 'Flexible Hybrid', scheduleType: 'FLEXIBLE', lines: days([0, 1, 2, 3, 4], '10:00', '18:30', 1) },
  { name: 'Weekend Support', scheduleType: 'FLEXIBLE', lines: days([4, 5, 6], '10:00', '19:00', 1) },
];

const schedules = {};
for (const def of SCHEDULE_DEFS) {
  const existing = await prisma.workingSchedule.findUnique({
    where: { name: def.name }, include: { lines: true },
  });
  if (existing) { schedules[def.name] = existing; continue; }
  if (DRY) { schedules[def.name] = { id: `dry-${def.name}`, lines: def.lines }; note('schedules'); continue; }
  note('schedules');
  schedules[def.name] = await prisma.workingSchedule.create({
    data: {
      name: def.name, scheduleType: def.scheduleType, companyId: company.id,
      timezone: 'Asia/Kolkata', hoursPerWeek: hoursOf(def.lines),
      lines: { create: def.lines },
    },
    include: { lines: true },
  });
}
// Existing schedules created before this script (e.g. "60 Hours / Week") are
// left untouched but still usable.
const SCHEDULES_BY_TYPE = {
  FULL_TIME: ['40 Hours / Week', '35 Hours / Week', 'Night Shift', 'Early Shift 06-14', 'Flexible Hybrid'],
  PART_TIME: ['Part-time 20h', 'Part-time 24h'],
  CONTRACT: ['Flexible Hybrid', 'Weekend Support', '35 Hours / Week'],
  INTERN: ['Part-time 24h', 'Part-time 20h'],
};

// ---------------------------------------------------------------------------
// 3. Time off types
// ---------------------------------------------------------------------------
log('Time off types...');

const TIME_OFF_DEFS = [
  { name: 'Paid Time Off', code: 'PTO', unit: 'DAYS', requiresAllocation: true, isPaid: true, approvalMode: 'MANAGER', workEntry: 'PAID_LEAVE', color: '#714B67', description: 'Standard annual leave drawn from an approved allocation.' },
  { name: 'Sick Leave', code: 'SICK', unit: 'DAYS', requiresAllocation: true, isPaid: true, approvalMode: 'MANAGER', workEntry: 'SICK_LEAVE', color: '#017E84', description: 'Paid sick leave. Manager approval required.' },
  { name: 'Unpaid Leave', code: 'UNPAID', unit: 'DAYS', requiresAllocation: false, isPaid: false, approvalMode: 'OFFICER', workEntry: 'UNPAID_LEAVE', color: '#B4506B', description: 'Leave without pay. Drives the payroll deduction rule.' },
  { name: 'Compensatory Off', code: 'COMP', unit: 'DAYS', requiresAllocation: true, isPaid: true, approvalMode: 'OFFICER', workEntry: 'COMPENSATORY_LEAVE', color: '#8F7A4E', description: 'Time off earned against overtime worked.' },
  { name: 'Maternity Leave', code: 'MAT', unit: 'DAYS', requiresAllocation: false, isPaid: true, approvalMode: 'OFFICER', workEntry: 'PAID_LEAVE', color: '#3C7A5E', description: 'Statutory maternity leave, granted without an allocation.' },
  { name: 'Paternity Leave', code: 'PAT', unit: 'DAYS', requiresAllocation: false, isPaid: true, approvalMode: 'MANAGER', workEntry: 'PAID_LEAVE', color: '#4B6BB4', description: 'Statutory paternity leave.' },
  { name: 'Bereavement Leave', code: 'BRV', unit: 'DAYS', requiresAllocation: false, isPaid: true, approvalMode: 'NONE', workEntry: 'PAID_LEAVE', color: '#6B6B6B', description: 'Auto-approved on submission; no allocation needed.' },
  { name: 'Overtime Recovery', code: 'OTR', unit: 'HOURS', requiresAllocation: true, isPaid: true, approvalMode: 'MANAGER', workEntry: 'COMPENSATORY_LEAVE', color: '#9C6644', description: 'Hour-based recovery of banked overtime.' },
];

const types = {};
for (const t of TIME_OFF_DEFS) {
  const existing = await prisma.timeOffType.findUnique({ where: { code: t.code } });
  types[t.code] = existing
    ?? (DRY ? { id: `dry-${t.code}`, ...t } : (note('timeOffTypes'), await prisma.timeOffType.create({
      data: { ...t, requiresApproval: t.approvalMode !== 'NONE' },
    })));
}
// Any extra types the user added by hand (PL, CL, ...) stay in the mix.
const allTypes = DRY ? Object.values(types) : await prisma.timeOffType.findMany({ where: { isActive: true } });

// ---------------------------------------------------------------------------
// 4. Salary structures and rules
// ---------------------------------------------------------------------------
log('Salary structures and rules...');

const REG_RULES = [
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

const STRUCTURE_DEFS = [
  { name: 'Regular Salary', code: 'REG', description: 'Standard monthly salary structure', rules: REG_RULES },
  {
    name: 'Executive Package', code: 'EXEC',
    description: 'Senior leadership: larger basic split, car and comms allowances, higher TDS slab.',
    rules: [
      { name: 'Basic Salary', code: 'BASIC', category: 'BASIC', sequence: 1, computeType: 'PERCENTAGE', percentage: 60, baseExpr: 'WAGE' },
      { name: 'House Rent Allowance', code: 'HRA', category: 'ALLOWANCE', sequence: 10, computeType: 'PERCENTAGE', percentage: 25, baseExpr: 'BASIC' },
      { name: 'Car Allowance', code: 'CAR', category: 'ALLOWANCE', sequence: 20, computeType: 'FIXED', amount: 15000 },
      { name: 'Communication Allowance', code: 'COMM', category: 'ALLOWANCE', sequence: 25, computeType: 'FIXED', amount: 3000 },
      { name: 'Leave Travel Allowance', code: 'LTA', category: 'ALLOWANCE', sequence: 30, computeType: 'PERCENTAGE', percentage: 10, baseExpr: 'BASIC' },
      { name: 'Annual Performance Bonus', code: 'BONUS', category: 'ALLOWANCE', sequence: 40, computeType: 'FORMULA', expression: 'worked_days >= 18 ? wage * 0.08 : 0' },
      { name: 'Gross Salary', code: 'GROSS', category: 'GROSS', sequence: 60, computeType: 'FORMULA', expression: 'categories.BASIC + categories.ALLOWANCE' },
      { name: 'Provident Fund', code: 'PF', category: 'DEDUCTION', sequence: 70, computeType: 'FORMULA', expression: "min(categories['BASIC'] * 0.12, 1800)" },
      { name: 'Professional Tax', code: 'PT', category: 'DEDUCTION', sequence: 75, computeType: 'FIXED', amount: 200 },
      { name: 'Income Tax (TDS)', code: 'TDS', category: 'DEDUCTION', sequence: 80, computeType: 'FORMULA', expression: 'categories.GROSS > 150000 ? categories.GROSS * 0.3 : categories.GROSS * 0.2' },
      { name: 'Unpaid Leave Deduction', code: 'ULD', category: 'DEDUCTION', sequence: 85, computeType: 'FORMULA', expression: 'unpaid_leave_days > 0 ? roundTo(wage / days_in_period * unpaid_leave_days, 2) : 0' },
      { name: 'Net Salary', code: 'NET', category: 'NET', sequence: 90, computeType: 'FORMULA', expression: 'categories.GROSS - categories.DEDUCTION' },
    ],
  },
  {
    name: 'Sales Commission Plan', code: 'SALES',
    description: 'Sales roles: lower fixed base plus an attendance-linked commission component.',
    rules: [
      { name: 'Basic Salary', code: 'BASIC', category: 'BASIC', sequence: 1, computeType: 'PERCENTAGE', percentage: 45, baseExpr: 'WAGE' },
      { name: 'House Rent Allowance', code: 'HRA', category: 'ALLOWANCE', sequence: 10, computeType: 'PERCENTAGE', percentage: 18, baseExpr: 'BASIC' },
      { name: 'Travel Reimbursement', code: 'TRV', category: 'ALLOWANCE', sequence: 20, computeType: 'FIXED', amount: 4000 },
      { name: 'Sales Commission', code: 'COMM', category: 'ALLOWANCE', sequence: 30, computeType: 'FORMULA', expression: 'wage * 0.12 * (worked_days / max(scheduled_days, 1))' },
      { name: 'Overtime Payout', code: 'OT', category: 'ALLOWANCE', sequence: 35, computeType: 'FORMULA', expression: 'overtime_hours * (wage / 176) * 1.5' },
      { name: 'Gross Salary', code: 'GROSS', category: 'GROSS', sequence: 60, computeType: 'FORMULA', expression: 'categories.BASIC + categories.ALLOWANCE' },
      { name: 'Provident Fund', code: 'PF', category: 'DEDUCTION', sequence: 70, computeType: 'FORMULA', expression: "min(categories['BASIC'] * 0.12, 1800)" },
      { name: 'Professional Tax', code: 'PT', category: 'DEDUCTION', sequence: 75, computeType: 'FIXED', amount: 200 },
      { name: 'Income Tax (TDS)', code: 'TDS', category: 'DEDUCTION', sequence: 80, computeType: 'FORMULA', expression: 'categories.GROSS > 60000 ? categories.GROSS * 0.1 : 0' },
      { name: 'Unpaid Leave Deduction', code: 'ULD', category: 'DEDUCTION', sequence: 85, computeType: 'FORMULA', expression: 'unpaid_leave_days > 0 ? roundTo(wage / days_in_period * unpaid_leave_days, 2) : 0' },
      { name: 'Net Salary', code: 'NET', category: 'NET', sequence: 90, computeType: 'FORMULA', expression: 'categories.GROSS - categories.DEDUCTION' },
    ],
  },
  {
    name: 'Contractor Payout', code: 'CTR',
    description: 'Fixed-term contractors: hours-based pay, no PF, TDS withheld at 10%.',
    rules: [
      { name: 'Contract Fee', code: 'BASIC', category: 'BASIC', sequence: 1, computeType: 'PERCENTAGE', percentage: 100, baseExpr: 'WAGE' },
      { name: 'Equipment Allowance', code: 'EQP', category: 'ALLOWANCE', sequence: 20, computeType: 'FIXED', amount: 2500 },
      { name: 'Overtime Payout', code: 'OT', category: 'ALLOWANCE', sequence: 30, computeType: 'FORMULA', expression: 'overtime_hours * (wage / 160)' },
      { name: 'Gross Salary', code: 'GROSS', category: 'GROSS', sequence: 60, computeType: 'FORMULA', expression: 'categories.BASIC + categories.ALLOWANCE' },
      { name: 'Withholding Tax', code: 'TDS', category: 'DEDUCTION', sequence: 70, computeType: 'PERCENTAGE', percentage: 10, baseExpr: 'GROSS' },
      { name: 'Unpaid Leave Deduction', code: 'ULD', category: 'DEDUCTION', sequence: 85, computeType: 'FORMULA', expression: 'unpaid_leave_days > 0 ? roundTo(wage / days_in_period * unpaid_leave_days, 2) : 0' },
      { name: 'Net Payout', code: 'NET', category: 'NET', sequence: 90, computeType: 'FORMULA', expression: 'categories.GROSS - categories.DEDUCTION' },
    ],
  },
  {
    name: 'Intern Stipend', code: 'INT',
    description: 'Interns: flat stipend prorated on attendance, no statutory deductions.',
    rules: [
      { name: 'Base Stipend', code: 'BASIC', category: 'BASIC', sequence: 1, computeType: 'FORMULA', expression: 'roundTo(wage * (worked_days / max(scheduled_days, 1)), 2)' },
      { name: 'Meal Allowance', code: 'MEAL', category: 'ALLOWANCE', sequence: 20, computeType: 'FIXED', amount: 150, quantity: 20 },
      { name: 'Learning Allowance', code: 'LRN', category: 'ALLOWANCE', sequence: 30, computeType: 'FIXED', amount: 1000 },
      { name: 'Gross Stipend', code: 'GROSS', category: 'GROSS', sequence: 60, computeType: 'FORMULA', expression: 'categories.BASIC + categories.ALLOWANCE' },
      { name: 'Unpaid Leave Deduction', code: 'ULD', category: 'DEDUCTION', sequence: 85, computeType: 'FORMULA', expression: 'unpaid_leave_days > 0 ? roundTo(wage / days_in_period * unpaid_leave_days, 2) : 0' },
      { name: 'Net Stipend', code: 'NET', category: 'NET', sequence: 90, computeType: 'FORMULA', expression: 'categories.GROSS - categories.DEDUCTION' },
    ],
  },
];

const structures = {};
for (const def of STRUCTURE_DEFS) {
  let s = await prisma.salaryStructure.findUnique({ where: { code: def.code }, include: { rules: true } });
  if (!s && !DRY) {
    note('salaryStructures');
    s = await prisma.salaryStructure.create({
      data: { name: def.name, code: def.code, description: def.description },
      include: { rules: true },
    });
  }
  if (!s) { structures[def.code] = { id: `dry-${def.code}`, rules: def.rules }; note('salaryRules', def.rules.length); continue; }

  // Add only rules this structure is missing, so hand-edited rules survive.
  for (const r of def.rules) {
    if (s.rules.some((x) => x.code === r.code)) continue;
    if (DRY) { note('salaryRules'); continue; }
    note('salaryRules');
    await prisma.salaryRule.create({ data: { ...r, structureId: s.id } });
  }
  structures[def.code] = await prisma.salaryStructure.findUnique({
    where: { id: s.id }, include: { rules: true },
  });
}

// ---------------------------------------------------------------------------
// 5. Employees and users
// ---------------------------------------------------------------------------
const existingEmployees = await prisma.employee.count();
const toCreate = Math.max(0, TARGET_EMPLOYEES - existingEmployees);
log(`Employees: ${existingEmployees} present, creating ${toCreate} to reach ${TARGET_EMPLOYEES}...`);

const FIRST = [
  'Aditya','Ananya','Arjun','Aarohi','Aryan','Bhavna','Chirag','Chaitali','Darshan','Deepika',
  'Dhruv','Esha','Farhan','Gaurav','Gayatri','Harsh','Hina','Ishaan','Ishita','Jatin',
  'Jaya','Kabir','Kavya','Kunal','Lavanya','Manav','Meera','Mihir','Naina','Nikhil',
  'Om','Pooja','Pranav','Preeti','Rahul','Rakhi','Ritvik','Riya','Sahil','Sanjana',
  'Shreya','Siddharth','Simran','Tanvi','Tarun','Uday','Urvashi','Varun','Vaishnavi','Yash',
  'Zoya','Nandini','Karthik','Lakshmi','Rohit','Swara','Devansh','Anjali','Parth','Trisha',
];
const LAST = [
  'Sharma','Verma','Iyer','Nair','Reddy','Menon','Bhat','Kulkarni','Deshmukh','Chauhan',
  'Malhotra','Kapoor','Bansal','Agarwal','Chopra','Bose','Ghosh','Dutta','Sinha','Mishra',
  'Trivedi','Pandey','Naidu','Pillai','Rathore','Solanki','Thakur','Sethi','Grover','Bhalla',
];
const LOCATIONS = ['Mumbai', 'Bengaluru', 'Pune', 'Delhi', 'Hyderabad', 'Chennai', 'Ahmedabad', 'Remote', 'Gandhinagar'];
const BANKS = ['HDFC', 'ICIC', 'SBIN', 'AXIS', 'KKBK'];

// Roughly 1 in 8 gets an HR/payroll role so every screen has a demo login.
const ROLE_DECK = [
  ...Array(78).fill('EMPLOYEE'),
  ...Array(10).fill('HR_MANAGER'),
  ...Array(6).fill('HR_PAYROLL_USER'),
  ...Array(5).fill('HR_PAYROLL_ADMIN'),
  ...Array(1).fill('ADMIN'),
];
const TYPE_DECK = [
  ...Array(68).fill('FULL_TIME'), ...Array(13).fill('PART_TIME'),
  ...Array(12).fill('CONTRACT'), ...Array(7).fill('INTERN'),
];

const WAGE_BY_TYPE = {
  FULL_TIME: [45000, 165000],
  PART_TIME: [28000, 55000],
  CONTRACT: [55000, 120000],
  INTERN: [15000, 30000],
};

const takenEmails = new Set(
  (await prisma.user.findMany({ select: { email: true } })).map((u) => u.email)
    .concat((await prisma.employee.findMany({ select: { workEmail: true } })).map((e) => e.workEmail)),
);

const passwordHash = DRY ? 'dry' : await bcrypt.hash(PASSWORD, 10);
const newEmployees = [];

for (let i = 0; i < toCreate; i += 1) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const deptName = pick(DEPT_NAMES);
  const employeeType = pick(TYPE_DECK);
  const posName = pick(DEPT_POSITIONS[deptName]);
  const schedName = pick(SCHEDULES_BY_TYPE[employeeType]);

  let email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@odoo.com';
  let n = 1;
  while (takenEmails.has(email)) {
    email = `${first}.${last}${n}`.toLowerCase().replace(/[^a-z.0-9]/g, '') + '@odoo.com';
    n += 1;
  }
  takenEmails.add(email);

  const [lo, hi] = WAGE_BY_TYPE[employeeType];
  const wage = Math.round(int(lo, hi) / 500) * 500;
  const status = chance(0.09) ? 'INACTIVE' : 'ACTIVE';
  // A handful stay login-less so the Admin "provision a user" flow is demoable.
  const wantsUser = !chance(0.035);
  const role = wantsUser ? pick(ROLE_DECK) : null;
  const hireDate = utc(int(2019, 2026), int(1, 12), int(1, 28));

  newEmployees.push({
    first, last, email, deptName, posName, schedName, employeeType, status, wage, role, hireDate,
    // A few blanks on purpose: they surface as payroll warnings on the dashboard.
    bankAccount: chance(0.03) ? null : `${pick(BANKS)}00${pad(int(1, 9999999), 7)}`,
    workLocation: pick(LOCATIONS),
    dateOfBirth: utc(int(1978, 2004), int(1, 12), int(1, 28)),
    phone: `+91 ${int(70000, 99999)}${int(10000, 99999)}`,
    isActive: !chance(0.05),
    mustReset: chance(0.04),
  });
}

const createdEmployees = [];
if (!DRY) {
  for (const p of newEmployees) {
    let user = null;
    if (p.role) {
      user = await prisma.user.create({
        data: {
          email: p.email, passwordHash, role: p.role,
          isActive: p.isActive && p.status === 'ACTIVE',
          mustReset: p.mustReset,
          lastLoginAt: chance(0.6) ? new Date(TODAY.getTime() - int(0, 45) * 86400000) : null,
        },
      });
      note('users');
    }
    const emp = await prisma.employee.create({
      data: {
        firstName: p.first, lastName: p.last, workEmail: p.email,
        personalEmail: `${p.first}.${p.last}${int(1, 999)}`.toLowerCase() + '@gmail.com',
        phone: p.phone, employeeType: p.employeeType, status: p.status,
        workLocation: p.workLocation, dateOfBirth: p.dateOfBirth, hireDate: p.hireDate,
        address: `${int(1, 240)}, ${pick(['MG Road', 'Ring Road', 'Sector 12', 'Park Street', 'Link Road'])}, ${p.workLocation}, India`,
        bankAccount: p.bankAccount,
        identificationNo: `ID-${pad(int(10000, 99999), 5)}`,
        companyId: company.id,
        departmentId: depts[p.deptName].id,
        jobPositionId: positions[p.posName].id,
        workingScheduleId: schedules[p.schedName].id,
        userId: user?.id ?? null,
      },
    });
    note('employees');
    createdEmployees.push({ ...emp, wage: p.wage, deptName: p.deptName, posName: p.posName });
  }
}

// Managers: one senior per department, drawn from that department's staff.
if (!DRY && createdEmployees.length) {
  log('Assigning managers...');
  for (const deptName of DEPT_NAMES) {
    const pool_ = await prisma.employee.findMany({
      where: { departmentId: depts[deptName].id, status: 'ACTIVE' },
      select: { id: true, hireDate: true },
      orderBy: { hireDate: 'asc' },
      take: 3,
    });
    if (pool_.length < 2) continue;
    const head = pool_[0];
    await prisma.employee.updateMany({
      where: { departmentId: depts[deptName].id, id: { not: head.id }, managerId: null },
      data: { managerId: head.id },
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Contracts
// ---------------------------------------------------------------------------
log('Contracts...');

// Continue the CON/<year>/<seq> sequence rather than restarting it.
const refSeq = {};
async function nextRef(year) {
  if (refSeq[year] === undefined) {
    const last = await prisma.contract.findFirst({
      where: { reference: { startsWith: `CON/${year}/` } },
      orderBy: { reference: 'desc' }, select: { reference: true },
    });
    refSeq[year] = last ? Number(last.reference.slice(`CON/${year}/`.length)) : 0;
  }
  refSeq[year] += 1;
  return `CON/${year}/${pad(refSeq[year])}`;
}

const structureForEmployee = (e) => {
  if (e.employeeType === 'INTERN') return structures.INT;
  if (e.employeeType === 'CONTRACT') return structures.CTR;
  if (e.deptName === 'Sales') return structures.SALES;
  if (e.wage >= 130000) return structures.EXEC;
  return structures.REG;
};

if (!DRY) {
  for (const e of createdEmployees) {
    const structure = structureForEmployee(e);

    // Historic contract for anyone hired before 2026, at ~90% of today's wage.
    if (e.hireDate < utc(2026, 1, 1) && chance(0.65)) {
      const y = Math.max(2024, e.hireDate.getUTCFullYear());
      await prisma.contract.create({
        data: {
          reference: await nextRef(y),
          name: `${e.firstName} ${e.lastName} - ${y}`,
          employeeId: e.id,
          startDate: utc(y, e.hireDate.getUTCMonth() + 1, 1),
          endDate: utc(2025, 12, 31),
          wage: money(e.wage * 0.9), status: 'EXPIRED',
          departmentId: e.departmentId, jobPositionId: e.jobPositionId,
          workingScheduleId: e.workingScheduleId, salaryStructureId: structure.id,
          notes: 'Superseded by the current contract.',
        },
      });
      note('contracts');
    }

    // Current contract. Most are open-ended; a few expire soon on purpose so
    // the dashboard's "expiring within 30 days" alert has something to show.
    const soonExpiry = chance(0.07);
    const fixedTerm = e.employeeType === 'CONTRACT' || e.employeeType === 'INTERN';
    const start = e.hireDate > utc(2026, 1, 1) ? e.hireDate : utc(2026, 1, 1);
    const endDate = soonExpiry
      ? new Date(TODAY.getTime() + int(3, 29) * 86400000)
      : fixedTerm ? utc(2027, int(1, 6), 28) : null;

    // Most people are RUNNING; a few sit in DRAFT/CANCELLED, which shows up as
    // the "no running contract" alert.
    const status = chance(0.03) ? 'DRAFT' : chance(0.02) ? 'CANCELLED' : 'RUNNING';
    await prisma.contract.create({
      data: {
        reference: await nextRef(start.getUTCFullYear()),
        name: `${e.firstName} ${e.lastName} - ${start.getUTCFullYear()}`,
        employeeId: e.id, startDate: start, endDate,
        wage: e.wage, status,
        departmentId: e.departmentId, jobPositionId: e.jobPositionId,
        workingScheduleId: e.workingScheduleId, salaryStructureId: structure.id,
        notes: status === 'DRAFT' ? 'Awaiting signature.' : null,
      },
    });
    note('contracts');
  }
}

// ---------------------------------------------------------------------------
// 7. Attendance
// ---------------------------------------------------------------------------
log(`Attendance (${ATT_FROM.toISOString().slice(0, 10)} -> ${TODAY.toISOString().slice(0, 10)})...`);

if (!DRY) {
  const editors = await prisma.user.findMany({
    where: { role: { in: ['HR_MANAGER', 'HR_PAYROLL_ADMIN', 'ADMIN'] } },
    select: { id: true }, take: 20,
  });

  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await prisma.attendance.createMany({ data: batch });
    note('attendance', batch.length);
    batch = [];
  };

  for (const e of createdEmployees) {
    if (e.status !== 'ACTIVE') continue;
    const lines = schedules[newEmployees.find((n) => n.email === e.workEmail).schedName].lines;

    for (let d = new Date(ATT_FROM); d <= TODAY; d.setDate(d.getDate() + 1)) {
      const line = lines.find((l) => l.dayOfWeek === isoDayOfWeek(d));
      if (!line) continue;

      const roll = rnd();
      if (roll < 0.05) continue;                 // absent: no record at all
      const missingCheckout = roll > 0.98;

      const [sh, sm] = line.startTime.split(':').map(Number);
      const lateToday = chance(0.15);
      const jitter = lateToday ? int(20, 65) : int(-5, 12);
      const checkIn = new Date(d);
      checkIn.setHours(sh, sm + jitter, 0, 0);

      const scheduled = parseHHMM(line.endTime) - parseHHMM(line.startTime);
      const worked = scheduled + (chance(0.22) ? rnd() * 2 : rnd() * 0.5 - 0.25);
      const checkOut = missingCheckout ? null : new Date(checkIn.getTime() + worked * 3_600_000);

      const workedHours = checkOut ? money((checkOut - checkIn) / 3_600_000) : 0;
      const expected = scheduled - Number(line.breakHours);
      const overtimeHours = checkOut
        ? money(Math.max(0, workedHours - Number(line.breakHours) - expected))
        : 0;
      const late = checkIn.getHours() * 60 + checkIn.getMinutes() > sh * 60 + sm + 15;
      const isManual = chance(0.03);

      batch.push({
        employeeId: e.id,
        checkIn: new Date(checkIn),
        checkOut,
        workedHours,
        overtimeHours,
        status: !checkOut ? 'MISSING_CHECKOUT' : late ? 'LATE' : 'PRESENT',
        isManual,
        editedById: isManual && editors.length ? pick(editors).id : null,
        notes: isManual ? 'Corrected after a badge reader failure.' : null,
      });
      if (batch.length >= 2000) await flush();
    }
  }
  await flush();
}

// ---------------------------------------------------------------------------
// 8. Leave allocations and requests
// ---------------------------------------------------------------------------
log('Leave allocations and requests...');

if (!DRY) {
  const approvers = await prisma.user.findMany({
    where: { role: { in: ['HR_MANAGER', 'HR_PAYROLL_ADMIN', 'ADMIN'] } },
    select: { id: true }, take: 20,
  });
  const allocatable = allTypes.filter((t) => t.requiresAllocation);
  const requestable = allTypes;

  for (const e of createdEmployees) {
    // Allocations: every allocation-backed type, plus the odd ad-hoc grant.
    for (const t of allocatable) {
      const amount = t.unit === 'HOURS' ? int(8, 40) : int(6, 24);
      await prisma.leaveAllocation.create({
        data: {
          employeeId: e.id, timeOffTypeId: t.id, amount,
          status: chance(0.9) ? 'APPROVED' : 'TO_APPROVE',
          validFrom: utc(2026, 1, 1), validTo: utc(2026, 12, 31),
          notes: '2026 annual allocation',
        },
      });
      note('allocations');
    }
    if (chance(0.2)) {
      const t = pick(allocatable);
      await prisma.leaveAllocation.create({
        data: {
          employeeId: e.id, timeOffTypeId: t.id, amount: int(2, 6),
          status: 'APPROVED', validFrom: utc(2026, 7, 1), validTo: utc(2026, 12, 31),
          notes: 'Ad-hoc grant for project overtime',
        },
      });
      note('allocations');
    }

    // Requests: a spread of past approvals/refusals and pending ones so the
    // approval inbox is not empty during the demo.
    const schedName = newEmployees.find((n) => n.email === e.workEmail).schedName;
    const lines = schedules[schedName].lines;

    for (let k = 0; k < int(1, 4); k += 1) {
      const t = pick(requestable);
      const month = int(1, 11);
      const day = int(1, 24);
      const from = utc(2026, month, day);
      const to = utc(2026, month, Math.min(day + int(0, 4), 28));

      let duration = 0;
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        if (lines.some((l) => l.dayOfWeek === isoDayOfWeek(d))) duration += 1;
      }
      if (!duration) continue;
      if (t.unit === 'HOURS') duration *= 8;

      // Anything in the future is still awaiting a decision; the past is settled.
      const isFuture = from > TODAY;
      const status = isFuture
        ? (chance(0.75) ? 'TO_APPROVE' : 'DRAFT')
        : pick(['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'REFUSED', 'CANCELLED']);

      const allocation = t.requiresAllocation
        ? await prisma.leaveAllocation.findFirst({
            where: { employeeId: e.id, timeOffTypeId: t.id, status: 'APPROVED' },
          })
        : null;

      await prisma.leaveRequest.create({
        data: {
          employeeId: e.id, timeOffTypeId: t.id,
          dateFrom: from, dateTo: to, duration, status,
          reason: pick(['Personal', 'Family function', 'Medical', 'Travel', 'Rest day', 'Childcare']),
          allocationId: status === 'APPROVED' ? allocation?.id ?? null : null,
          ...(['APPROVED', 'REFUSED'].includes(status) && approvers.length
            ? { approvedById: pick(approvers).id, approvedAt: from }
            : {}),
          ...(status === 'REFUSED' ? { refusalReason: pick(['Insufficient notice', 'Team capacity', 'Balance exhausted']) } : {}),
        },
      });
      note('requests');
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Payruns and payslips
// ---------------------------------------------------------------------------
log('Payruns and payslips...');

// Contract resolution mirrors contractForPeriod(), but from an in-memory map so
// 200 employees x N periods does not become 200 x N queries.
const allContracts = DRY ? [] : await prisma.contract.findMany({
  include: { workingSchedule: { include: { lines: true } } },
});
const contractsByEmployee = new Map();
for (const c of allContracts) {
  if (!contractsByEmployee.has(c.employeeId)) contractsByEmployee.set(c.employeeId, []);
  contractsByEmployee.get(c.employeeId).push(c);
}
const STATUS_ORDER = { DRAFT: 0, RUNNING: 1, EXPIRED: 2, CANCELLED: 3 };
for (const list of contractsByEmployee.values()) {
  list.sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.startDate - a.startDate);
}
const contractFor = (employeeId, periodStart, periodEnd) => {
  const list = (contractsByEmployee.get(employeeId) ?? []).filter(
    (c) => c.startDate <= periodEnd && (c.endDate === null || c.endDate >= periodStart),
  );
  return list.find((c) => c.status === 'RUNNING') ?? list[0] ?? null;
};

const allEmployees = DRY ? [] : await prisma.employee.findMany({
  where: { status: 'ACTIVE' },
  include: { workingSchedule: { include: { lines: true } } },
});
const employeeById = new Map(allEmployees.map((e) => [e.id, e]));

// Payslip numbers are handed out locally so the compute pool cannot race on
// nextPayslipNumber()'s read-then-increment.
const slipSeq = {};
const slipPrefix = (periodStart) => {
  const d = new Date(periodStart);
  return `SLIP/${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}/`;
};

// Primed once per period before any worker starts. Reading the high-water mark
// lazily inside the pool let two workers claim the same number.
async function primeSlipSeq(periodStart) {
  const prefix = slipPrefix(periodStart);
  if (slipSeq[prefix] !== undefined) return;
  const last = await prisma.payslip.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' }, select: { number: true },
  });
  slipSeq[prefix] = last ? Number(last.number.slice(prefix.length)) : 0;
}

// Synchronous, so incrementing cannot interleave with an await.
function nextSlipNumber(periodStart) {
  const prefix = slipPrefix(periodStart);
  slipSeq[prefix] += 1;
  return `${prefix}${pad(slipSeq[prefix])}`;
}

// Fills a payrun with one payslip per eligible employee that does not already
// have one, then computes them with the app's own engine.
async function fillPayrun(payrun, structure, employees, { compute }) {
  const existing = new Set(
    (await prisma.payslip.findMany({
      where: { payrunId: payrun.id }, select: { employeeId: true },
    })).map((p) => p.employeeId),
  );

  await primeSlipSeq(payrun.periodStart);

  const jobs = [];
  for (const e of employees) {
    if (existing.has(e.id)) continue;
    const contract = contractFor(e.id, payrun.periodStart, payrun.periodEnd);
    if (!contract) continue;
    jobs.push({ employee: employeeById.get(e.id) ?? e, contract });
  }

  await pool(jobs, 8, async ({ employee, contract }) => {
    const number = nextSlipNumber(payrun.periodStart);
    if (!compute) {
      await prisma.payslip.create({
        data: {
          number, payrunId: payrun.id, employeeId: employee.id, contractId: contract.id,
          periodStart: payrun.periodStart, periodEnd: payrun.periodEnd, status: 'DRAFT',
        },
      });
      note('payslips');
      return;
    }

    const ctx = await buildContext({
      employee, contract, periodStart: payrun.periodStart, periodEnd: payrun.periodEnd,
    });
    const { lines, totals } = runRules(structure.rules, ctx);
    await prisma.payslip.create({
      data: {
        number, payrunId: payrun.id, employeeId: employee.id, contractId: contract.id,
        periodStart: payrun.periodStart, periodEnd: payrun.periodEnd,
        status: payrun.status === 'PAID' ? 'PAID' : payrun.status === 'VALIDATED' ? 'VALIDATED' : 'COMPUTED',
        workedDays: ctx.worked_days, workedHours: ctx.worked_hours, leaveDays: ctx.leave_days,
        basic: totals.basic, allowance: totals.allowance, gross: totals.gross,
        deduction: totals.deduction, net: totals.net,
        emailSentAt: payrun.status === 'PAID' ? payrun.periodEnd : null,
        lines: { create: lines },
      },
    });
    note('payslips');
    note('payslipLines', lines.length);
  });
}

if (!DRY) {
  // One payrun per structure per month: a payrun carries a single rule set, and
  // splitting by structure also keeps each employee to one payslip per period,
  // which is what collectWarnings() flags as DUPLICATE_PAYSLIP.
  const MONTHS = [
    [1, 'January', 'PAID'], [2, 'February', 'PAID'], [3, 'March', 'PAID'],
    [4, 'April', 'PAID'], [5, 'May', 'PAID'], [6, 'June', 'PAID'],
    [7, 'July', 'PAID'], [8, 'August', 'VALIDATED'], [9, 'September', 'DRAFT'],
  ];

  // Payruns already in the database (from the original seed or created by hand)
  // are topped up rather than duplicated.
  const preexisting = await prisma.payrun.findMany();
  const coveringRun = (structureId, periodStart) =>
    preexisting.find(
      (p) => p.structureId === structureId
        && p.periodStart.getUTCFullYear() === periodStart.getUTCFullYear()
        && p.periodStart.getUTCMonth() === periodStart.getUTCMonth(),
    );

  for (const [m, label, defaultStatus] of MONTHS) {
    const periodStart = utc(2026, m, 1);
    const periodEnd = new Date(Date.UTC(2026, m, 0, 23, 59, 59, 999));

    for (const def of STRUCTURE_DEFS) {
      const structure = structures[def.code];

      // Only employees whose contract for this period actually runs on this
      // structure. That is what makes the split safe.
      const members = allEmployees.filter((e) => {
        const c = contractFor(e.id, periodStart, periodEnd);
        return c && c.status === 'RUNNING' && c.salaryStructureId === structure.id;
      });
      if (!members.length) continue;

      let payrun = coveringRun(structure.id, periodStart);
      const status = payrun?.status ?? defaultStatus;

      if (!payrun) {
        payrun = await prisma.payrun.create({
          data: {
            name: `${structure.name} / ${label} 2026`,
            structureId: structure.id, periodStart, periodEnd, status,
            computedAt: status === 'DRAFT' ? null : periodEnd,
            validatedAt: ['VALIDATED', 'PAID'].includes(status) ? periodEnd : null,
            paidAt: status === 'PAID' ? periodEnd : null,
            sentAt: status === 'PAID' ? periodEnd : null,
          },
        });
        note('payruns');
      }

      // A DRAFT run keeps DRAFT payslips, so the demo can compute it on stage.
      await fillPayrun(payrun, structure, members, { compute: payrun.status !== 'DRAFT' });
      log(`  ${payrun.name} (${payrun.status}) <- ${members.length} employees`);

      await persistWarnings(
        payrun.id,
        await collectWarnings(await prisma.payrun.findUnique({ where: { id: payrun.id } })),
      );
    }
  }

  // Any remaining pre-existing payrun outside the Jan-Sep window (e.g. October)
  // still gets its roster filled out.
  for (const payrun of preexisting) {
    if (payrun.periodStart >= utc(2026, 1, 1) && payrun.periodStart < utc(2026, 10, 1)) continue;
    const full = await prisma.payrun.findUnique({
      where: { id: payrun.id }, include: { structure: { include: { rules: true } } },
    });
    const members = allEmployees.filter((e) => {
      const c = contractFor(e.id, full.periodStart, full.periodEnd);
      return c && c.status === 'RUNNING' && c.salaryStructureId === full.structureId;
    });
    log(`  topping up ${full.name} (${full.status}) <- ${members.length} employees`);
    await fillPayrun(full, full.structure, members, { compute: full.status !== 'DRAFT' });
    await persistWarnings(full.id, await collectWarnings(full));
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totals = {
  companies: await prisma.company.count(),
  departments: await prisma.department.count(),
  jobPositions: await prisma.jobPosition.count(),
  workingSchedules: await prisma.workingSchedule.count(),
  users: await prisma.user.count(),
  employees: await prisma.employee.count(),
  contracts: await prisma.contract.count(),
  attendance: await prisma.attendance.count(),
  timeOffTypes: await prisma.timeOffType.count(),
  allocations: await prisma.leaveAllocation.count(),
  requests: await prisma.leaveRequest.count(),
  salaryStructures: await prisma.salaryStructure.count(),
  salaryRules: await prisma.salaryRule.count(),
  payruns: await prisma.payrun.count(),
  payslips: await prisma.payslip.count(),
  payslipLines: await prisma.payslipLine.count(),
  payrollWarnings: await prisma.payrollWarning.count(),
};

log(DRY ? '\nDry run — nothing written.' : '\nDone.');
log('Created this run:', created);
log('Database totals:', totals);
if (!DRY) log(`\nEvery generated login uses the password ${PASSWORD}.`);

await prisma.$disconnect();
