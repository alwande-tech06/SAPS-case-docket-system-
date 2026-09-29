# SAPS Case Docket Accountability System

SODM401 / SFEN301 group project. A Flask application with a PostgreSQL
database: the public report a crime and track it, police officials dispose of
reports, detectives investigate, station commanders oversee, administrators
manage accounts. Every change is enforced and audited on the server.

## How it fits together

```
browser ── pages (HTML/CSS/JS) ──┐
                                 ├── Flask (one server) ── PostgreSQL
browser ── /api/... (JSON) ──────┘
```

- **Pages** are the templates in `app/templates/`. When Flask renders one, it
  embeds the data that person may see (`window.SAPS_SNAPSHOT`): a staff
  member's own station, a complainant's own reports, or only reference data for
  anyone else. `app/static/js/store.js` reads it, so screens and the rules
  engine (`rules.js`) read synchronously.
- **Every change** goes to `POST /api/actions/<name>`, named after the Store
  function that calls it. The server checks the role, the station and every
  rule, writes a SHA-256 hash-chained audit entry, and returns the result with
  a fresh snapshot. The browser is never trusted to enforce anything.
- **Files** (exhibit photographs, complainant uploads) are stored in the
  database and served from `/api/files/<id>` only to people entitled to them.

```
run.py / wsgi.py            Development server / production entry point
config.py                   Settings (read from .env)
app/__init__.py             Application factory, CLI commands
app/models.py               The 27 tables
app/routes/pages.py         One route per page, server-side role guard
app/routes/api.py           The JSON API
app/services/               The rules: intakes, dockets, admin, escalation, email, one-time codes, snapshots
app/security.py             Rate limits, security headers, JSON-only writes
app/scheduler.py            In-app timer for the overdue-report escalation
app/seed.py                 Reference data and the demonstration data
app/templates/, app/static/ The pages
migrations/                 Database schema (Alembic)
tests/                      90 tests, run with pytest
```

## Running it locally

Needs Python 3.12+ and PostgreSQL.

1. Create a database and a user for it, e.g. in pgAdmin's Query Tool:
   ```sql
   CREATE ROLE saps_user WITH LOGIN PASSWORD 'choose-one';
   CREATE DATABASE saps_docket OWNER saps_user;
   ```
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and `SECRET_KEY`.
   Check the port: a PostgreSQL installed as a Windows service is often on 5433.
3. Install, build the schema, load the demonstration data, start:
   ```
   python -m venv .venv
   .venv\Scripts\activate          # Windows  (source .venv/bin/activate elsewhere)
   pip install -r requirements.txt
   flask db upgrade
   flask seed
   python run.py
   ```
4. Open `http://127.0.0.1:5000`.

Run the tests with `pytest` (they use an in-memory database, not yours).

### Commands

| Command | What it does |
|---|---|
| `flask db upgrade` | Create or update the database schema |
| `flask seed` | **Wipe everything** and load the demonstration data |
| `flask init-reference` | Load stations, specialisations and crime categories (safe to repeat) |
| `flask create-admin` | Create an administrator account (asks for name, email, password) |
| `flask escalate-overdue` | Escalate every report undisposed for more than 24 hours (safe to repeat) |
| `flask verify-audit` | Walk the SHA-256 audit chain and report the first broken link |

### Demonstration accounts

Loaded by `flask seed`, shown on the login page while `DEMO_MODE` is on. All
use the password `demo1234`.

| Email | Role | What they see |
|---|---|---|
| `official@saps.demo` | Police Official | Pending report queue, disposition, assisted capture |
| `official2@saps.demo` | Police Official | (a second official, for two-person rules) |
| `detective@saps.demo` | Detective | Own caseload, evidence, arrests, handover |
| `commander@saps.demo` | Station Commander | Oversight, sign-offs, escalations, reconciliation, audit trail |
| `admin@saps.demo` | Administrator | User accounts, reference data, audit trail |

In demonstration mode the one-time codes and password-reset links are shown on
screen instead of being sent by SMS or email, and the login page has **Reset
demonstration data**.

## Publishing it

### 1. Server and database

Any host that runs Python and PostgreSQL: a university or departmental server,
a Windows or Linux VM, or a platform such as Render, Railway or Azure App
Service with a managed PostgreSQL database. Turn on the database's automatic
backups.

### 2. Settings (`.env` or the host's environment variables)

```
FLASK_CONFIG=production
DATABASE_URL=postgresql://...          # the production database
SECRET_KEY=<64 random hex characters>  # python -c "import secrets; print(secrets.token_hex(32))"
DEMO_MODE=false
SMS_PROVIDER=<your gateway>            # see "One-time codes" below
EMAIL_PROVIDER=smtp                    # see "Password resets" below
SMTP_HOST=... SMTP_PORT=587 SMTP_USERNAME=... SMTP_PASSWORD=... SMTP_FROM=...
PUBLIC_BASE_URL=https://<your site>    # for the links in emails
SCHEDULER_ENABLED=true                 # or schedule the job yourself, see below
```

Production refuses to start with a missing or weak `SECRET_KEY`, and logs a
warning if `DEMO_MODE` or `SMS_PROVIDER=demo` is still on.

### 3. First deployment

```
pip install -r requirements.txt
flask db upgrade
flask init-reference
flask create-admin
```

Do **not** run `flask seed` on a production database: it deletes everything
and creates accounts with a published password. The administrator then creates
every other account from the admin screen. Each new account gets a one-time
password, shown once, which the person must change when they first sign in.

### 4. Run it behind HTTPS

```
waitress-serve --listen=0.0.0.0:8000 wsgi:app                # Windows or Linux
gunicorn --workers 3 --bind 0.0.0.0:8000 wsgi:app           # Linux
```

Put a reverse proxy (nginx, IIS, or the platform's load balancer) in front to
serve HTTPS. Sign-in cookies are marked `Secure`, so the site does not work
over plain HTTP in production — that is deliberate.

Later releases: pull the new code, `pip install -r requirements.txt`,
`flask db upgrade`, restart.

### One-time codes (SMS)

Reporting online and opening a QR tracking link both send a six-digit code to
the complainant's phone. `SMS_PROVIDER` decides how:

- `demo` — shown on the page. Demonstrations only.
- `console` — written to the server log. For testing a production build.
- anything else — connect your SMS gateway (for example Clickatell, BulkSMS or
  Twilio) in `send_sms()` in `app/services/otp.py`. **This is required before
  the public can use the site**; until then nobody can report online or open a
  tracking link.

Codes are kept hashed in the database, expire after 10 minutes, and allow five
attempts.

### Password resets

**Forgot your password?** on the sign-in page emails the account a link that
works once, for 30 minutes. The page gives the same answer whether or not the
address has an account, only a hash of the link is stored, asking again
cancels the previous link, and setting the new password signs the account out
on every other device. `EMAIL_PROVIDER` decides how the email goes:

- `demo` — the link is shown on the page. Demonstrations only.
- `console` — written to the server log (the production default until SMTP is set).
- `smtp` — sent through your mail server (`SMTP_HOST`, `SMTP_PORT` — 587 with
  STARTTLS or 465, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`). Any provider
  that offers SMTP works: the department's mail server, Microsoft 365, Gmail
  Workspace, SendGrid, Amazon SES.

Set `PUBLIC_BASE_URL` to the address staff use, so the links point there.

For someone who cannot reach their email, an administrator presses **Reset
password** beside their account: they get a new one-time password, shown once
to the administrator, and must choose their own at the next sign-in.

### Automatic escalation of overdue reports (FR37)

A report no official has disposed of within 24 hours is escalated to the
station commander, and appears in the commander's escalations like any other.
Run the check every 15 minutes in one of two ways:

- **In the application:** `SCHEDULER_ENABLED=true` (`ESCALATION_INTERVAL_MINUTES`
  changes the interval). Simplest on a single server.
- **From the host's scheduler** (preferred where there is one):
  ```
  # Linux cron
  */15 * * * *  cd /srv/saps && .venv/bin/flask escalate-overdue
  ```
  ```
  :: Windows Task Scheduler, every 15 minutes, "Start in" the project folder
  .venv\Scripts\flask.exe escalate-overdue
  ```

Running it more often, from both places, or on several servers at once never
escalates a report twice.

### Go-live checklist

- [ ] `FLASK_CONFIG=production`, strong `SECRET_KEY`, `DEMO_MODE=false`
- [ ] An SMS gateway connected and `SMS_PROVIDER` set to it
- [ ] `EMAIL_PROVIDER=smtp` with the SMTP settings and `PUBLIC_BASE_URL`; a reset email tried once
- [ ] HTTPS in front of the application
- [ ] Database backups on, and a restore tried once
- [ ] `flask init-reference` and `flask create-admin` run; `flask seed` never run
- [ ] Stations and their service areas (`app/seed.py`, `STATIONS`) match the real precincts
- [ ] Overdue escalation running (`SCHEDULER_ENABLED=true` or a scheduled `flask escalate-overdue`)
- [ ] `flask verify-audit` added to a daily scheduled job

## Security in place

- Every rule enforced on the server; roles and stations checked on every change.
  A detective can only work dockets assigned to them.
- Pages carry only what their reader may see; complainants see only reports
  they proved are theirs (reference and name, ID number, or QR link plus ID
  number and a code to their phone).
- Passwords hashed (scrypt); new accounts must replace their one-time password;
  any password change or reset signs the account out everywhere else.
- Audit trail append-only with a SHA-256 hash chain; `flask verify-audit` and
  the audit screen report any break.
- Rate limits on sign-in, one-time codes, tracking and complainant actions.
- API writes must be JSON (blocks cross-site form posts); cookies `HttpOnly`,
  `SameSite=Lax`, and `Secure` in production; `X-Frame-Options`, `nosniff`,
  HSTS; pages are never cached.
- Uploaded files are never served as something the browser would run: only
  images and PDFs display inline, everything else downloads, under a sandbox policy.

## Routes

| Route | Page | Who |
|---|---|---|
| `/` | Report a crime | Public |
| `/index` | Landing page | Public |
| `/track` | Track a report, escalate, withdraw | Public (after proving it is theirs) |
| `/guide`, `/what-happens-next` | Guides | Public |
| `/login` | Staff sign-in, first-time password change, "Forgot your password?" | Staff |
| `/reset-password` | Where an emailed reset link lands | Staff |
| `/dashboard` | Redirects to the signed-in person's dashboard | Staff |
| `/dashboard-official`, `/official-capture`, `/official-cases` | Queue, assisted capture, station cases | Police Official |
| `/dashboard-detective` | Caseload and working file | Detective |
| `/dashboard-commander`, `/commander-cases`, `/commander-refusals`, `/commander-withdrawals` | Oversight | Station Commander |
| `/dashboard-admin`, `/admin-reference` | Accounts, reference data | Administrator |
| `/audit` | Audit ledger | Commander, Administrator |

Old file addresses (`/track.html?ref=...`) redirect to these, so QR codes
printed on earlier receipts still work.

## Requirements demonstrated

| Requirement | Where to see it |
|---|---|
| FR1, FR2 — multi-channel reporting, immediate reference number | `/`, `/official-capture` |
| FR3 — contact verification | One-time code before a report is accepted |
| FR4 — routing by incident location | Confirmation screen and audit trail |
| FR5, FR6 — no deletion, mandatory disposition | Official queue: only three exits |
| FR7 — docket only from a report | Opening a docket requires a report |
| FR8 — system-generated case number | Issued by the server, sequential, not editable |
| FR10 — refusal with mandatory reason | Refusal, then a commander's second signature |
| FR14–FR16 — auto-assignment by specialisation and caseload | `auto_assign()` in `app/services/dockets.py` |
| FR17 — commander override with reason | Reassign modal |
| FR31–FR34 — tracking and escalation | `/track`, commander respond modal |
| FR37 — automatic escalation of reports undisposed for 24 hours | `flask escalate-overdue` / the in-app scheduler; commander dashboard |
| FR38 — stale docket flagging | Commander dashboard |
| FR39 — reconciliation | Commander dashboard, reconciliation panel |
| FR42, FR43 — append-only hash-chained audit trail | `/audit` — no edit or delete control exists |
| FR47, FR48 — deactivate never delete, with guards | Admin dashboard |

In the demonstration data, the pending fraud and sexual-offence reports both
land in **awaiting assignment** when their dockets are opened — there is no
Commercial Crime detective at the station and the FCS detective is on leave —
which demonstrates FR16: the system will not assign an unqualified detective
to clear the queue. One report is left undisposed past 24 hours so the
reconciliation report and the system-raised escalation both show.

## Known limitations

- No SMS gateway is connected yet (see "One-time codes").
- Rate limits are counted per server process. With several processes behind a
  load balancer, move them to Redis or the proxy.
- Routing matches the incident address against each station's list of areas;
  there is no map or geocoding.
