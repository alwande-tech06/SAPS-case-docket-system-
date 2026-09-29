/* ==========================================================================
   store.js — the pages' view of the data, and their way of changing it
   --------------------------------------------------------------------------
   The data lives on the server (PostgreSQL, app/models.py). When Flask
   renders a page it embeds everything that page's reader may see as
   window.SAPS_SNAPSHOT — a staff member's own station, a complainant's own
   reports, or just reference data for anyone else — so every read below is
   synchronous, exactly as the pages have always used it.

   Every change is a request to /api/actions/<name>, named after the function
   here. The server checks the role, the station and every rule again, writes
   the audit entry, and answers with the result and a fresh snapshot, which
   replaces the one held here. A result is the same {ok, error, code, ...}
   shape the pages already read; a refusal by the server itself (signed out,
   wrong station, offline) is shown as a message and returned in that shape.

   Table and field names mirror the ERD entities.
   ========================================================================== */

/* ---------------- what each category has to capture ----------------
   These exist so the official can test the elements of the crime instead of
   guessing at them, and so the complainant is asked once, at the point they
   still remember. Everything here is asked of the complainant in their own
   words; none of it is a legal finding.

   Sexual offences are deliberately the shortest list on this page. The full
   statement is taken in private by a trained officer, so the form asks only
   what is needed to route the case and get the person help now. */
const CATEGORY_FIELDS = {
  1: [ /* Theft */
    { key: 'what_taken', label: 'What was taken', type: 'textarea', required: true },
    { key: 'value', label: 'Approximate value (R)', type: 'text', required: true },
    { key: 'serials', label: 'Serial or IMEI numbers', type: 'text',
      hint: 'If you have them. This is what makes recovered property traceable back to you.' },
    { key: 'proof_of_ownership', label: 'Do you have proof of ownership?', type: 'select',
      options: ['Yes, I have it', 'I can obtain it', 'No'] },
    { key: 'insured', label: 'Is the item insured?', type: 'select', options: ['Yes', 'No', 'Not sure'] }
  ],
  2: [ /* Common assault */
    { key: 'how_it_happened', label: 'How the assault happened', type: 'textarea', required: true },
    { key: 'injuries', label: 'Injuries sustained', type: 'textarea', required: true },
    { key: 'medical_treatment', label: 'Did you receive medical treatment?', type: 'select',
      options: ['No', 'Yes — a doctor completed a J88', 'Yes — but no J88 yet', 'Not yet, but I intend to'],
      hint: 'A J88 is the medical form a doctor completes for a criminal case. If you saw a doctor, say so — it is important evidence.' },
    { key: 'relationship_to_suspect', label: 'Your relationship to the person who assaulted you', type: 'text',
      hint: 'Stranger, neighbour, colleague, family member, and so on.' }
  ],
  3: [ /* Sexual offence — minimal by design */
    { key: 'urgent_care', label: 'Do you need urgent medical care or a safe place right now?', type: 'select',
      options: ['Yes', 'No'], required: true },
    { key: 'when_recent', label: 'Did this happen in the last 72 hours?', type: 'select',
      options: ['Yes', 'No', 'I would rather not say'], required: true,
      hint: 'This is asked only so that time-sensitive medical evidence is not lost.' }
  ],
  4: [ /* Domestic violence */
    { key: 'immediate_danger', label: 'Are you in immediate danger?', type: 'select',
      options: ['Yes', 'No'], required: true },
    { key: 'relationship_to_suspect', label: 'Your relationship to the person', type: 'text', required: true,
      hint: 'Spouse, partner, former partner, parent, child, someone you share a home with.' },
    { key: 'protection_order', label: 'Is there a protection order?', type: 'select',
      options: ['No', 'Yes, one exists', 'I have applied but it is not granted yet'], required: true },
    { key: 'protection_order_number', label: 'Protection order number', type: 'text',
      hint: 'If one exists. A breach of a protection order is a separate offence.' },
    { key: 'children_present', label: 'Were children present?', type: 'select', options: ['Yes', 'No'] }
  ],
  5: [ /* Fraud */
    { key: 'misrepresentation', label: 'What were you told, or led to believe?', type: 'textarea', required: true,
      hint: 'The false statement or impression that caused you to part with money.' },
    { key: 'amount_lost', label: 'Amount lost (R)', type: 'text', required: true },
    { key: 'payment_method', label: 'How did you pay?', type: 'select',
      options: ['EFT / bank transfer', 'Cash', 'Card', 'Cryptocurrency', 'Mobile money', 'Other'] },
    { key: 'bank_references', label: 'Bank references', type: 'textarea',
      hint: 'Account numbers paid into, reference numbers, dates of payment.' },
    { key: 'documents_held', label: 'Contracts, messages or emails you still have', type: 'textarea',
      hint: 'Describe them here and upload what you can below.' }
  ],
  6: [ /* Vehicle theft */
    { key: 'registration', label: 'Registration number', type: 'text', required: true },
    { key: 'vin', label: 'VIN or chassis number', type: 'text' },
    { key: 'make_model', label: 'Make and model', type: 'text', required: true },
    { key: 'colour', label: 'Colour', type: 'text', required: true },
    { key: 'where_parked', label: 'Where it was parked', type: 'textarea', required: true },
    { key: 'who_had_keys', label: 'Who had the keys', type: 'text', required: true },
    { key: 'tracking_company', label: 'Tracking company, if fitted', type: 'text',
      hint: 'Contact them as well as reporting here — they can act immediately.' }
  ],
  7: [ /* Burglary */
    { key: 'point_of_entry', label: 'Point of entry', type: 'textarea', required: true,
      hint: 'Which door, window or opening, and whether it was forced.' },
    { key: 'what_taken', label: 'What was taken, with values and serial numbers', type: 'textarea', required: true },
    { key: 'insured', label: 'Are the premises or contents insured?', type: 'select', options: ['Yes', 'No', 'Not sure'] },
    { key: 'cctv_alarm', label: 'Is there CCTV or an alarm?', type: 'select',
      options: ['No', 'CCTV', 'Alarm', 'Both'],
      hint: 'If there is footage, do not let it be overwritten — most systems record over it within days.' }
  ],
  8: [ /* Malicious damage to property */
    { key: 'what_damaged', label: 'What was damaged', type: 'textarea', required: true },
    { key: 'repair_cost', label: 'Estimated cost to repair (R)', type: 'text', required: true },
    { key: 'proof_of_ownership', label: 'Do you have proof of ownership?', type: 'select',
      options: ['Yes, I have it', 'I can obtain it', 'No'] },
    { key: 'photos_taken', label: 'Have you photographed the damage?', type: 'select', options: ['Yes', 'Not yet'],
      hint: 'Photograph it before anything is repaired or cleared, and upload the photographs below.' }
  ],
  9: [ /* Robbery */
    { key: 'what_taken', label: 'What was taken', type: 'textarea', required: true },
    { key: 'violence_used', label: 'What was said or done to make you hand it over', type: 'textarea', required: true,
      hint: 'The force or the threat is what makes this robbery rather than theft.' },
    { key: 'weapon', label: 'Was a weapon involved?', type: 'select',
      options: ['No weapon', 'Firearm', 'Knife', 'Other weapon', 'I could not see'], required: true },
    { key: 'injuries', label: 'Injuries sustained', type: 'textarea' },
    { key: 'medical_treatment', label: 'Did you receive medical treatment?', type: 'select',
      options: ['No', 'Yes — a doctor completed a J88', 'Yes — but no J88 yet', 'Not yet, but I intend to'] },
    { key: 'serials', label: 'Serial or IMEI numbers of what was taken', type: 'text' }
  ],
  10: [ /* Crimen injuria or intimidation */
    { key: 'what_was_said', label: 'What was said or done', type: 'textarea', required: true },
    { key: 'channel', label: 'How did it reach you?', type: 'select',
      options: ['In person', 'Telephone call', 'SMS or WhatsApp', 'Social media', 'Email', 'Other'], required: true },
    { key: 'repeated', label: 'Has this happened more than once?', type: 'select', options: ['Yes', 'No'] },
    { key: 'evidence_saved', label: 'Have you kept the messages or recordings?', type: 'select',
      options: ['Yes', 'No', 'Some of them'],
      hint: 'Do not delete them. Screenshots with the sender and the date visible are best.' }
  ],
  11: []   /* Other — the free description is the whole of it */
};

/* ---------------- decision vocabularies ----------------
   These lists come from the activity diagrams, and the reasons they are short
   is the point of the system.

   A report may only be turned away at intake for two reasons. "Insufficient
   evidence" is a *closure* category — it can only be judged after an
   investigation, so offering it at intake lets a station refuse a case it has
   not looked at. "Withdrawn by complainant" is not the station's decision to
   take either: a withdrawal must come from the complainant, through the
   withdrawal flow, confirmed by them. Referral is not on this list at all —
   NI 3/2011 forbids sending a complainant to another station, so a
   wrong-jurisdiction report is registered here first and then transferred. */
const INTAKE_REFUSAL_REASONS = [
  'No offence disclosed — an element of the definition is missing',
  'Duplicate of an existing report (verified)'
];

/* For domestic violence and sexual offences, a verified duplicate is the only
   thing that may stop a docket being opened (Domestic Violence Act duties). */
const DUPLICATE_REASON = INTAKE_REFUSAL_REASONS[1];
const NO_OFFENCE_REASON = INTAKE_REFUSAL_REASONS[0];

/* Only the first two elements of an offence are testable at intake. The other
   two — unlawfulness and culpability — are defences for an accused to raise
   and the state to disprove, so they are not on this list. */
const MISSING_ELEMENTS = ['Legality', 'Conduct'];

/* A decision that closes a report has to be written down in a way another
   person can weigh. "nf" is not a reason, and it should never reach the
   commander — so the floor is enforced where the decision is recorded, not
   only in the screen that collects it. */
const MIN_REASON_LENGTH = 25;

/* Filing categories, each with the evidence it cannot be filed without. */
const FILING_CATEGORIES = [
  { key: 'undetected', label: 'Undetected / insufficient evidence', brought_forward_months: 12 },
  { key: 'pending_arrest', label: 'Filed pending arrest' },
  { key: 'pending_recovery', label: 'Filed pending recovery' },
  { key: 'withdrawn', label: 'Withdrawn by complainant' },
  { key: 'evidence_compromised', label: 'Evidence missing or compromised' },
  { key: 'sent_to_court', label: 'Sent to court' }
];

/* Diagram 3 — reassignment reasons are a fixed list so that "reassigned" is a
   category that can be counted and audited, not a free-text shrug. */
const REASSIGNMENT_REASONS = [
  'Extended sick leave',
  'Suspended or under discipline',
  'Caseload too high',
  'Needs more experience',
  'Urgency',
  'Other'
];

/* ---------------- blocking codes to guide anchors ----------------
   Every refusal this data layer returns carries a `code`. The dashboards turn
   that code into a "Why is this blocked?" link through this one table, so the
   link always points at the rule that actually failed rather than at whatever
   anchor someone typed next to the button. Adding a new guard means adding its
   code here once, not editing every screen that can hit it. */
const RULE_ANCHORS = {
  /* intake */
  invalid_grounds:        { role: 'official',  anchor: 'rule-invalid-grounds' },
  insufficient_at_intake: { role: 'official',  anchor: 'rule-insufficient-at-intake' },
  no_offence:             { role: 'official',  anchor: 'rule-no-offence' },
  duplicate:              { role: 'official',  anchor: 'rule-duplicate' },
  declined_charge:        { role: 'official',  anchor: 'rule-declined-charge' },
  protected_categories:   { role: 'official',  anchor: 'rule-protected-categories' },
  intake_preconditions:   { role: 'official',  anchor: 'rule-intake-preconditions' },
  transfer:               { role: 'official',  anchor: 'rule-transfer' },
  cosign:                 { role: 'commander', anchor: 'rule-cosign' },

  /* investigation and closure */
  exhibit:                { role: 'detective', anchor: 'rule-exhibit' },
  witnesses:              { role: 'detective', anchor: 'rule-witnesses' },
  closure_status:         { role: 'detective', anchor: 'rule-closure-status' },
  closure_diary:          { role: 'detective', anchor: 'rule-closure-diary' },
  closure_evidence:       { role: 'detective', anchor: 'rule-closure-evidence' },
  filing_categories:      { role: 'detective', anchor: 'rule-filing-categories' },
  withdrawal:             { role: 'detective', anchor: 'rule-withdrawal' },
  reopen:                 { role: 'detective', anchor: 'rule-reopen' },
  closure_request:        { role: 'detective', anchor: 'rule-closure-request' },

  /* command */
  approve_closure:        { role: 'commander', anchor: 'rule-approve-closure' },
  separation:             { role: 'commander', anchor: 'rule-separation' },
  allocation:             { role: 'commander', anchor: 'rule-allocation' },
  reassign:               { role: 'commander', anchor: 'rule-reassign' },
  escalations:            { role: 'commander', anchor: 'rule-escalations' }
};

const REOPEN_TRIGGERS = {
  arrest: 'A circulated suspect was arrested',
  recovery: 'Circulated property was recovered',
  forensic: 'A DNA or fingerprint match identified a perpetrator',
  review: 'Brought-forward review'
};

/* ---------------- the snapshot ---------------- */

const TABLES = ['stations', 'specialisations', 'categories', 'users', 'complainants',
  'intakes', 'dockets', 'refusals', 'escalations', 'assignments', 'status_history',
  'notes', 'evidence', 'custody', 'arrests', 'handovers', 'audit_log',
  'complainant_evidence', 'withdrawals', 'notifications', 'closures', 'transfers',
  'witnesses', 'forensics'];

function emptySnapshot() {
  const s = { me: null, demo_mode: false, must_change_password: false,
              audit_chain: { ok: true, entries: 0 } };
  TABLES.forEach(t => { s[t] = []; });
  return s;
}

let snapshot = (typeof window !== 'undefined' && window.SAPS_SNAPSHOT) || emptySnapshot();

function read() { return snapshot; }

/* ---------------- talking to the server ---------------- */

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON: a proxy error page or similar */ }
  if (data && data.snapshot) snapshot = data.snapshot;
  return { status: r.status, data: data || { ok: false, error: 'The server could not complete that request.' } };
}

/* One change. `failed` is what the page expects back when it did not happen
   (null for the functions that returned null on a miss); the reason is shown
   either way, so nothing fails silently. */
async function act(name, args, failed) {
  let res;
  try { res = await api('POST', '/actions/' + name, args); }
  catch (e) { res = { status: 0, data: { ok: false, error: 'The server could not be reached. Check your connection and try again.' } }; }
  if (res.status === 401) {
    location.replace('/login');
    return new Promise(() => {});   /* never settles: the page is leaving */
  }
  if (!res.data.ok) {
    if (typeof toast === 'function') toast(res.data.error, 'alert');
    return failed !== undefined ? failed : { ok: false, error: res.data.error, code: res.data.code };
  }
  return res.data.result;
}

/* ==========================================================================
   Public API — grouped the way the Flask blueprints are
   ========================================================================== */

const Store = {

  /* ----- meta ----- */
  all() { return read(); },

  /* The demonstration features (seeded accounts, this reset, one-time codes
     shown on screen) exist only when the server runs with DEMO_MODE on. */
  demoMode() { return !!read().demo_mode; },
  async reset() { await api('POST', '/demo/reset', {}); },

  /* Data is kept on the server now, so the browser's own storage no longer
     matters. Kept so older pages asking the question get an honest answer. */
  storageWorks() { return true; },

  /* Fetches the current snapshot, for a page that has been open a while. */
  async refresh() { await api('GET', '/snapshot'); },

  /* ----- auth ----- */
  async login(email, password) {
    try {
      const res = await api('POST', '/auth/login', { email, password });
      return res.data;
    } catch (e) {
      return { ok: false, error: 'The server could not be reached. Try again in a moment.' };
    }
  },

  async logout() {
    try { await api('POST', '/auth/logout', {}); } catch (e) { /* signed out locally either way */ }
    snapshot = emptySnapshot();
  },

  session() { return read().me; },
  mustChangePassword() { return !!read().must_change_password; },

  async changePassword(current, next) {
    try {
      const res = await api('POST', '/auth/password', { current, new: next });
      return res.data;
    } catch (e) {
      return { ok: false, error: 'The server could not be reached. Try again in a moment.' };
    }
  },

  /* "Forgot your password?": always answers ok, account or not. demo_link is
     set only on a demonstration system, which sends no email. */
  async requestPasswordReset(email) {
    try { return (await api('POST', '/auth/reset-request', { email })).data; }
    catch (e) { return { ok: false, error: 'The server could not be reached. Try again in a moment.' }; }
  },

  async completePasswordReset(token, next) {
    try { return (await api('POST', '/auth/reset', { token, new: next })).data; }
    catch (e) { return { ok: false, error: 'The server could not be reached. Try again in a moment.' }; }
  },

  resetUserPassword(id, actor) {
    return act('resetUserPassword', { id });
  },

  users() { return read().users; },
  stations() { return read().stations; },
  categories() { return read().categories; },
  specialisations() { return read().specialisations; },

  /* ----- reporting (public, no account) ----- */
  /* Step one: a code to the phone number given. Resolves to
     { ok, demo_code } — demo_code only when the server is in demonstration
     mode, where there is no SMS and the page shows the code instead. */
  async sendReportOtp(person) {
    try { return (await api('POST', '/otp/report', person)).data; }
    catch (e) { return { ok: false, error: 'The server could not be reached. Try again in a moment.' }; }
  },

  /* Filed on the server, which numbers the report, routes it by location and
     matches the complainant. data.otp is the code from sendReportOtp (not
     needed for an official's assisted capture). Throws with a message the
     page can show. */
  async submitReport(data) {
    const res = await api('POST', '/intakes', data);
    if (!res.data.ok) throw new Error(res.data.error);
    return read().intakes.find(i => i.id === res.data.intake.id) || res.data.intake;
  },

  /* ----- tracking ----- */
  /* A complainant proves a report is theirs to the server; the answer brings
     those reports into this page's snapshot, and the lookups below read them.
     A miss leaves the snapshot as it was. */
  async fetchTrack(query) {
    try { await api('POST', '/track', query); } catch (e) { /* offline: the lookup finds nothing */ }
  },

  /* A scanned link, in steps: { } for which ID to ask for; { id_number } to
     have a code sent to the phone on the report; { otp } to open it. */
  async fetchTrackLink(reference, token, extra) {
    try { return (await api('POST', '/track/link', Object.assign({ reference, token }, extra || {}))).data; }
    catch (e) { return { ok: false, error: 'The server could not be reached. Try again in a moment.' }; }
  },

  intakes(filter = {}) {
    const db = read();
    return db.intakes.filter(i =>
      (!filter.station_id || i.station_id === filter.station_id) &&
      (!filter.disposition || i.disposition === filter.disposition));
  },

  intakeByNumber(num) {
    const db = read();
    return db.intakes.find(i => i.intake_number.toUpperCase() === String(num).toUpperCase().trim());
  },

  track(reference, fullName) {
    const db = read();
    const ref = String(reference).toUpperCase().trim();
    let intake = db.intakes.find(i => i.intake_number.toUpperCase() === ref);
    let docket = db.dockets.find(d => d.cas_number.toUpperCase() === ref);
    if (docket && !intake) intake = db.intakes.find(i => i.id === docket.intake_id);
    if (!intake) return { ok: false };

    const comp = db.complainants.find(c => c.id === intake.complainant_id);
    const nameOk = !fullName || (comp && normalizeName(comp.name) === normalizeName(fullName));
    if (!nameOk) return { ok: false };

    if (!docket) docket = db.dockets.find(d => d.intake_id === intake.id);
    const refusal = db.refusals.find(r => r.intake_id === intake.id);
    const history = docket ? db.status_history.filter(h => h.docket_id === docket.id) : [];
    const escalations = db.escalations.filter(e =>
      (docket && e.docket_id === docket.id) || e.intake_id === intake.id);

    return { ok: true, intake, docket, refusal, history, escalations, complainant: comp };
  },

  /* A scanned link identifies a report; it does not open it. This says only
     whether the link is good, and who must be verified — never case content. */
  trackLinkCheck(reference, token) {
    const db = read();
    const ref = String(reference || '').toUpperCase().trim();
    const t = String(token || '').trim();
    if (!ref || !t) return { ok: false };

    let intake = db.intakes.find(i => i.intake_number.toUpperCase() === ref);
    if (!intake) {
      const docket = db.dockets.find(d => d.cas_number.toUpperCase() === ref);
      if (docket) intake = db.intakes.find(i => i.id === docket.intake_id);
    }
    if (!intake || !intake.track_token || intake.track_token !== t) return { ok: false };

    const comp = db.complainants.find(c => c.id === intake.complainant_id);
    return { ok: true, intake_id: intake.id,
      /* enough to tell someone which number to enter, and nothing more */
      id_hint: comp && comp.id_number ? comp.id_number.slice(-4) : null,
      has_id: !!(comp && comp.id_number) };
  },

  /* The second half: the ID number on the report, then an OTP. Only when both
     are satisfied does the caller get the report itself. */
  verifyTrackIdNumber(intakeId, idNumber) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake) return { ok: false };
    const comp = db.complainants.find(c => c.id === intake.complainant_id);
    const given = String(idNumber || '').replace(/\D/g, '');
    if (!comp || !comp.id_number || comp.id_number !== given) return { ok: false };
    return { ok: true, contact: comp.contact, name: comp.name };
  },

  trackByComplainantNumber(number, fullName) {
    const db = read();
    const num = String(number).toUpperCase().trim();
    return complainantReports(db,
      db.complainants.find(c => (c.complainant_number || '').toUpperCase() === num), fullName);
  },

  trackByIdNumber(idNumber, fullName) {
    const db = read();
    const id = String(idNumber).replace(/\D/g, '');
    return complainantReports(db, db.complainants.find(c => c.id_number === id), fullName);
  },

  /* What a report still needs before a docket can be opened on it. Right now
     that is classification: a report filed under "Other" carries no category,
     so it has no priority and no specialisation to route by until an official
     names the crime. */
  classificationNeeded(intakeId) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake) return false;
    const cat = db.categories.find(c => c.id === intake.category_id);
    return !!(cat && cat.requires_classification);
  },

  categoryFields(categoryId) {
    return (CATEGORY_FIELDS[Number(categoryId)] || []).map(f => Object.assign({}, f));
  },

  /* Where the guide explains a given blocking code. Returns null for a code
     with no rule behind it, so a caller can leave the link out rather than
     sending someone to a page that will not answer them. */
  ruleFor(code) {
    const r = RULE_ANCHORS[code];
    return r ? { role: r.role, anchor: r.anchor, href: `/guide?role=${r.role}#${r.anchor}` } : null;
  },

  openDocket(intakeId, actor, options = {}) {
    return act('openDocket', { intakeId, options }, null);
  },

  /* The reasons a docket may be refused, for this report. Returns the short
     list, and for a protected category only the verified-duplicate reason. */
  missingElements() { return MISSING_ELEMENTS.slice(); },

  /* Whether a reference given as a duplicate actually resolves to something on
     the system. A case number nobody can find is not a verified duplicate. */
  referenceResolves(reference) {
    const ref = String(reference || '').toUpperCase().trim();
    if (!ref) return false;
    const db = read();
    return db.intakes.some(i => i.intake_number.toUpperCase() === ref) ||
           db.dockets.some(d => d.cas_number.toUpperCase() === ref);
  },

  refusalReasonsFor(intakeId) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    const cat = intake && db.categories.find(c => c.id === intake.category_id);
    if (cat && cat.protected_from_withdrawal) return [DUPLICATE_REASON];
    return INTAKE_REFUSAL_REASONS.slice();
  },

  /* A refusal is a request, not a decision. It takes effect only when a second
     person signs it off, and that person may not be the official who raised it
     (NI 3/2011 s1(a) — the decision not to open a docket is co-signed). Until
     then the report stays pending and keeps counting towards the 24-hour
     reconciliation, so a refusal cannot be used to make a report disappear. */
  recordRefusal(intakeId, actor, payload) {
    return act('recordRefusal', { intakeId, payload });
  },

  /* The second signature. Refusing to co-sign is not a neutral act: the
     diagram's "no" branch means the docket must be opened, so rejecting the
     refusal opens it here rather than dropping the report back into limbo. */
  cosignRefusal(refusalId, actor, agree, note, options = {}) {
    return act('cosignRefusal', { refusalId, agree, note, options });
  },

  pendingRefusals(stationId) {
    const db = read();
    return db.refusals.filter(r => r.status === 'pending_cosign' &&
      (!stationId || r.station_id === stationId));
  },

  /* Wrong jurisdiction is not a reason to turn someone away. The docket is
     opened at the station that received the report — so a case number exists
     and the complainant holds it — and only then does the docket move
     (NI 3/2011: a complainant may not be referred to another station). */
  registerAndTransfer(intakeId, actor, payload) {
    return act('registerAndTransfer', { intakeId, payload });
  },

  dockets(filter = {}) {
    const db = read();
    return db.dockets.filter(d =>
      (!filter.station_id || d.station_id === filter.station_id) &&
      (!filter.detective_id || d.detective_id === filter.detective_id));
  },

  docket(id) { return read().dockets.find(d => d.id === Number(id)); },

  updateStatus(docketId, newStatus, actor, notes) {
    return act('updateStatus', { docketId, newStatus, notes }, null);
  },

  filingCategories() { return FILING_CATEGORIES.map(c => Object.assign({}, c)); },

  /* What a given category still needs on this docket. Returns null when the
     category may be used, so the UI can grey out what is not available yet
     rather than letting a detective find out after typing everything. */
  closureBlocker(docketId, categoryKey, payload = {}) {
    const db = read();
    const block = (code, message) => ({ code, message });
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return block('closure_request', 'Case not found.');
    if (d.current_status === 'closed') return block('closure_status', 'This case is already closed.');
    if (d.current_status !== 'under_investigation') {
      return block('closure_status', 'A docket cannot be closed before it has been investigated.');
    }
    const intake = db.intakes.find(i => i.id === d.intake_id);

    switch (categoryKey) {
      case 'undetected': {
        const diary = db.notes.filter(n => n.docket_id === d.id).length;
        const exhibits = db.evidence.filter(e => e.docket_id === d.id).length;
        if (!diary || !exhibits) {
          return block('closure_evidence',
            'Undetected requires investigation diary entries and at least one evidence item on the docket.');
        }
        return null;
      }
      case 'pending_arrest':
        return (payload.warrant_reference || '').trim() ? null
          : block('filing_categories', 'A circulated warrant of arrest reference is required.');
      case 'pending_recovery':
        return (payload.circulation_reference || '').trim() ? null
          : block('filing_categories', 'A property circulation reference is required.');
      case 'withdrawn': {
        const approved = db.withdrawals.some(w => w.intake_id === (intake && intake.id) &&
          w.status === 'decided' && w.decision === 'approved');
        return approved ? null : block('withdrawal',
          "SAPS may not withdraw a case on the complainant's behalf. The complainant must request withdrawal and the commander must approve it first.");
      }
      case 'evidence_compromised': {
        if (!(payload.discrepancy_report || '').trim()) {
          return block('filing_categories', 'A discrepancy report is required.');
        }
        const anyCustody = db.evidence.filter(e => e.docket_id === d.id)
          .some(e => db.custody.some(c => c.evidence_id === e.id));
        return anyCustody ? null : block('exhibit',
          'A custody log entry is required before evidence can be reported compromised.');
      }
      case 'sent_to_court':
        return (payload.prosecutor_reference || '').trim() ? null
          : block('filing_categories',
            'The prosecutor reference is required. The decision to prosecute belongs to the NPA.');
      default:
        return block('filing_categories', 'Choose a filing category.');
    }
  },

  requestClosure(docketId, actor, payload) {
    return act('requestClosure', { docketId, payload });
  },

  closureChecklist(closureId, approverId) {
    const db = read();
    const c = db.closures.find(x => x.id === Number(closureId));
    if (!c) return null;
    const d = db.dockets.find(x => x.id === c.docket_id);
    const intake = db.intakes.find(i => i.id === d.intake_id);

    const items = [];

    /* 1. every diary instruction executed or explained */
    const instructions = db.notes.filter(n => n.docket_id === d.id && n.note_type === 'instruction');
    const openInstructions = instructions.filter(n => n.status === 'open');
    items.push({
      key: 'instructions',
      code: 'closure_diary',
      label: 'Every instruction in the investigation diary was executed or explained',
      ok: openInstructions.length === 0,
      detail: instructions.length
        ? `${instructions.length} instruction(s); ${openInstructions.length} still open`
        : 'No instructions were written in the diary',
      missing: openInstructions.map(n => n.note_text),
      evidence: instructions.map(n => ({
        text: n.note_text,
        state: n.status,
        answer: n.response,
        by: n.responded_by ? Store.userName(n.responded_by) : null
      }))
    });

    /* 2. statements from the complainant and every identified witness */
    const witnesses = db.witnesses.filter(w => w.docket_id === d.id);
    const witnessGaps = witnesses.filter(w => !w.statement_text && !w.no_statement_reason);
    const complainantStatement = !!(intake && (intake.incident_description || '').trim());
    items.push({
      key: 'statements',
      code: 'closure_evidence',
      label: 'Statements from the complainant and all identified witnesses are in the docket',
      ok: complainantStatement && witnessGaps.length === 0,
      detail: `Complainant statement ${complainantStatement ? 'on file' : 'missing'}; ` +
        `${witnesses.length} witness(es) identified, ${witnessGaps.length} with neither a statement nor a reason`,
      missing: (complainantStatement ? [] : ['The complainant\'s statement is not in the docket'])
        .concat(witnessGaps.map(w => `No statement and no reason recorded for ${w.name}`)),
      evidence: witnesses.map(w => ({
        text: w.name,
        state: w.statement_text ? 'statement taken' : (w.no_statement_reason ? 'explained' : 'outstanding'),
        answer: w.statement_text || w.no_statement_reason
      }))
    });

    /* 3. forensic submissions have results, or are accounted for */
    const forensics = db.forensics.filter(f => f.docket_id === d.id);
    const forensicGaps = forensics.filter(f => !f.result && !f.accounted_for_reason);
    items.push({
      key: 'forensics',
      code: 'closure_evidence',
      label: 'Forensic and other evidence was submitted, and results are back or accounted for',
      ok: forensicGaps.length === 0,
      detail: forensics.length
        ? `${forensics.length} submission(s); ${forensicGaps.length} with no result and no explanation`
        : 'Nothing was submitted for forensic analysis',
      missing: forensicGaps.map(f => `${f.description} (${f.lab_reference}) — no result, not accounted for`),
      evidence: forensics.map(f => ({
        text: `${f.description} (${f.lab_reference})`,
        state: f.result ? 'result received' : (f.accounted_for_reason ? 'accounted for' : 'outstanding'),
        answer: f.result || f.accounted_for_reason
      }))
    });

    /* 4. exhibits registered, chain of custody intact */
    const exhibits = db.evidence.filter(e => e.docket_id === d.id);
    const exhibitGaps = [];
    exhibits.forEach(e => {
      if (!e.saps13_number) exhibitGaps.push(`${e.exhibit_number} has no SAPS 13 register number`);
      if (!db.custody.some(cu => cu.evidence_id === e.id)) exhibitGaps.push(`${e.exhibit_number} has no custody entry`);
      if (!e.current_holder_id) exhibitGaps.push(`${e.exhibit_number} is held by nobody`);
    });
    items.push({
      key: 'exhibits',
      code: 'exhibit',
      label: 'Exhibits are properly registered, with the chain of custody intact',
      ok: exhibitGaps.length === 0,
      detail: exhibits.length ? `${exhibits.length} exhibit(s) on the docket` : 'No exhibits on the docket',
      missing: exhibitGaps,
      evidence: exhibits.map(e => ({
        text: `${e.exhibit_number} — ${e.description}`,
        state: e.saps13_number ? `SAPS 13: ${e.saps13_number}` : 'no register number',
        answer: `Held by ${Store.userName(e.current_holder_id)}, ${db.custody.filter(cu => cu.evidence_id === e.id).length} custody entr(ies)`
      }))
    });

    /* 5. circulation where a suspect or property is still outstanding */
    const suspectIdentified = db.arrests.some(a => a.docket_id === d.id) ||
      exhibits.some(e => e.suspect_id_number);
    const needsCirculation = c.category === 'pending_arrest' || c.category === 'pending_recovery' ||
      (c.category === 'undetected' && suspectIdentified);
    const circulationRef = c.warrant_reference || c.circulation_reference;
    items.push({
      key: 'circulation',
      code: 'closure_evidence',
      label: 'Circulation was done where a suspect or property is outstanding',
      ok: !needsCirculation || !!circulationRef,
      detail: needsCirculation
        ? (circulationRef ? `Circulated under ${circulationRef}` : 'A circulation reference is required and none is recorded')
        : 'No suspect or property is outstanding on this filing',
      missing: needsCirculation && !circulationRef
        ? ['A suspect or property is outstanding but no circulation reference is recorded']
        : []
    });

    /* 6. the requesting detective is not the approver */
    items.push({
      key: 'separation',
      code: 'separation',
      label: 'The requesting detective is not the approver',
      ok: approverId == null || c.requested_by !== approverId,
      detail: `Requested by ${Store.userName(c.requested_by)}`,
      missing: approverId != null && c.requested_by === approverId
        ? ['You requested this closure, so you cannot approve it'] : []
    });

    /* 7. the complainant is told — a consequence of approving, not a precondition */
    items.push({
      key: 'notify',
      code: 'approve_closure',
      label: 'The complainant is notified of the outcome and the reason (Victims\' Charter)',
      ok: true,
      informational: true,
      detail: 'Sent automatically on approval, with the filing category and your reason',
      missing: []
    });

    const blocking = items.filter(i => !i.informational && !i.ok);
    return { closure: c, docket: d, items, blocking, canApprove: blocking.length === 0 };
  },

  decideClosure(closureId, actor, decision, reason) {
    return act('decideClosure', { closureId, decision, reason });
  },

  closures(filter = {}) {
    const db = read();
    return db.closures.filter(c =>
      (!filter.status || c.status === filter.status) &&
      (!filter.docket_id || c.docket_id === Number(filter.docket_id)))
      .slice().reverse();
  },

  reopenDocket(docketId, actor, payload) {
    return act('reopenDocket', { docketId, payload });
  },

  /* Diagram 6 puts the complainant in the same lane as the detective for a
     manual reopening: they may ask, on the same condition — something new. */
  requestReopenByComplainant(docketId, newEvidence) {
    return act('requestReopenByComplainant', { docketId, newEvidence });
  },

  /* The review happened and nothing new came of it: the docket stays filed,
     the review is on the record, and the clock is set for another 12 months
     rather than the item sitting on the dashboard forever. */
  noteBroughtForwardReview(docketId, actor) {
    return act('noteBroughtForwardReview', { docketId });
  },

  /* Filed dockets whose 12-month review date has arrived — the commander's
     brought-forward queue. */
  broughtForwardDue(stationId) {
    const db = read();
    const now = Date.now();
    return db.dockets.filter(d => d.current_status === 'closed' && d.brought_forward_at &&
      new Date(d.brought_forward_at).getTime() <= now &&
      (!stationId || d.station_id === stationId));
  },

  addNote(docketId, actor, text) {
    return act('addNote', { docketId, text }, false);
  },

  notes(docketId) { return read().notes.filter(n => n.docket_id === Number(docketId)); },

  addInstruction(docketId, actor, text) {
    return act('addInstruction', { docketId, text });
  },

  answerInstruction(noteId, actor, outcome, response) {
    return act('answerInstruction', { noteId, outcome, response });
  },

  instructions(docketId) {
    return read().notes.filter(n => n.docket_id === Number(docketId) && n.note_type === 'instruction');
  },

  addWitness(docketId, actor, payload) {
    return act('addWitness', { docketId, payload });
  },

  recordWitnessStatement(witnessId, actor, statementText, noStatementReason) {
    return act('recordWitnessStatement', { witnessId, statementText, noStatementReason });
  },

  witnesses(docketId) { return read().witnesses.filter(w => w.docket_id === Number(docketId)); },

  submitForensic(docketId, actor, payload) {
    return act('submitForensic', { docketId, payload });
  },

  recordForensicResult(forensicId, actor, result, accountedForReason) {
    return act('recordForensicResult', { forensicId, result, accountedForReason });
  },

  forensics(docketId) { return read().forensics.filter(f => f.docket_id === Number(docketId)); },

  statusHistory(docketId) { return read().status_history.filter(h => h.docket_id === Number(docketId)); },

  addEvidence(docketId, actor, payload) {
    return act('addEvidence', { docketId, payload });
  },

  transferEvidence(evidenceId, actor, toUserId, purpose) {
    return act('transferEvidence', { evidenceId, toUserId, purpose }, null);
  },

  evidence(docketId) { return read().evidence.filter(e => e.docket_id === Number(docketId)); },

  custody(evidenceId) { return read().custody.filter(c => c.evidence_id === Number(evidenceId)); },

  priorityFor(categoryId) {
    const db = read();
    const cat = db.categories.find(c => c.id === Number(categoryId));
    return cat ? cat.default_priority : 'Medium';
  },

  addComplainantEvidence(intakeId, files, description) {
    return act('addComplainantEvidence', { intakeId, files, description }, []);
  },

  complainantEvidence(intakeId) {
    return read().complainant_evidence.filter(e => e.intake_id === Number(intakeId));
  },

  reviewComplainantEvidence(id, actor, decision, note, saps13) {
    return act('reviewComplainantEvidence', { id, decision, note, saps13 });
  },

  withdrawalEligibility(intakeId) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake) return { allowed: false, reason: 'Report not found.' };
    const cat = db.categories.find(c => c.id === intake.category_id);
    const protectedCategory = !!(cat && cat.protected_from_withdrawal);
    const docket = intake.docket_id ? db.dockets.find(d => d.id === intake.docket_id) : null;

    const pending = db.withdrawals.find(w => w.intake_id === intake.id && w.status === 'pending');
    if (pending) return { allowed: false, pending: true, protectedCategory,
      reason: 'A withdrawal request for this case is already awaiting a decision.' };

    if (docket) {
      if (docket.current_status === 'closed') {
        return { allowed: false, protectedCategory, reason: 'This case is already closed.' };
      }
      if (docket.current_status === 'sent_to_prosecutor') {
        return { allowed: false, protectedCategory, reason: 'This case has already been handed to the prosecutor and can no longer be withdrawn.' };
      }
      if (db.arrests.some(a => a.docket_id === docket.id)) {
        return { allowed: false, protectedCategory, reason: 'An arrest has already been made on this case, so it can no longer be withdrawn.' };
      }
    } else if (intake.disposition !== 'pending') {
      return { allowed: false, protectedCategory, reason: 'This report has already been disposed of.' };
    }

    return { allowed: true, protectedCategory };
  },

  requestWithdrawal(intakeId, payload) {
    return act('requestWithdrawal', { intakeId, payload });
  },

  decideWithdrawal(id, actor, decision, reason) {
    return act('decideWithdrawal', { id, decision, reason });
  },

  withdrawals(filter = {}) {
    const db = read();
    return db.withdrawals.filter(w => !filter.status || w.status === filter.status)
      .slice().reverse();
  },

  addArrest(docketId, actor, payload) {
    return act('addArrest', { docketId, payload }, false);
  },

  arrests(docketId) { return read().arrests.filter(a => a.docket_id === Number(docketId)); },

  handover(docketId, actor, payload) {
    return act('handover', { docketId, payload }, false);
  },

  handovers(docketId) { return read().handovers.filter(h => h.docket_id === Number(docketId)); },

  raiseEscalation(payload) {
    const d = payload.docket_id ? Store.docket(payload.docket_id) : null;
    return act('raiseEscalation', { intakeId: payload.intake_id || (d && d.intake_id), payload }, null);
  },

  respondEscalation(id, actor, outcome, response) {
    return act('respondEscalation', { id, outcome, response });
  },

  escalations(filter = {}) {
    const db = read();
    return db.escalations.filter(e => !filter.status || e.status === filter.status);
  },

  reassignmentReasons() { return REASSIGNMENT_REASONS.slice(); },

  /* Diagram 3. Three guards, in the order the diagram puts them: the role,
     a reason off the fixed list, and separation of duties — a commander who
     approved a closure on this docket may not also move it to a different
     detective, because that is the same person shaping the same case twice.
     That request goes to the cluster commander instead. */
  reassign(docketId, detectiveId, actor, reason, detail) {
    return act('reassign', { docketId, detectiveId, reason, detail });
  },

  assignments(docketId) { return read().assignments.filter(a => a.docket_id === Number(docketId)); },

  /* Diagram 3 — the pattern the oversight report is meant to catch: dockets
     repeatedly taken away from one detective, or one commander doing most of
     the moving. Neither is proof of anything; both are worth a look. */
  reassignmentPatterns(stationId, threshold = 3) {
    const db = read();
    const inStation = id => {
      const d = db.dockets.find(x => x.id === id);
      return d && (!stationId || d.station_id === stationId);
    };
    const moves = db.assignments.filter(a => a.assignment_method === 'commander_override' &&
      inStation(a.docket_id));

    const awayFrom = {}, byActor = {};
    moves.forEach(a => {
      if (a.previous_detective_id) awayFrom[a.previous_detective_id] = (awayFrom[a.previous_detective_id] || 0) + 1;
      if (a.assigned_by) byActor[a.assigned_by] = (byActor[a.assigned_by] || 0) + 1;
    });

    const flags = [];
    Object.entries(awayFrom).forEach(([id, n]) => {
      if (n >= threshold) flags.push({ kind: 'away_from_detective', user_id: Number(id), count: n,
        text: `${n} dockets reassigned away from ${Store.userName(id)}` });
    });
    Object.entries(byActor).forEach(([id, n]) => {
      if (n >= threshold) flags.push({ kind: 'by_actor', user_id: Number(id), count: n,
        text: `${n} reassignments made by ${Store.userName(id)}` });
    });
    return flags;
  },

  /* Diagram 2 — NI 3/2011 s1.4.10. A registered docket that has not reached a
     detective within 24 hours is the station commander's problem, not something
     that quietly waits. */
  overdueDetectiveHandover(stationId, hours = 24) {
    const db = read();
    const cut = Date.now() - hours * 36e5;
    return db.dockets.filter(d => !d.detective_id &&
      d.current_status !== 'closed' &&
      new Date(d.registered_at).getTime() < cut &&
      (!stationId || d.station_id === stationId));
  },

  saveUser(payload, actor) {
    return act('saveUser', { payload });
  },

  deactivateUser(id, actor) {
    return act('deactivateUser', { id });
  },

  audit(filter = {}) {
    const db = read();
    return db.audit_log.filter(a =>
      (!filter.case_id || a.case_id === Number(filter.case_id)) &&
      (!filter.user_id || a.user_id === Number(filter.user_id)) &&
      (!filter.action_type || a.action_type === filter.action_type))
      .slice().reverse();
  },

  /* Checked by the server (SHA-256 over every entry) when the page was built. */
  verifyChain() { return read().audit_chain; },

  reconciliation(stationId) {
    const db = read();
    const list = db.intakes.filter(i => !stationId || i.station_id === stationId);
    const undisposed = list.filter(i => i.disposition === 'pending');
    return {
      received: list.length,
      docket_opened: list.filter(i => i.disposition === 'docket_opened').length,
      refused: list.filter(i => i.disposition === 'refused').length,
      referred: list.filter(i => i.disposition === 'referred').length,
      undisposed
    };
  },

  /* Diagram 4, NI 3/2011 s1.4.3 — dormancy is measured by the investigation
     diary, not by any activity at all. A docket someone opened, read and
     closed again has "activity" but no investigation; an entry in the diary is
     the only thing that shows work was done. */
  dormantDockets(stationId, days = 30) {
    const db = read();
    const cut = Date.now() - days * 864e5;
    return db.dockets.filter(d => {
      if (d.current_status === 'closed') return false;
      if (stationId && d.station_id !== stationId) return false;
      const entries = db.notes.filter(n => n.docket_id === d.id);
      const last = entries.length
        ? Math.max(...entries.map(n => new Date(n.created_at).getTime()))
        : new Date(d.registered_at).getTime();
      return last < cut;
    });
  },

  /* When a docket last had a diary entry, or null if it never has. */
  lastDiaryEntry(docketId) {
    const entries = read().notes.filter(n => n.docket_id === Number(docketId));
    if (!entries.length) return null;
    return entries.map(n => n.created_at).sort().slice(-1)[0];
  },

  staleDockets(stationId, days = 30) {
    const db = read();
    const cut = Date.now() - days * 864e5;
    return db.dockets.filter(d =>
      (!stationId || d.station_id === stationId) &&
      d.current_status !== 'closed' &&
      new Date(d.last_activity_at).getTime() < cut);
  },

  /* Decisions a commander declined to sign, counted per official. A single
     reversal is an ordinary disagreement — two people looked at the same facts
     and read them differently, which is exactly what the second signature is
     for. A run of them by one official is a different thing, and it belongs in
     front of the commander rather than buried in the audit log. */
  reversalsByOfficer(stationId, threshold = 2) {
    const db = read();
    const counts = {};
    db.refusals
      .filter(r => r.status === 'rejected' && (!stationId || r.station_id === stationId))
      .forEach(r => {
        const id = r.reversed_official_id || r.officer_id;
        counts[id] = (counts[id] || 0) + 1;
      });
    return Object.entries(counts)
      .map(([id, count]) => ({
        user_id: Number(id),
        name: Store.userName(id),
        count,
        flagged: count >= threshold
      }))
      .sort((a, b) => b.count - a.count);
  },

  refusalsByOfficer(stationId) {
    const db = read();
    const out = {};
    db.refusals.filter(r => !stationId || r.station_id === stationId).forEach(r => {
      const u = db.users.find(x => x.id === r.officer_id);
      const key = u ? u.name : 'Unknown';
      out[key] = (out[key] || 0) + 1;
    });
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  },

  refusals(stationId) {
    const db = read();
    return db.refusals.filter(r => !stationId || r.station_id === stationId);
  },

  notifications(intakeId) {
    return read().notifications.filter(n => n.intake_id === Number(intakeId))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  },

  /* helper lookups */
  userName(id) { const u = read().users.find(x => x.id === Number(id)); return u ? u.name : 'System'; },

  categoryName(id) { const c = read().categories.find(x => x.id === Number(id)); return c ? c.name : '—'; },

  stationName(id) { const s = read().stations.find(x => x.id === Number(id)); return s ? s.name : '—'; },

  complainant(id) { return read().complainants.find(c => c.id === Number(id)); }
};

/* The name given when tracking must match the one captured on the report, but
   capitals and spacing are not part of that check. A phone keyboard capitalises
   on its own, and a complainant looking at the screen cannot see that they typed
   a trailing space or a double space — so those differences lock people out of
   their own case without telling them what to correct. The reference number is
   what an outsider would have to guess; the name is a second factor, and
   requiring it in the right letters adds no protection. */
function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/* Shared by the complainant-ID and ID-number lookups: same name check, same
   list of that person's reports, so the two routes can never drift apart. */
function complainantReports(db, comp, fullName) {
  if (!comp) return { ok: false };
  if (fullName && normalizeName(comp.name) !== normalizeName(fullName)) return { ok: false };

  const reports = db.intakes.filter(i => i.complainant_id === comp.id).map(i => {
    const docket = i.docket_id ? db.dockets.find(d => d.id === i.docket_id) : null;
    return {
      ref: docket ? docket.cas_number : i.intake_number,
      category: (db.categories.find(c => c.id === i.category_id) || {}).name || '—',
      status: docket ? labelStatus(docket.current_status) : labelDisposition(i.disposition),
      created_at: i.created_at
    };
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { ok: true, complainant: comp, reports };
}

/* ---------------- labels ---------------- */

function labelStatus(s) {
  return ({
    registered: 'Registered',
    awaiting_assignment: 'Awaiting assignment',
    under_investigation: 'Under investigation',
    sent_to_prosecutor: 'Sent to prosecutor',
    closed: 'Closed'
  })[s] || s || '—';
}

function labelRole(r) {
  return ({
    official: 'Police Official', detective: 'Detective',
    commander: 'Station Commander', admin: 'Administrator', system: 'System'
  })[r] || r;
}

function labelChannel(c) {
  return ({
    public_web: 'public web', station: 'station terminal',
    assisted: 'assisted capture', third_party: 'third party'
  })[c] || c;
}

function labelDisposition(d) {
  return ({
    pending: 'Pending', docket_opened: 'Docket opened',
    refused: 'Refused', referred: 'Referred', withdrawn: 'Withdrawn'
  })[d] || d;
}

function labelPriority(p) { return p || 'Medium'; }

function priorityRank(p) {
  return ({ Low: 1, Medium: 2, High: 3, Critical: 4 })[p] || 2;
}

