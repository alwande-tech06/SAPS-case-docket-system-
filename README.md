# SAPS Case Docket Accountability System — Frontend

Front-end prototype for the SODM401 / SFEN301 group project, built with plain
HTML, CSS and JavaScript. All data is held in the browser's `localStorage` so
that every screen works and every workflow can be demonstrated before the Flask
backend exists.

## Running it

No build step and no server required. Open `index.html` in a browser.

To serve it locally instead (useful once you add the backend):

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Demonstration accounts

All accounts use the password `demo1234`.

| Email | Role | What they see |
|---|---|---|
| `official@saps.demo` | Police Official | Pending report queue, disposition, assisted capture |
| `detective@saps.demo` | Detective | Own caseload, evidence, arrests, handover |
| `commander@saps.demo` | Station Commander | Oversight, escalations, reconciliation, audit trail |
| `admin@saps.demo` | Administrator | User accounts, reference data, audit trail |

The login page has a **Reset demonstration data** button that clears everything
and reseeds. Use it before a live demo.

## File structure

```
index.html                  Public landing page
report.html                 Public reporting form (no account needed)
track.html                  Complainant tracking and escalation
login.html                  Staff sign-in with role routing

dashboard-official.html     Pending report queue
official-capture.html       Assisted capture on behalf of a complainant
official-cases.html         Cases registered at the station

dashboard-detective.html    Caseload and working file

dashboard-commander.html    Oversight dashboard
commander-cases.html        Full case register with per-case audit trail
commander-refusals.html     Every refusal and referral

dashboard-admin.html        User accounts
admin-reference.html        Stations, crime categories, specialisations

audit.html                  Full audit ledger (commander and admin only)

css/style.css               Single stylesheet
js/store.js                 Data layer — replace with API calls later
js/app.js                   Shared helpers, role guard, page chrome
js/report.js  track.js  official.js  detective.js  commander.js  admin.js
```

## Role-based access

`requireRole('detective')` at the top of each dashboard script redirects anyone
signed in under a different role to their own dashboard, and anyone not signed
in to the login page. Navigation tabs are generated per role from the `NAV`
object in `app.js`, so a role never sees a link it cannot use.

## Requirements demonstrated

| Requirement | Where to see it |
|---|---|
| FR1, FR2 — multi-channel reporting, immediate reference number | `report.html`, `official-capture.html` |
| FR3 — contact verification | OTP step in `report.html` |
| FR4 — routing by incident location | Confirmation screen and audit trail |
| FR5, FR6 — no deletion, mandatory disposition | Official queue: only three exits |
| FR7 — docket only from a report | `Store.openDocket` requires an intake id |
| FR8 — system-generated case number | Non-editable, sequential |
| FR10 — refusal with mandatory reason | Refusal modal, both fields required |
| FR14–FR16 — auto-assignment by specialisation and caseload | `autoAssign()` in `store.js` |
| FR17 — commander override with reason | Reassign modal |
| FR31–FR34 — tracking and escalation | `track.html`, commander respond modal |
| FR37, FR38 — automatic escalation and stale flagging | Seeded and shown on the commander dashboard |
| FR39 — reconciliation | Commander dashboard, reconciliation panel |
| FR42, FR43 — append-only hash-chained audit trail | `audit.html` — no edit or delete control exists |
| FR47, FR48 — deactivate never delete, with guards | Admin dashboard |

Two seeded cases deliberately land in **awaiting assignment**: a fraud case
(no Commercial Crime detective at the station) and a sexual offence case (the
FCS detective is on leave). Both demonstrate FR16 — the system will not assign
an unqualified detective just to clear the queue.

One report is deliberately left undisposed past 24 hours so the reconciliation
report and the system-raised escalation both fire during a demonstration.

## Swapping in the Flask backend

Every function in `store.js` corresponds to an endpoint. Replace the body of
each with a `fetch()` call and change nothing else:

```js
// before
submitReport(data) { const db = read(); /* ... */ return rec; }

// after
async submitReport(data) {
  const r = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return r.json();
}
```

Callers will need `await` added at that point. The suggested Flask blueprint
split matches the file structure: `auth`, `intake`, `dockets`, `investigation`,
`oversight`, `admin`.

Audit logging should move server-side into a SQLAlchemy `before_flush` event
listener so that it cannot be bypassed by a route that forgets to call it, and
the audit table should be granted `INSERT` and `SELECT` only at database level.

## Known limitations of the prototype

- Data lives in one browser. Signing in on another device shows the seed data.
- Passwords are stored in plain text in the seed, which a real deployment must
  never do. The backend will hash them.
- The OTP is displayed on screen instead of being sent by SMS.
- The hash chain uses a short non-cryptographic hash for demonstration. Use
  SHA-256 server-side.
