# PeoplePay360 — HR & Payroll

An integrated HR and payroll operations platform: employee master data, contracts,
working schedules, attendance, time off, a configurable salary-rule engine, payruns,
payslip PDFs, bulk email delivery, and a live payroll dashboard.

Built for **Odoo Hackathon 2026** (Team 375).

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite 8 + Tailwind v4 (Odoo plum theme), Recharts |
| Backend | Express 5 (ESM), Zod validation |
| ORM / DB | Prisma 6 + PostgreSQL (`odoo-finale`) |
| Auth | JWT access token (in-memory) + rotating refresh token (httpOnly cookie) |
| Payslip PDF | `pdfkit` — one buffer serves both download and email attachment |
| Email | `nodemailer` (Gmail SMTP) |
| Rule engine | `expr-eval` sandbox — no `eval`, no JS runtime access |

---

## Setup

Requires Node 20+ and a running PostgreSQL.

```bash
# 1. Database
createdb odoo-finale                 # skip if it already exists

# 2. Backend
cd server
npm install
cp .env.example .env                 # then set DATABASE_URL + JWT secrets
npm run migrate                      # apply migrations
npm run seed                         # demo data (13 employees, 3 payruns, 783 attendance rows)
npm run dev                          # http://localhost:4000

# 3. Frontend (separate terminal)
cd client
npm install
npm run dev                          # http://localhost:5173
```

`npm run db:reset` drops, re-migrates and re-seeds in one step.

### Demo logins

| Email | Password | Role | Sees |
|---|---|---|---|
| `admin@oxp.com` | `Admin@123` | Administrator | Everything, incl. User Management |
| `aarav@oxp.com` | `Pass@1234` | Payroll Admin | Full payroll + salary rule config |
| `nisha@oxp.com` | `Pass@1234` | Payroll User | Payruns/payslips; salary config read-only |
| `sara@oxp.com` | `Pass@1234` | HR Manager | HR modules; **no** payroll access |
| *(see below)* | `Pass@1234` | Employee | Own records only |

The Employee demo account is deliberately pointed at a **real mailbox** so the
password-reset email can be shown arriving; check `User.email` for `Rohan Patel`.

### Password reset

"Forgot password?" on the sign-in screen issues a single-use token (SHA-256 hashed
in the database, 30-minute TTL) and emails a reset link. Requesting a new link
invalidates the previous one, using a link consumes it, and completing a reset
revokes every existing session. The endpoint returns the *same* generic response
for known and unknown addresses, so it cannot be used to enumerate accounts.

Because SMTP is unconfigured out of the box, the reset link is also returned in the
response and printed to the server log **in development only** — so the flow is
fully testable without email. That never happens when `NODE_ENV=production`.

### Email delivery

Mail is sent from exactly one place: **Send Payslips** on a validated or paid
payrun (`POST /api/payroll/payruns/:id/send`), plus the password-reset link above.

Without SMTP credentials it runs as a dry run — every PDF is still rendered, but
nothing is delivered: the response reports `sent: 0`, `prepared: N`, `dryRun: true`,
`emailSentAt` is left unset, and the UI says so plainly rather than claiming a
delivery. To send for real, set `SMTP_USER` and `SMTP_PASS` (a Gmail **App
Password**, not the account password) in `server/.env` and restart the API.

**Payslip recipients must be real mailboxes.** `Employee.workEmail` is where payslips
are delivered; the seed's `@oxp.com` addresses do not exist, and Gmail accepts them
at SMTP level before bouncing them back minutes later. Point them at addresses you
control before demoing — Gmail's `+alias` form (`you+aarav@gmail.com`) works well:
every message lands in one inbox, but SMTP treats each as a distinct recipient, so
per-employee delivery is genuinely demonstrated.

Login addresses (`User.email`) are separate from payslip addresses
(`Employee.workEmail`), so the short `@oxp.com` logins above keep working regardless.

A payrun sends in concurrent batches of 4 — a Gmail round trip is ~4s, so a
12-payslip run completes in ~20s rather than the ~50s a serial loop would take.

---

## The parts that carry the business logic

### Salary rule engine — `server/src/modules/salary/`

Rules run in ascending `sequence`. Each result folds into running category totals
before the next rule runs, so later rules are expressed in terms of earlier ones:

```
 1  BASIC   Percentage  50% of Contract Wage
10  HRA     Percentage  20% of BASIC
30  BONUS   Formula     worked_days >= 20 ? wage * 0.05 : 0
60  GROSS   Formula     categories.BASIC + categories.ALLOWANCE
70  PF      Formula     min(categories['BASIC'] * 0.12, 1800)
85  ULD     Formula     roundTo(wage / days_in_period * unpaid_leave_days, 2)
90  NET     Formula     categories.GROSS - categories.DEDUCTION
```

Three computation methods, matching the spec: **Fixed**, **Percentage** of a named
base (Wage/Basic/Gross/Net), and **Formula**. A `quantity` multiplier and an optional
`condition` guard apply to all three.

`GROSS` and `NET` *assign* their category total rather than accumulating into it,
so a total rule never double-counts the components already summed into it.

**Expressions are sandboxed.** `expr-eval` parses its own grammar and never touches
the JS runtime; assignment is disabled and only `min, max, round, roundTo, floor,
ceil, abs` are callable. Identifiers absent from the context are rejected up front
rather than evaluating to `undefined` and silently poisoning a payslip:

```
process.exit(1)   ->  unknown variable(s): process
require("fs")     ->  unknown variable(s): require
wage = 999        ->  Unknown character "="
1/0               ->  must produce a finite number
```

The rule form validates live against a sample context, so an author sees the
computed result before the rule ever reaches a payrun.

### Period-correct contracts

`contractForPeriod()` resolves the single contract covering a payroll period,
preferring a `RUNNING` one. Creating or updating a contract rejects a second
`RUNNING` contract whose dates overlap an existing one, so payroll can always
resolve exactly one.

`Payslip.contractId` is a **snapshot** taken at compute time — editing a contract
later never rewrites historical payslips. `PayslipLine` likewise copies each rule's
`code`/`name`/`category`, so lines survive rule edits or deletion.

### Leave balances

`LeaveAllocation` stores only the granted `amount`. "Taken" and "remaining" are
**derived** from linked approved requests, so a balance cannot drift. Approving a
request consumes an approved allocation and refuses to push the balance negative.
Duration counts only days the employee is *scheduled* to work — a Friday-to-Monday
request on a Mon–Fri schedule costs 2 days, not 4.

### Attendance

Worked hours and overtime are always recomputed server-side from the timestamps and
the employee's schedule; a client cannot post its own hours. Worked hours are the raw
check-in→check-out span; overtime is measured net of the configured break against
scheduled hours. Late is a 15-minute grace on the scheduled start.

### Deleting vs archiving an employee

Deleting an employee cascades away their contracts, attendance and leave, so the
API refuses it outright once any **payslip** exists — payroll history is a record,
not a convenience. The UI asks for the employee's name typed back before allowing
it, and shows exactly what each option destroys.

A delete also removes the **linked login and revokes its sessions**. Without that
the `User` row survives (`Employee.userId` is `SetNull`) and the account keeps
authenticating against a person who no longer exists.

`POST /employees/:id/archive` is the reversible alternative: it keeps every record,
sets the employee `INACTIVE`, deactivates the login and revokes its sessions.
`POST /employees/:id/restore` undoes it.

### User management

Admin-only. Accounts are separate from employee records but linked to one, so the
screen lists **Users** and shows the employee behind each. Roles can be reassigned,
accounts activated or deactivated, passwords reset, and logins revoked without
touching the employee record.

Three guards prevent an administrator locking themselves out — the app has no
recovery path if they do:

- You cannot change your own role, deactivate yourself, or delete your own account.
- The **last active administrator** cannot be demoted, deactivated or deleted.
- Changing a role, deactivating an account or resetting a password **revokes every
  refresh token** for that user, so the old access level cannot outlive the change.

### Payrun workflow

Two-step wizard — step 1 collects scope and previews eligibility, and **nothing is
persisted until employees are selected**. Then `Compute → Validate → Mark Paid`,
with guards at each transition. Warnings are collected on compute and surfaced on
the payrun screen: `ERROR` severity (duplicate payslip, negative net, no running
contract) **blocks** validation; `WARNING` severity (missing bank details, missing
check-out) is advisory. A paid payrun cannot be deleted or recomputed.

---

## API surface

```
POST   /api/auth/login | refresh | logout | change-password    GET /api/auth/me
POST   /api/auth/forgot-password | reset-password
GET    /api/org/companies | departments | job-positions
CRUD   /api/employees                POST /api/employees/:id/user   (admin)
GET    /api/employees/:id/deletion-impact   POST /api/employees/:id/archive | restore
CRUD   /api/users  (admin)           GET /api/users/assignable-employees | roles
POST   /api/users/:id/reset-password
CRUD   /api/contracts
CRUD   /api/working-schedules
CRUD   /api/attendance               GET/POST /api/attendance/me/status|check-in|check-out
CRUD   /api/time-off/types | allocations | requests             GET /api/time-off/balances
POST   /api/time-off/requests/:id/approve | refuse
CRUD   /api/salary/structures | rules    POST /api/salary/rules/validate
GET    /api/payroll/payruns/eligible     CRUD /api/payroll/payruns
POST   /api/payroll/payruns/:id/compute | validate | mark-paid | send
GET    /api/payroll/payslips             GET /api/payroll/payslips/:id/pdf
GET    /api/dashboard
```

### Roles

`EMPLOYEE < HR_MANAGER < HR_PAYROLL_USER < HR_PAYROLL_ADMIN < ADMIN`

HR Manager has full HR access but **no** payroll access. Payroll User can run
payruns but only *read* salary structures and rules. Only Admin creates user
accounts. Employees are scoped to their own records at the query level, not just
hidden in the UI.

---

## Demo script (5 minutes)

**Scenario A — employee to payslip**
1. Sign in as `aarav@oxp.com`. The dashboard shows live totals across July/August.
2. Employees → open **Aarav Mehta** → smart buttons show related Contracts,
   Attendance and Time Off, filtered to that employee.
3. Payroll → Salary Rules → open **Provident Fund**; edit the expression and watch
   it validate live. Try `process.exit(1)` to show the sandbox rejecting it.
4. Payroll → Payruns → **Payrun / September 2026** (DRAFT) → **Compute**.
   Payslips populate with a full rule-by-rule breakdown; warnings appear for the
   employee with no bank account.
5. **Validate** → **Mark Paid** → open a payslip → **Print Payslip** (PDF) →
   back on the payrun, **Send Payslips**.

**Scenario B — leave allocation to request**
1. Time Off → Types: show `Paid Time Off` requires an allocation, `Unpaid Leave` does not.
2. Allocations: an approved 18-day PTO grant, with taken/remaining derived live.
3. Requests → New Request over a weekend — duration counts only working days.
4. Sign in as `sara@oxp.com` (HR Manager) and approve it; the balance drops.
   Request more than the balance and approval is refused with the exact shortfall.
5. Note that Sara has no Payroll menu at all — role separation is enforced server-side.

---

## Known gaps / roadmap

- Email is dry-run until Gmail App Password credentials are set.
- Password reset relies on email; with SMTP unset the link is surfaced in the UI
  (development only).
- Salary structures link out to a filtered rule list rather than editing rules inline.
- No automated test suite — verification was done through scripted API integration
  runs against a live server.
- Attendance has no calendar view; the mockup's Working Schedule "Calendar" tab is
  not implemented (List view is).
- Multi-company exists in the schema but the UI assumes a single company.
