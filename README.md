# PeoplePay360 — HR & Payroll

An integrated HR and payroll operations platform: employee master data, contracts,
working schedules, attendance, time off, a configurable salary-rule engine, payruns,
payslip PDFs, bulk email delivery, and a live payroll dashboard.

Built by **Abhimanyu Kumar** for **Odoo Hackathon 2026** (Team 375).

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
npm run seed                         # small demo set (13 employees, 3 payruns)
npm run dev                          # http://localhost:4000

# 3. Frontend (separate terminal)
cd client
npm install
npm run dev                          # http://localhost:5173
```

`npm run db:reset` drops, re-migrates and re-seeds in one step.

> **Do not run `npm run seed` or `npm run db:reset` against the demo database.**
> Both delete every row first. The demo data lives in PostgreSQL, not in a file
> that gets replayed.

### Demo data

`prisma/seed.js` builds a small 13-employee database from scratch and is
destructive. `scripts/bulk-data.js` is the opposite: it **tops the live database
up** to full demo scale and never deletes anything, so records added by hand
through the UI survive a re-run.

```bash
npm run data:bulk:dry     # report what it would create
npm run data:bulk         # top up to 200 employees + the payroll history
```

Current scale: **200 employees / 195 users** across 5 roles, 12 departments,
24 job positions, 11 working schedules, 308 contracts, **~11k attendance rows**,
10 time off types, ~1.2k allocations, ~360 requests, 6 salary structures,
49 salary rules, **49 payruns**, ~1.5k payslips and **~15k payslip lines**.

Payslips are generated through the app's own rule engine (`buildContext` /
`runRules`), so pressing **Recompute** in the UI reproduces exactly the stored
figures. Every generated login uses the password `Pass@1234`.

The data deliberately includes the edge cases each screen is meant to surface:
employees with no bank account, active employees with no running contract,
contracts expiring within 30 days, missing check-outs, manually corrected
attendance, and a DRAFT September payrun left uncomputed so the compute step can
be demoed live.

### Backup and restore

```bash
npm run db:backup                # backups/<timestamp>.dump
npm run db:backup -- golden      # overwrite the named demo snapshot
npm run db:restore -- golden     # roll the database back to it (prompts first)
npm run db:restore               # restore the newest dump
```

`backups/golden.dump` is the snapshot taken right after the bulk load. Take a
fresh backup before the presentation, and restore it if a live demo edit goes
wrong.

### Demo logins

| Email | Password | Role | Sees |
|---|---|---|---|
| `admin@odoo.com` | `Admin@123` | Administrator | Everything, incl. User Management |
| `aarav@odoo.com` | `Pass@1234` | Payroll Admin | Full payroll + salary rule config |
| `nisha@odoo.com` | `Pass@1234` | Payroll User | Payruns/payslips; salary config read-only |
| `sara@odoo.com` | `Pass@1234` | HR Manager | HR modules; **no** payroll access |
| `rohan@odoo.com` | `Pass@1234` | Employee | Own records only |

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
are delivered; the seed's `@odoo.com` addresses do not exist, and Gmail accepts them
at SMTP level before bouncing them back minutes later. Before demoing real delivery,
edit one or two employees' work email to an address you control (Employees → open an
employee → Edit → Work Email).

Login addresses (`User.email`) are separate from payslip addresses
(`Employee.workEmail`), so changing a work email does not change how anyone signs in.

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

### Salary structures

A structure is a container, so its form shows what it contains: every rule in
execution order with a plain-English summary of what each computes
(`₹150 x 20`, `50% of WAGE`, `min(categories.BASIC * 0.12, 1800)`), inactive
rules greyed out. The list separates **Employees** (people a structure pays
today, derived from running contracts) from **Contracts** (every contract ever
written against it) — the two differ by roughly 2x, since most employees carry an
expired contract alongside their current one.

### Payrun workflow

Two-step wizard — step 1 collects scope and previews eligibility, and **nothing is
persisted until employees are selected**. Then `Compute → Validate → Mark Paid`,
with guards at each transition. Warnings are collected on compute and surfaced on
the payrun screen: `ERROR` severity (duplicate payslip, negative net, no running
contract) **blocks** validation; `WARNING` severity (missing bank details, missing
check-out) is advisory. A paid payrun cannot be deleted or recomputed.

### Interactive dashboard

Every headline metric can be sliced along any axis and drilled into, rather than
being a static picture:

- **Group by** Department, Job Position, Employee Type or Work Location on the
  salary and time-off charts.
- **Click any bar, attendance band or leave type** to open a drill-down panel
  scoped to that slice. The panel keeps a breadcrumb trail — each click adds one
  filter, so `All → Finance → Data Analyst` is the same question asked of a
  smaller population — and can pivot between salary, attendance and time off
  without leaving the slice.
- **"Apply to dashboard"** turns a drill trail into page-wide filters; applied
  filters show as removable chips with a single Reset.
- Clicking a month on the trend line filters the whole dashboard to that period.

One endpoint (`/api/dashboard/drilldown`) serves all of it: each level down is
the same aggregation with one more filter, so the drill never runs out of depth.

### Editable payrun roster

A payrun is not frozen the moment it is created:

| Operation | When it is allowed | Why |
|---|---|---|
| Rename the run | always | a label is not financial data |
| Change period / structure | `DRAFT` only | they define what the payslips were computed from |
| Add employees | `DRAFT` / `COMPUTED` | forgetting someone should not mean rebuilding the run; adding drops the run back to `DRAFT` so it cannot claim to be computed with uncomputed rows |
| Remove a payslip | `DRAFT` / `COMPUTED` | the roster was wrong |
| **Cancel** a payslip | `COMPUTED` / `VALIDATED` / `PAID` | after validation a payslip records money that moved — cancelling voids it without erasing it, drops it from the run totals, and clears its duplicate warning |
| Delete the run | not when `PAID` | paid runs are historical records |

### Segregation of duties

Approval is a control, so it is never self-applied:

- Nobody can approve or refuse **their own** time off request or allocation —
  admins included. The answer is a second approver, not an exemption.
- Nobody can change **their own** role or deactivate their own account.
- `TimeOffType.approvalMode` is enforced rather than merely stored:
  `MANAGER` means the employee's own line manager (a per-employee relationship,
  so a manager who is a plain `EMPLOYEE` can still act), `OFFICER` means an HR
  officer **or** that employee's named **HR Responsible**, and `NONE`
  auto-approves on submission.

### Audit trail

A record of who changed what, bolted on rather than woven in. **No route code
was modified to produce it**: writes are captured by a Prisma client extension,
and the actor travels through the request in `AsyncLocalStorage` (decoded from
the bearer token by its own middleware, so even the auth layer is untouched).

`AuditLog` has **no foreign keys and no relation fields on any other model** —
it stores the actor and the record as plain text, so deleting an employee can
never cascade away their history, and no existing query changes because the
table exists. Three rules keep it out of the way: never throw (a failed audit
write cannot fail a payroll operation), never block (logged after the operation
returns), never touch high-volume tables.

It records decisions, not machine output. Creating a 40-person payrun, computing
it and cancelling one payslip produces **3 rows, not 75** — payslip creation is
the payrun's expansion, and recomputing figures is not a decision.

### CSV export

Employees, Payruns and Payslips each export the rows currently on screen. The
export route reuses the list route's own `where` clause — the same filters,
search and scoping, minus the pagination — so the file always matches the view.
Verified: a filtered list showing 161 payslips exports exactly 161 rows, and an
employee exporting their own payslips gets only their own.

Files carry a UTF-8 BOM, without which Excel mangles the rupee sign and every
non-ASCII name.

### Send preview

`Send Payslips` opens a dry run first. With 87 recipients the useful question is
not "what does one email look like" but **"who is about to receive mail, and who
will not"** — so the roster leads: a per-recipient list marking who is
deliverable and why anyone is skipped, with counts for how many have already
been emailed once. Selecting a name shows that person's exact subject, body and
attachment filename.

The whole set arrives in one request, so switching between recipients is
instant, and the bodies come from the same `mailBody()` the sender uses, so the
preview cannot drift from what is actually sent. PDFs are not rendered for a
preview. Confirming hands off to the existing send flow unchanged.

### Ask HR — natural-language queries

A floating button opens a chat that answers questions about live data:
*"Which Finance employees had attendance below 80% this month?"*

**The model never touches the database and never writes a query.** It picks one
of six typed, read-only tools and fills in their parameters; the tool then runs
the same scoped code the screens run. That choice carries three properties:

- **Authorization is free.** Tools reuse the existing scope, so an `EMPLOYEE`
  asking "list everyone" gets exactly one row — their own. Verified.
- **Numbers cannot be hallucinated.** All arithmetic happens in PostgreSQL. The
  model sees only the result's shape and an 8-row sample, and the table the user
  reads is rendered from the server's rows — so the sentence and the figures
  come from the same response and cannot disagree.
- **Nothing can be changed from chat.** There is no approve, pay, edit or delete
  tool. Bank accounts, addresses and identification numbers are stripped before
  anything reaches the model.

Each answer shows the tool and arguments that produced it, so the query is
auditable by eye rather than taken on trust.

Optional: without `GEMINI_API_KEY` the chat reports that it is offline and the
rest of the app is unaffected.

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
CRUD   /api/org/departments  (hr)
CRUD   /api/salary/structures | rules    POST /api/salary/rules/validate
GET    /api/salary/rules-meta            (variables, functions, worked examples)
GET    /api/payroll/payruns/eligible     CRUD /api/payroll/payruns
PATCH  /api/payroll/payruns/:id          (rename always; period/structure while DRAFT)
POST   /api/payroll/payruns/:id/payslips (add employees to an existing run)
POST   /api/payroll/payruns/:id/compute | validate | mark-paid | send
GET    /api/payroll/payslips             GET /api/payroll/payslips/:id/pdf
DELETE /api/payroll/payslips/:id         (remove a row before validation)
POST   /api/payroll/payslips/:id/cancel  (void after validation, keeps the record)
GET    /api/dashboard                    GET /api/dashboard/drilldown
GET    /api/payroll/payruns/:id/send-preview   (dry run: roster + rendered bodies)
GET    /api/employees/export | /api/payroll/payruns/export | payslips/export  (CSV)
GET    /api/audit | /api/audit/meta | /api/audit/:entity/:entityId   (read-only)
GET    /api/assistant/status         POST /api/assistant/chat        (read-only)
```

Every list endpoint accepts `?page=&limit=&search=&sortBy=&sortDir=`, and the
date-bearing ones accept `?year=&month=`.

### Roles

`EMPLOYEE < HR_MANAGER < HR_PAYROLL_USER < HR_PAYROLL_ADMIN < ADMIN`

HR Manager has full HR access but **no** payroll access. Payroll User can run
payruns but only *read* salary structures and rules. Only Admin creates user
accounts. Employees are scoped to their own records at the query level, not just
hidden in the UI.

---

## Demo script (5 minutes)

**Scenario A — employee to payslip**
1. Sign in as `aarav@odoo.com`. The dashboard shows live totals across July/August.
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
4. Sign in as `sara@odoo.com` (HR Manager) and approve it; the balance drops.
   Request more than the balance and approval is refused with the exact shortfall.
5. Note that Sara has no Payroll menu at all — role separation is enforced server-side.
6. Try to approve **your own** request as Sara — refused. Segregation of duties
   applies to admins too.

**Scenario C — the dashboard is a tool, not a picture**
1. Payroll → Dashboard. Switch **Salary Cost** from Department to **Job Position**.
2. Click the **Finance** bar → drill panel opens scoped to Finance. Switch the tab
   to **Attendance** — same slice, different metric. Group by Job Position and
   click again: the breadcrumb reads `All → Finance → Data Analyst`.
3. **Apply to dashboard** — every KPI, chart and table narrows to that slice, with
   removable filter chips. **Reset filters** returns to the full view.
4. Click the **Late** band on Attendance Overview → the employees behind the
   number, ranked.

---

## Known gaps / roadmap

- Email is dry-run until Gmail App Password credentials are set.
- Password reset relies on email; with SMTP unset the link is surfaced in the UI
  (development only).
- No automated test suite — verification was done through scripted API integration
  runs against a live server, asserting on real data rather than fixtures.
- Attendance has no calendar view; the mockup's Working Schedule "Calendar" tab is
  not implemented (List view is).
- Multi-company exists in the schema and is filterable on the dashboard, but the
  rest of the UI assumes a single company.
- A cancelled payslip cannot be reopened; cancelling is one-way.
- Users hold a single role rather than a set. The roles are hierarchical, so a
  higher role already implies the lower ones.
