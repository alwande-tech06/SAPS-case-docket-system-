/* ==========================================================================
   store.js — temporary data layer (localStorage)
   --------------------------------------------------------------------------
   Stands in for the Flask/PostgreSQL backend until it is built. Every function
   here maps to an API endpoint later, so swapping the backend in means
   replacing the bodies of these functions with fetch() calls and changing
   nothing else in the pages.

   Table names mirror the ERD entities.
   ========================================================================== */

const DB_KEY = 'saps_docket_db_v1';
const SESSION_KEY = 'saps_docket_session';

/* Crime categories live outside seed() because migrate() backfills them onto a
   database that was seeded before these columns existed. */
const CATEGORIES = [
  { id: 1, name: 'Theft', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
  { id: 2, name: 'Common assault', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
  { id: 3, name: 'Sexual offence', required_specialisation_id: 2, sla_days: 14, default_priority: 'Critical', protected_from_withdrawal: true },
  { id: 4, name: 'Domestic violence', required_specialisation_id: 2, sla_days: 14, default_priority: 'High', protected_from_withdrawal: true },
  { id: 5, name: 'Fraud', required_specialisation_id: 3, sla_days: 45, default_priority: 'Medium', protected_from_withdrawal: false },
  { id: 6, name: 'Vehicle theft', required_specialisation_id: 4, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
  { id: 7, name: 'Burglary', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
  { id: 8, name: 'Malicious damage to property', required_specialisation_id: 1, sla_days: 30, default_priority: 'Low', protected_from_withdrawal: false },
  /* Robbery is theft with violence or a threat of it — a different crime from
     theft, with different elements, so it cannot sit under the same heading. */
  { id: 9, name: 'Robbery', required_specialisation_id: 1, sla_days: 30, default_priority: 'High', protected_from_withdrawal: false },
  { id: 10, name: 'Crimen injuria or intimidation', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
  /* "Other" deliberately does not guess. It takes a free description and an
     official classifies it when the docket is opened, because a wrong
     automatic category sets the wrong priority and the wrong specialisation. */
  { id: 11, name: 'Other — to be classified by an official', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false, requires_classification: true }
];

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

/* Tables every database must have. A browser that stored a database before a
   feature was added still holds the old shape, and a missing table reads as
   undefined rather than an empty list — which throws on the first .find(). */
const TABLES = ['stations', 'specialisations', 'categories', 'users', 'complainants',
  'intakes', 'dockets', 'refusals', 'escalations', 'assignments', 'status_history',
  'notes', 'evidence', 'custody', 'arrests', 'handovers', 'audit_log',
  'complainant_evidence', 'withdrawals', 'notifications', 'closures', 'transfers',
  'witnesses', 'forensics'];

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

/* ---------------- browser storage ----------------
   Reading localStorage is not guaranteed to work. A browser hands back a
   SecurityError when the page is opened from a file:// path it treats as an
   opaque origin, when site data is blocked, and in some private-browsing modes.
   Left unguarded, that throws on the very first Store call and every button on
   the page silently does nothing. The prototype falls back to memory instead,
   so the screens still work for the length of the visit, and sets a flag the
   pages use to warn that nothing will be kept. */

let memoryStore = {};
let storageWorks = true;

function storageGet(key) {
  try { return localStorage.getItem(key); }
  catch (e) { storageWorks = false; return key in memoryStore ? memoryStore[key] : null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch (e) { storageWorks = false; memoryStore[key] = String(value); }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { storageWorks = false; }
  delete memoryStore[key];
}

/* ---------------- core read / write ---------------- */

function read() {
  const raw = storageGet(DB_KEY);
  if (!raw) { const fresh = seed(); write(fresh); return fresh; }
  let db;
  try { db = JSON.parse(raw); }
  catch (e) { const fresh = seed(); write(fresh); return fresh; }
  if (migrate(db)) write(db);
  return db;
}

/* Brings a stored database up to the current shape in place, and reports
   whether anything changed so read() only writes when it must. Reports already
   captured by a complainant are theirs, so the database is upgraded rather than
   thrown away and re-seeded. */
function migrate(db) {
  let changed = false;

  if (!db.counters) { db.counters = { intake: 0, cas: 0, complainant: 0 }; changed = true; }
  ['intake', 'cas', 'complainant'].forEach(k => {
    if (typeof db.counters[k] !== 'number') { db.counters[k] = 0; changed = true; }
  });

  TABLES.forEach(t => {
    if (!Array.isArray(db[t])) { db[t] = []; changed = true; }
  });

  /* Categories gained a default priority and a withdrawal protection flag. */
  CATEGORIES.forEach(def => {
    const cat = db.categories.find(c => c.id === def.id);
    if (!cat) { db.categories.push(Object.assign({}, def)); changed = true; return; }
    if (cat.default_priority === undefined) { cat.default_priority = def.default_priority; changed = true; }
    if (cat.protected_from_withdrawal === undefined) {
      cat.protected_from_withdrawal = def.protected_from_withdrawal; changed = true;
    }
  });

  /* Complainants gained a permanent CMP- number, an ID number and gender. */
  db.complainants.forEach(c => {
    if (!c.complainant_number) { c.complainant_number = newComplainantNumber(db); changed = true; }
    if (c.id_number === undefined) { c.id_number = null; changed = true; }
    if (c.gender === undefined) { c.gender = null; changed = true; }
  });
  const highest = db.complainants.reduce((m, c) =>
    Math.max(m, Number(String(c.complainant_number || '').replace(/\D/g, '')) || 0), 0);
  if (db.counters.complainant < highest) { db.counters.complainant = highest; changed = true; }

  /* Refusals gained a co-sign workflow. One recorded before that existed had
     already taken effect under the old single-signature rule, so it is marked
     confirmed rather than being dragged back into a queue for a signature
     nobody is waiting for. */
  db.refusals.forEach(r => {
    if (!r.status) {
      r.status = 'confirmed';
      r.raised_at = r.raised_at || r.refused_at || null;
      r.cosigned_by = r.cosigned_by || null;
      r.cosigned_at = r.cosigned_at || null;
      r.cosign_note = r.cosign_note || 'Recorded before a second signature was required.';
      changed = true;
    }
  });

  /* Dockets gained a brought-forward review date. */
  db.dockets.forEach(d => {
    if (d.brought_forward_at === undefined) { d.brought_forward_at = null; changed = true; }
  });

  /* Dockets gained a system-assigned priority; intakes gained a docket_id. */
  db.dockets.forEach(d => {
    if (d.priority === undefined) {
      const intake = db.intakes.find(i => i.id === d.intake_id);
      const cat = intake && db.categories.find(c => c.id === intake.category_id);
      d.priority = cat ? cat.default_priority : 'Medium';
      changed = true;
    }
  });
  db.intakes.forEach(i => {
    if (i.docket_id === undefined) {
      const d = db.dockets.find(x => x.intake_id === i.id);
      i.docket_id = d ? d.id : null;
      changed = true;
    }
  });

  return changed;
}

function write(db) { storageSet(DB_KEY, JSON.stringify(db)); }

function nextId(list) {
  return list.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
}

/* ---------------- reference numbers ---------------- */

function pad(n) { return String(n).padStart(6, '0'); }

function newIntakeNumber(db, stationCode) {
  db.counters.intake += 1;
  return `INT-2026-${stationCode}-${pad(db.counters.intake)}`;
}

function newCasNumber(db, stationCode) {
  db.counters.cas += 1;
  return `CAS-2026-${stationCode}-${pad(db.counters.cas)}`;
}

/* A token for the QR code on the receipt. It makes the link unguessable — a
   reference number on its own is sequential, so INT-…-000008 implies
   INT-…-000009 exists. It is NOT a credential: whoever lands on it still has
   to prove who they are, because a printed slip can be lost or photographed
   and case content is private under the Victims' Charter. */
function newTrackToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 32; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  /* Only reached where the crypto API is missing; still unguessable enough for
     a prototype, and the OTP is what actually protects the content. */
  for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function newComplainantNumber(db) {
  db.counters.complainant += 1;
  return `CMP-${pad(db.counters.complainant)}`;
}

/* ---------------- audit trail ----------------
   Hash-chained. Each entry stores a short hash of its own content plus the
   previous entry's hash, so removing an entry breaks the chain visibly.
   A real deployment would do this server-side with SHA-256.
------------------------------------------------- */

function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function logAudit(db, entry) {
  const prev = db.audit_log.length ? db.audit_log[db.audit_log.length - 1].entry_hash : '00000000';
  const rec = {
    id: nextId(db.audit_log),
    user_id: entry.user_id || null,
    user_name: entry.user_name || 'System',
    user_role: entry.user_role || 'system',
    action_type: entry.action_type,
    entity_type: entry.entity_type || '',
    entity_id: entry.entity_id || null,
    case_id: entry.case_id || null,
    description: entry.description,
    access_reason: entry.access_reason || '',
    performed_at: entry.performed_at || new Date().toISOString(),
    prev_hash: prev
  };
  rec.entry_hash = shortHash(prev + rec.action_type + rec.description + rec.performed_at);
  db.audit_log.push(rec);
  return rec;
}

/* ---------------- session ---------------- */

const Session = {
  get() {
    const raw = storageGet(SESSION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) { storageRemove(SESSION_KEY); return null; }
  },
  set(user) { storageSet(SESSION_KEY, JSON.stringify(user)); },
  clear() { storageRemove(SESSION_KEY); }
};

/* ==========================================================================
   Public API — grouped the way the Flask blueprints will be
   ========================================================================== */

const Store = {

  /* ----- meta ----- */
  all() { return read(); },
  reset() { storageRemove(DB_KEY); Session.clear(); },

  /* False when the browser refused to keep data; pages warn the user. */
  storageWorks() { read(); return storageWorks; },

  /* ----- auth ----- */
  login(email, password) {
    const db = read();
    const u = db.users.find(x => x.email.toLowerCase() === email.toLowerCase().trim());
    if (!u) return { ok: false, error: 'No account found for that email address.' };
    if (u.password !== password) return { ok: false, error: 'That password does not match our records.' };
    if (!u.is_active) return { ok: false, error: 'This account has been deactivated.' };
    u.last_login = new Date().toISOString();
    logAudit(db, { user_id: u.id, user_name: u.name, user_role: u.role,
      action_type: 'login', entity_type: 'user', entity_id: u.id,
      description: `${u.name} signed in` });
    write(db);
    Session.set({ id: u.id, name: u.name, role: u.role, station_id: u.station_id, rank: u.rank });
    return { ok: true, user: u };
  },

  logout() {
    const s = Session.get();
    if (s) {
      const db = read();
      logAudit(db, { user_id: s.id, user_name: s.name, user_role: s.role,
        action_type: 'logout', description: `${s.name} signed out` });
      write(db);
    }
    Session.clear();
  },

  session() { return Session.get(); },
  users() { return read().users; },
  stations() { return read().stations; },
  categories() { return read().categories; },
  specialisations() { return read().specialisations; },

  /* ----- reporting (public, no account) ----- */
  submitReport(data) {
    const db = read();
    const station = data.station_id
      ? (db.stations.find(s => s.id === Number(data.station_id)) || db.stations[0])
      : routeByLocation(db, data.location);

    let comp = data.id_number
      ? db.complainants.find(c => c.id_number === data.id_number)
      : db.complainants.find(c => c.contact === data.contact);
    if (!comp) {
      comp = { id: nextId(db.complainants), complainant_number: newComplainantNumber(db),
               name: data.name, contact: data.contact, id_number: data.id_number || null,
               gender: data.gender || null,
               verified_at: new Date().toISOString() };
      db.complainants.push(comp);
    } else {
      comp.name = data.name;
      comp.contact = data.contact;
      if (data.gender) comp.gender = data.gender;
    }

    const rec = {
      id: nextId(db.intakes),
      intake_number: newIntakeNumber(db, station.code),
      track_token: newTrackToken(),
      complainant_id: comp.id,
      category_id: Number(data.category_id),
      station_id: station.id,
      channel: data.channel || 'public_web',
      incident_description: data.description,
      incident_location: data.location,
      incident_datetime: data.incident_datetime,
      created_by: data.created_by || null,
      created_at: new Date().toISOString(),
      /* The category-specific answers, kept as given. These are what let an
         official test the elements of the offence instead of guessing. */
      details: data.details || {},
      /* Optional by design: not being able to identify anyone is never a
         ground to refuse a docket. */
      suspect: data.suspect && (data.suspect.description || data.suspect.name)
        ? { can_identify: true,
            name: (data.suspect.name || '').trim(),
            description: (data.suspect.description || '').trim(),
            contact: (data.suspect.contact || '').trim() }
        : { can_identify: false },
      /* Witnesses the complainant knows about. They become witness records on
         the docket the moment it is opened, so the closure checklist sees them
         even if nobody re-types them. */
      witnesses_reported: (data.witnesses || [])
        .filter(w => (w.name || '').trim())
        .map(w => ({ name: w.name.trim(), contact: (w.contact || '').trim() })),
      disposition: 'pending',
      disposed_at: null,
      disposed_by: null,
      docket_id: null
    };
    db.intakes.push(rec);

    logAudit(db, { action_type: 'create', entity_type: 'intake', entity_id: rec.id,
      description: `Report ${rec.intake_number} received via ${labelChannel(rec.channel)}` });
    logAudit(db, { action_type: 'route', entity_type: 'intake', entity_id: rec.id,
      description: `Routed to ${station.name} on incident location` });

    write(db);
    return rec;
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

  /* ----- tracking ----- */
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

    logAudit(db, { action_type: 'view', entity_type: 'intake', entity_id: intake.id,
      case_id: docket ? docket.id : null,
      description: `Complainant viewed status of ${docket ? docket.cas_number : intake.intake_number}` });
    write(db);

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

  /* Recorded so that a case being opened from a scanned link is as visible in
     the audit trail as any other access to it. */
  logTrackLinkAccess(intakeId, outcome) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake) return;
    logAudit(db, { action_type: 'view', entity_type: 'intake', entity_id: intake.id,
      case_id: intake.docket_id || null,
      description: `Tracking link for ${intake.intake_number}: ${outcome}` });
    write(db);
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

  /* ----- disposition (police official) ----- */
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
    return r ? { role: r.role, anchor: r.anchor, href: `guide.html?role=${r.role}#${r.anchor}` } : null;
  },

  openDocket(intakeId, actor, options = {}) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake || intake.disposition !== 'pending') return null;

    /* An official classifying an "Other" report is a decision in its own
       right: it sets the priority and the specialisation, so it is recorded
       against their name rather than quietly changing the report. */
    const current = db.categories.find(c => c.id === intake.category_id);
    if (current && current.requires_classification) {
      const chosen = db.categories.find(c => c.id === Number(options.category_id));
      if (!chosen || chosen.requires_classification) return null;
      const from = current.name;
      intake.category_id = chosen.id;
      logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
        action_type: 'classify', entity_type: 'intake', entity_id: intake.id,
        description: `${intake.intake_number} classified as ${chosen.name} (was "${from}") by ${actor.name}` });
    }

    const res = openDocketInternal(db, intake, actor);
    /* Diagram 2 ends by telling the complainant who is investigating. When the
       system could not allocate, say that plainly rather than leaving silence
       where a name should be — the station commander has it either way. */
    notify(db, intake, res.assigned
      ? `A case has been opened. Your case number is ${res.docket.cas_number}, and ${res.assigned.name} is investigating it.`
      : `A case has been opened. Your case number is ${res.docket.cas_number}. An investigating officer is being allocated by the station commander.`);
    write(db);
    return res;
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
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake || intake.disposition !== 'pending') {
      return { ok: false, code: 'intake_preconditions', error: 'That report has already been dealt with.' };
    }
    if (db.refusals.some(r => r.intake_id === intake.id && r.status === 'pending_cosign')) {
      return { ok: false, code: 'cosign',
        error: 'A refusal on this report is already waiting for a second signature.' };
    }

    const allowed = Store.refusalReasonsFor(intake.id);
    if (!allowed.includes(payload.reason_category)) {
      const cat = db.categories.find(c => c.id === intake.category_id);
      /* "Insufficient evidence" is the ground people reach for most, and the
         guide answers it specifically, so it gets its own code. */
      const insufficient = /insufficient|not enough|no evidence/i.test(payload.reason_category || '');
      return { ok: false,
        code: cat && cat.protected_from_withdrawal ? 'protected_categories'
          : insufficient ? 'insufficient_at_intake' : 'invalid_grounds',
        error: cat && cat.protected_from_withdrawal
          ? `For ${cat.name.toLowerCase()}, a docket may only be withheld for a verified duplicate.`
          : insufficient
            ? 'Whether evidence is sufficient is decided after an investigation, not at intake.'
            : 'That is not a reason a docket may be refused at intake.' };
    }
    const detail = (payload.reason_detail || '').trim();
    if (detail.length < MIN_REASON_LENGTH) {
      return { ok: false, code: 'no_offence',
        error: `Write the full reason — at least ${MIN_REASON_LENGTH} characters. Another person has to weigh this decision on what you write here.` };
    }
    /* "No offence disclosed" means a named element of the definition is
       missing. Naming which one, against the definition consulted, is what
       makes the decision reviewable — and what stops the phrase being used as
       a shrug (NI 3/2011; four elements of an offence). */
    if (payload.reason_category === NO_OFFENCE_REASON) {
      if (!MISSING_ELEMENTS.includes(payload.missing_element)) {
        return { ok: false, code: 'no_offence',
          error: 'Name the element that is missing: legality, or conduct.' };
      }
      if (!(payload.definition_reference || '').trim()) {
        return { ok: false, code: 'no_offence',
          error: 'Record the crime definition you consulted.' };
      }
    }
    if (payload.reason_category === DUPLICATE_REASON && !(payload.duplicate_of || '').trim()) {
      return { ok: false, code: 'duplicate',
        error: 'Give the case or report number this duplicates, so it can be verified.' };
    }

    const rec = {
      id: nextId(db.refusals),
      intake_id: intake.id,
      station_id: intake.station_id,
      officer_id: actor.id,
      reason_category: payload.reason_category,
      reason_detail: detail,
      duplicate_of: (payload.duplicate_of || '').trim() || null,
      missing_element: payload.missing_element || null,
      definition_reference: (payload.definition_reference || '').trim() || null,
      status: 'pending_cosign',
      raised_at: new Date().toISOString(),
      refused_at: null,
      complainant_notified_at: null,
      cosigned_by: null,
      cosigned_at: null,
      cosign_note: ''
    };
    db.refusals.push(rec);

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'refusal_proposed', entity_type: 'intake', entity_id: intake.id,
      description: `Refusal proposed on ${intake.intake_number} — ${rec.reason_category}. Awaiting a second signature.` });
    write(db);
    return { ok: true, refusal: rec };
  },

  /* The second signature. Refusing to co-sign is not a neutral act: the
     diagram's "no" branch means the docket must be opened, so rejecting the
     refusal opens it here rather than dropping the report back into limbo. */
  cosignRefusal(refusalId, actor, agree, note, options = {}) {
    const db = read();
    const rec = db.refusals.find(r => r.id === Number(refusalId));
    if (!rec || rec.status !== 'pending_cosign') {
      return { ok: false, code: 'cosign', error: 'That refusal is no longer waiting for a signature.' };
    }
    if (actor.role !== 'commander') {
      return { ok: false, code: 'cosign',
        error: 'Only the station commander can sign off a decision not to open a docket.' };
    }
    if (rec.officer_id === actor.id) {
      return { ok: false, code: 'separation',
        error: 'The official who proposed a refusal cannot sign it off. A second person must.' };
    }
    /* Signing is the consequential act — it is what ends the report — so the
       reasons matter at least as much there as in refusing to sign. Both need
       a written note. */
    const cosignNote = (note || '').trim();
    if (cosignNote.length < MIN_REASON_LENGTH) {
      return { ok: false, code: 'cosign',
        error: agree
          ? `Record why the facts disclose no offence — at least ${MIN_REASON_LENGTH} characters.`
          : `Record why a docket must be opened — at least ${MIN_REASON_LENGTH} characters.` };
    }
    /* The system cannot read a statement and tell whether it discloses a
       crime. What it can do is refuse to let that judgement be implicit: the
       commander states that the comparison was made against the definition. */
    if (agree && !options.definition_checked) {
      return { ok: false, code: 'cosign',
        error: 'Confirm that you compared the facts against the crime definition before signing.' };
    }

    const intake = db.intakes.find(i => i.id === rec.intake_id);
    rec.cosigned_by = actor.id;
    rec.cosigned_at = new Date().toISOString();
    rec.cosign_note = cosignNote;
    rec.definition_checked = !!options.definition_checked;

    if (!agree) {
      rec.status = 'rejected';
      rec.reversed_official_id = rec.officer_id;
      /* Logged as a reversal, against the official who proposed it. One is a
         disagreement; a pattern of them is what the oversight report is for. */
      logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
        action_type: 'decision_reversed', entity_type: 'intake', entity_id: intake.id,
        description: `Decision by ${Store.userName(rec.officer_id)} reversed on ${intake.intake_number}: ` +
          `refusal not signed off — ${rec.cosign_note}. A docket must be opened.` });
      write(db);
      return { ok: true, refusal: rec, mustOpenDocket: true };
    }

    rec.status = 'confirmed';
    rec.refused_at = rec.cosigned_at;
    rec.complainant_notified_at = rec.cosigned_at;
    intake.disposition = 'refused';
    intake.disposed_at = rec.refused_at;
    intake.disposed_by = rec.officer_id;

    notify(db, intake, `No docket was opened. Reason: ${rec.reason_category}. ` +
      'You may escalate this to the station commander from your tracking page.');
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'refusal', entity_type: 'intake', entity_id: intake.id,
      description: `Refusal on ${intake.intake_number} signed off by ${actor.name} — ${rec.reason_category}` });
    write(db);
    return { ok: true, refusal: rec };
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
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake || intake.disposition !== 'pending') {
      return { ok: false, code: 'intake_preconditions', error: 'That report has already been dealt with.' };
    }
    const to = db.stations.find(s => s.id === Number(payload.to_station_id));
    if (!to) return { ok: false, code: 'transfer', error: 'Choose the station that should receive this case.' };
    if (to.id === intake.station_id) {
      return { ok: false, code: 'transfer', error: 'That is the station already handling this report.' };
    }
    if (!(payload.reason || '').trim()) {
      return { ok: false, code: 'transfer', error: 'A reason for the transfer is required.' };
    }

    const opened = openDocketInternal(db, intake, actor);
    const from = db.stations.find(s => s.id === opened.docket.station_id);

    opened.docket.station_id = to.id;
    opened.docket.last_activity_at = new Date().toISOString();
    /* The detective auto-assigned at the receiving station's expense would be
       wrong — the new station allocates its own, so the docket arrives
       unassigned and shows up on their commander's dashboard. */
    opened.docket.detective_id = null;
    db.assignments.filter(a => a.docket_id === opened.docket.id && a.is_active)
      .forEach(a => { a.is_active = false; a.unassigned_at = opened.docket.last_activity_at; });

    db.transfers.push({ id: nextId(db.transfers), docket_id: opened.docket.id,
      from_station_id: from.id, to_station_id: to.id, transferred_by: actor.id,
      transferred_at: opened.docket.last_activity_at, reason: payload.reason.trim() });

    notify(db, intake, `Your case number is ${opened.docket.cas_number}. ` +
      `It has been registered at ${from.name} and transferred to ${to.name}, which covers where this happened. ` +
      'You do not need to report it again.');
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'transfer', entity_type: 'docket', entity_id: opened.docket.id, case_id: opened.docket.id,
      description: `${opened.docket.cas_number} registered at ${from.name} and transferred to ${to.name} — ${payload.reason.trim()}` });
    write(db);
    return { ok: true, docket: opened.docket, to };
  },

  /* ----- dockets ----- */
  dockets(filter = {}) {
    const db = read();
    return db.dockets.filter(d =>
      (!filter.station_id || d.station_id === filter.station_id) &&
      (!filter.detective_id || d.detective_id === filter.detective_id));
  },

  docket(id) { return read().dockets.find(d => d.id === Number(id)); },

  updateStatus(docketId, newStatus, actor, notes) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return null;
    /* Closing is not a status change. It goes through requestClosure and a
       commander's approval, so this path cannot be used to bypass either. */
    if (newStatus === 'closed') return null;
    const prev = d.current_status;
    d.current_status = newStatus;
    d.last_activity_at = new Date().toISOString();

    db.status_history.push({ id: nextId(db.status_history), docket_id: d.id,
      previous_status: prev, new_status: newStatus, changed_by: actor.id,
      changed_at: d.last_activity_at, notes: notes || '' });

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'status_change', entity_type: 'docket', entity_id: d.id, case_id: d.id,
      description: `${d.cas_number}: ${labelStatus(prev)} to ${labelStatus(newStatus)}` });
    write(db);
    return d;
  },

  /* ----- closing (filing) a docket -----
     Closure is a request plus an approval by someone else, never a single
     action. Each filing category carries the one thing it cannot be filed
     without, so "undetected" cannot be used on a docket nobody worked on and
     "sent to court" cannot be claimed without a prosecutor reference. */
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
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    const cat = FILING_CATEGORIES.find(c => c.key === payload.category);
    if (!cat) return { ok: false, code: 'filing_categories', error: 'Choose a filing category.' };
    if (db.closures.some(c => c.docket_id === d.id && c.status === 'pending_approval')) {
      return { ok: false, code: 'closure_request',
        error: 'A closure request on this case is already awaiting approval.' };
    }
    const blocker = Store.closureBlocker(d.id, cat.key, payload);
    if (blocker) return { ok: false, code: blocker.code, error: blocker.message };

    const rec = { id: nextId(db.closures), docket_id: d.id, category: cat.key,
      category_label: cat.label, requested_by: actor.id, requested_at: new Date().toISOString(),
      warrant_reference: (payload.warrant_reference || '').trim() || null,
      circulation_reference: (payload.circulation_reference || '').trim() || null,
      discrepancy_report: (payload.discrepancy_report || '').trim() || null,
      prosecutor_reference: (payload.prosecutor_reference || '').trim() || null,
      motivation: (payload.motivation || '').trim(),
      status: 'pending_approval', decision: null, decided_by: null,
      decided_at: null, decision_reason: null };
    db.closures.push(rec);
    d.last_activity_at = rec.requested_at;

    /* Evidence going missing is a supervisor matter in its own right, whatever
       happens to the closure request. */
    if (cat.key === 'evidence_compromised') {
      db.escalations.push({ id: nextId(db.escalations), docket_id: d.id, intake_id: null,
        reason: `Evidence missing or compromised on ${d.cas_number} — ${rec.discrepancy_report}`,
        raised_by_complainant: false, raised_at: rec.requested_at, decision_maker_id: actor.id,
        commander_id: null, response: null, responded_at: null, status: 'open' });
    }

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'closure_requested', entity_type: 'docket', entity_id: d.id, case_id: d.id,
      description: `Closure requested on ${d.cas_number} — ${cat.label}. Awaiting commander approval.` });
    write(db);
    return { ok: true, closure: rec };
  },

  /* ----- the commander's closure inspection -----
     NI 3/2011 already makes him responsible for seeing that dockets are
     investigated effectively, for inspecting them personally and for writing
     the diary instructions. So approving a closure is not a rubber stamp on
     someone else's work — it is checking that his own instructions were
     carried out. Each item below is a guard, and the screen shows the docket's
     own evidence beside it so the check is done against the record rather than
     against an assurance. */
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
    const db = read();
    const rec = db.closures.find(c => c.id === Number(closureId));
    if (!rec || rec.status !== 'pending_approval') {
      return { ok: false, error: 'That closure request has already been decided.' };
    }
    if (rec.requested_by === actor.id) {
      return { ok: false, code: 'separation',
        error: 'The investigating officer who requested a closure cannot approve it.' };
    }
    if (!(reason || '').trim()) {
      return { ok: false, code: 'approve_closure', error: 'A reason is required for this decision.' };
    }

    /* Approval is gated on the inspection. Refusing a closure is not — a
       commander must always be able to send a case back, whatever state it is
       in, and in fact a failing checklist is the usual reason to do so. */
    if (decision === 'approved') {
      const check = Store.closureChecklist(rec.id, actor.id);
      if (!check.canApprove) {
        /* The code names the first failing item, so the link lands on that rule
           rather than on the checklist in general. */
        return { ok: false, code: check.blocking[0].code || 'approve_closure',
          blocking: check.blocking,
          error: 'This docket does not yet satisfy the closure checklist: ' +
            check.blocking.map(b => b.label).join('; ') };
      }
    }

    const d = db.dockets.find(x => x.id === rec.docket_id);
    const intake = db.intakes.find(i => i.id === d.intake_id);
    rec.status = 'decided';
    rec.decision = decision;
    rec.decided_by = actor.id;
    rec.decided_at = new Date().toISOString();
    rec.decision_reason = reason.trim();

    if (decision === 'approved') {
      rec.approved_by = actor.id;
      rec.approved_at = rec.decided_at;
      rec.checklist_confirmed = Store.closureChecklist(rec.id, actor.id).items
        .filter(i => !i.informational).map(i => ({ key: i.key, ok: i.ok }));
      const prev = d.current_status;
      d.current_status = 'closed';
      d.closure_type = rec.category_label;
      d.last_activity_at = rec.decided_at;
      const cat = FILING_CATEGORIES.find(c => c.key === rec.category);
      if (cat && cat.brought_forward_months) {
        const bf = new Date(rec.decided_at);
        bf.setMonth(bf.getMonth() + cat.brought_forward_months);
        d.brought_forward_at = bf.toISOString();
      }
      db.status_history.push({ id: nextId(db.status_history), docket_id: d.id,
        previous_status: prev, new_status: 'closed', changed_by: actor.id,
        changed_at: rec.decided_at, notes: `${rec.category_label} — ${rec.decision_reason}` });
      if (intake) {
        notify(db, intake, `Your case ${d.cas_number} has been filed: ${rec.category_label}. ` +
          `Reason: ${rec.decision_reason}. If you disagree, you may escalate this from your tracking page.`);
      }
    } else {
      d.last_activity_at = rec.decided_at;
    }

    /* The audit entry carries who approved it, when, under which category and
       on what reasons — the four things an inspection afterwards asks for. */
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: decision === 'approved' ? 'closure_approved' : 'closure_rejected',
      entity_type: 'docket', entity_id: d.id, case_id: d.id,
      performed_at: rec.decided_at,
      description: `Closure of ${d.cas_number} ${decision} by ${actor.name} (${labelRole(actor.role)}) ` +
        `on ${rec.decided_at} — category: ${rec.category_label}; ` +
        `detective's motivation: ${rec.motivation || '—'}; commander's reason: ${rec.decision_reason}` +
        (d.brought_forward_at ? `; brought forward for review on ${d.brought_forward_at}` : '') });
    write(db);
    return { ok: true, closure: rec };
  },

  closures(filter = {}) {
    const db = read();
    return db.closures.filter(c =>
      (!filter.status || c.status === filter.status) &&
      (!filter.docket_id || c.docket_id === Number(filter.docket_id)))
      .slice().reverse();
  },

  /* ----- reopening a filed docket (Diagram 6) -----
     Reopening is deliberately easy for the triggers the system can see for
     itself — an arrest, a recovery, a forensic match — and deliberately
     conditional for a person: a manual reopening needs something new. */
  reopenDocket(docketId, actor, payload) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    if (d.current_status !== 'closed') return { ok: false, error: 'This case is not filed.' };

    const trigger = payload.trigger || 'manual';
    if (trigger === 'manual' && !(payload.new_evidence || '').trim()) {
      return { ok: false, error: 'A manual reopening requires new evidence or new information.' };
    }

    const now = new Date().toISOString();
    const prev = d.current_status;
    d.current_status = 'under_investigation';
    d.closure_type = null;
    d.brought_forward_at = null;
    d.last_activity_at = now;

    const why = trigger === 'manual' ? payload.new_evidence.trim() : REOPEN_TRIGGERS[trigger] || trigger;
    db.status_history.push({ id: nextId(db.status_history), docket_id: d.id,
      previous_status: prev, new_status: 'under_investigation', changed_by: actor ? actor.id : null,
      changed_at: now, notes: `Reopened — ${why}` });

    const assigned = d.detective_id ? null : autoAssign(db, d);
    const intake = db.intakes.find(i => i.id === d.intake_id);
    if (intake) notify(db, intake, `Your case ${d.cas_number} has been reopened. Reason: ${why}.`);

    logAudit(db, { user_id: actor ? actor.id : null, user_name: actor ? actor.name : 'System',
      user_role: actor ? actor.role : 'system',
      action_type: 'reopen', entity_type: 'docket', entity_id: d.id, case_id: d.id,
      description: `${d.cas_number} reopened — ${why}` });
    write(db);
    return { ok: true, docket: d, assigned };
  },

  /* Diagram 6 puts the complainant in the same lane as the detective for a
     manual reopening: they may ask, on the same condition — something new. */
  requestReopenByComplainant(docketId, newEvidence) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    if (d.current_status !== 'closed') return { ok: false, error: 'This case is not filed.' };
    if (!(newEvidence || '').trim()) {
      return { ok: false, error: 'Tell us what is new. A filed case reopens on new evidence or new information.' };
    }
    write(db);
    return Store.reopenDocket(d.id, null, { trigger: 'manual',
      new_evidence: `Raised by the complainant: ${newEvidence.trim()}` });
  },

  /* The review happened and nothing new came of it: the docket stays filed,
     the review is on the record, and the clock is set for another 12 months
     rather than the item sitting on the dashboard forever. */
  noteBroughtForwardReview(docketId, actor) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d || d.current_status !== 'closed') return { ok: false, error: 'This case is not filed.' };
    const next = new Date();
    next.setMonth(next.getMonth() + 12);
    d.brought_forward_at = next.toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'brought_forward_review', entity_type: 'docket', entity_id: d.id, case_id: d.id,
      description: `Brought-forward review of ${d.cas_number} — nothing new, remains filed` });
    write(db);
    return { ok: true, docket: d };
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
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return null;
    db.notes.push({ id: nextId(db.notes), docket_id: d.id, author_id: actor.id,
      note_text: text, created_at: new Date().toISOString() });
    d.last_activity_at = new Date().toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'update', entity_type: 'note', entity_id: d.id, case_id: d.id,
      description: `Progress note added to ${d.cas_number}` });
    write(db);
  },

  notes(docketId) { return read().notes.filter(n => n.docket_id === Number(docketId)); },

  /* ----- investigation diary instructions -----
     NI 3/2011 makes the commander responsible for inspecting dockets and
     writing instructions in the diary. Those instructions are the thing he
     checks at closure, so they are recorded as their own kind of entry with a
     state, not as prose in a note nobody can query. An instruction is answered
     either by doing it or by explaining why it was not done — both close it,
     and the difference is visible. */
  addInstruction(docketId, actor, text) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    if (actor.role !== 'commander') {
      return { ok: false, error: 'Only the station commander writes instructions in the investigation diary.' };
    }
    if (!(text || '').trim()) return { ok: false, error: 'An instruction cannot be empty.' };

    const rec = { id: nextId(db.notes), docket_id: d.id, author_id: actor.id,
      note_text: text.trim(), note_type: 'instruction', status: 'open',
      response: '', responded_by: null, responded_at: null,
      created_at: new Date().toISOString() };
    db.notes.push(rec);
    d.last_activity_at = rec.created_at;
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'instruction', entity_type: 'note', entity_id: rec.id, case_id: d.id,
      description: `Instruction written in the diary of ${d.cas_number}: ${rec.note_text}` });
    write(db);
    return { ok: true, instruction: rec };
  },

  answerInstruction(noteId, actor, outcome, response) {
    const db = read();
    const n = db.notes.find(x => x.id === Number(noteId));
    if (!n || n.note_type !== 'instruction') return { ok: false, error: 'Instruction not found.' };
    if (n.status !== 'open') return { ok: false, error: 'That instruction has already been answered.' };
    if (!(response || '').trim()) {
      return { ok: false, error: outcome === 'executed'
        ? 'Record what was done.' : 'An explanation is required when an instruction was not carried out.' };
    }
    const d = db.dockets.find(x => x.id === n.docket_id);
    n.status = outcome === 'executed' ? 'executed' : 'explained';
    n.response = response.trim();
    n.responded_by = actor.id;
    n.responded_at = new Date().toISOString();
    d.last_activity_at = n.responded_at;
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'instruction_answered', entity_type: 'note', entity_id: n.id, case_id: d.id,
      description: `Diary instruction on ${d.cas_number} ${n.status} — ${n.response}` });
    write(db);
    return { ok: true, instruction: n };
  },

  instructions(docketId) {
    return read().notes.filter(n => n.docket_id === Number(docketId) && n.note_type === 'instruction');
  },

  /* ----- witnesses and their statements -----
     A witness who was identified but never gave a statement, with no reason
     recorded, is the gap the checklist is looking for. */
  addWitness(docketId, actor, payload) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    if (!(payload.name || '').trim()) return { ok: false, error: "The witness's name is required." };

    const rec = { id: nextId(db.witnesses), docket_id: d.id, name: payload.name.trim(),
      contact: (payload.contact || '').trim(), identified_by: actor.id,
      identified_at: new Date().toISOString(),
      statement_text: '', statement_taken_at: null, no_statement_reason: '' };
    db.witnesses.push(rec);
    d.last_activity_at = rec.identified_at;
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'witness', entity_type: 'witness', entity_id: rec.id, case_id: d.id,
      description: `Witness identified on ${d.cas_number}: ${rec.name}` });
    write(db);
    return { ok: true, witness: rec };
  },

  recordWitnessStatement(witnessId, actor, statementText, noStatementReason) {
    const db = read();
    const w = db.witnesses.find(x => x.id === Number(witnessId));
    if (!w) return { ok: false, error: 'Witness not found.' };
    const statement = (statementText || '').trim();
    const reason = (noStatementReason || '').trim();
    if (!statement && !reason) {
      return { ok: false, error: 'Record the statement, or why it could not be taken.' };
    }
    const d = db.dockets.find(x => x.id === w.docket_id);
    if (statement) { w.statement_text = statement; w.statement_taken_at = new Date().toISOString(); w.no_statement_reason = ''; }
    else { w.no_statement_reason = reason; }
    d.last_activity_at = new Date().toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'statement', entity_type: 'witness', entity_id: w.id, case_id: d.id,
      description: statement
        ? `Statement taken from witness ${w.name} on ${d.cas_number}`
        : `No statement from witness ${w.name} on ${d.cas_number} — ${reason}` });
    write(db);
    return { ok: true, witness: w };
  },

  witnesses(docketId) { return read().witnesses.filter(w => w.docket_id === Number(docketId)); },

  /* ----- forensic submissions -----
     Submitted and forgotten is the failure this guards against: every
     submission must come back with a result, or be accounted for. */
  submitForensic(docketId, actor, payload) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    if (!(payload.description || '').trim()) return { ok: false, error: 'Describe what was submitted.' };
    if (!(payload.lab_reference || '').trim()) return { ok: false, error: 'The laboratory reference is required.' };
    if (payload.evidence_id &&
        !db.evidence.some(e => e.id === Number(payload.evidence_id) && e.docket_id === d.id)) {
      return { ok: false, error: 'That exhibit does not belong to this case.' };
    }

    const rec = { id: nextId(db.forensics), docket_id: d.id,
      evidence_id: payload.evidence_id ? Number(payload.evidence_id) : null,
      description: payload.description.trim(), lab_reference: payload.lab_reference.trim(),
      submitted_by: actor.id, submitted_at: new Date().toISOString(),
      result: '', result_at: null, accounted_for_reason: '' };
    db.forensics.push(rec);
    d.last_activity_at = rec.submitted_at;
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'forensic_submitted', entity_type: 'forensic', entity_id: rec.id, case_id: d.id,
      description: `Forensic submission on ${d.cas_number} — ${rec.description} (${rec.lab_reference})` });
    write(db);
    return { ok: true, forensic: rec };
  },

  recordForensicResult(forensicId, actor, result, accountedForReason) {
    const db = read();
    const f = db.forensics.find(x => x.id === Number(forensicId));
    if (!f) return { ok: false, error: 'Forensic submission not found.' };
    const res = (result || '').trim();
    const reason = (accountedForReason || '').trim();
    if (!res && !reason) {
      return { ok: false, error: 'Record the result, or account for why it is outstanding.' };
    }
    const d = db.dockets.find(x => x.id === f.docket_id);
    if (res) { f.result = res; f.result_at = new Date().toISOString(); f.accounted_for_reason = ''; }
    else { f.accounted_for_reason = reason; }
    d.last_activity_at = new Date().toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'forensic_result', entity_type: 'forensic', entity_id: f.id, case_id: d.id,
      description: res
        ? `Forensic result on ${d.cas_number} (${f.lab_reference}): ${res}`
        : `Forensic submission ${f.lab_reference} on ${d.cas_number} outstanding — ${reason}` });
    write(db);
    return { ok: true, forensic: f };
  },

  forensics(docketId) { return read().forensics.filter(f => f.docket_id === Number(docketId)); },
  statusHistory(docketId) { return read().status_history.filter(h => h.docket_id === Number(docketId)); },

  /* ----- evidence -----
     An image is mandatory: a photograph of the item, or for a document exhibit a
     scanned copy through the same field. "Storage location" alone was never
     evidence that the item exists. The suspect link is optional, but once it is
     started all of it — name, ID number and photograph — is required together,
     because a half-identified suspect serves no purpose. */
  addEvidence(docketId, actor, payload) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (!d) return { ok: false, error: 'Case not found.' };
    if (!payload.description || !payload.description.trim()) {
      return { ok: false, code: 'exhibit', error: 'Describe the exhibit before it can be recorded.' };
    }
    if (!payload.image_data_url) {
      return { ok: false, code: 'exhibit', error: 'A photograph of the exhibit (or a scanned copy, for a document) is required before it can be recorded.' };
    }
    /* Chain of custody starts with knowing where the item physically is and
       under which register entry. Without both, "registered" means nothing
       later — there is no way to go and find the item. */
    if (!(payload.storage_location || '').trim()) {
      return { ok: false, code: 'exhibit', error: 'The storage location is required — the chain of custody starts with where the item is.' };
    }
    if (!(payload.saps13_number || '').trim()) {
      return { ok: false, code: 'exhibit', error: 'The SAPS 13 register number is required before an exhibit can be recorded.' };
    }

    const suspectFields = [payload.suspect_name, payload.suspect_id_number, payload.suspect_photo_data_url];
    if (suspectFields.some(f => f) && !suspectFields.every(f => f)) {
      return { ok: false, code: 'exhibit', error: 'To link a suspect, their name, ID number and photograph are all required.' };
    }
    /* "Linked to docket AND to suspect ID where a suspect exists." Once an
       arrest is on this docket a suspect does exist, so an exhibit that names
       nobody and links to no charge is an unattributed item on a case that has
       a named accused. */
    const arrestsOnCase = db.arrests.filter(a => a.docket_id === d.id);
    if (arrestsOnCase.length && !payload.suspect_id_number && !payload.linked_arrest_id) {
      return { ok: false, code: 'exhibit', error: 'This case has a recorded suspect, so the exhibit must be linked to a suspect or to a charge.' };
    }
    if (payload.suspect_id_number && !/^\d{13}$/.test(payload.suspect_id_number)) {
      return { ok: false, code: 'exhibit', error: "The suspect's ID number must be 13 digits." };
    }
    if (payload.linked_arrest_id &&
        !db.arrests.some(a => a.id === Number(payload.linked_arrest_id) && a.docket_id === d.id)) {
      return { ok: false, code: 'exhibit', error: 'The charge you linked does not belong to this case.' };
    }

    const ev = createExhibit(db, d, actor, payload);
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'create', entity_type: 'evidence', entity_id: ev.id, case_id: d.id,
      description: ev.suspect_name
        ? `Exhibit ${ev.exhibit_number} registered on ${d.cas_number}, linked to suspect ${ev.suspect_name} (${ev.suspect_id_number})`
        : `Exhibit ${ev.exhibit_number} registered on ${d.cas_number}` });
    write(db);
    return { ok: true, evidence: ev };
  },

  transferEvidence(evidenceId, actor, toUserId, purpose) {
    const db = read();
    const ev = db.evidence.find(e => e.id === Number(evidenceId));
    const to = db.users.find(u => u.id === Number(toUserId));
    if (!ev || !to) return null;
    db.custody.push({ id: nextId(db.custody), evidence_id: ev.id,
      from_user_id: ev.current_holder_id, to_user_id: to.id,
      transferred_at: new Date().toISOString(), purpose,
      acknowledged: false });
    ev.current_holder_id = to.id;
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'transfer', entity_type: 'evidence', entity_id: ev.id, case_id: ev.docket_id,
      description: `Exhibit ${ev.exhibit_number} transferred to ${to.name}, awaiting acknowledgement` });
    write(db);
    return ev;
  },

  evidence(docketId) { return read().evidence.filter(e => e.docket_id === Number(docketId)); },
  custody(evidenceId) { return read().custody.filter(c => c.evidence_id === Number(evidenceId)); },

  /* ----- priority classification -----
     Priority is derived from the crime category, never chosen by hand: murder
     and shoplifting cannot be made to weigh the same by whoever happens to be
     capturing the case. The mapping lives on the category (admin reference
     data), so changing it is a policy change, not a per-case decision. */
  priorityFor(categoryId) {
    const db = read();
    const cat = db.categories.find(c => c.id === Number(categoryId));
    return cat ? cat.default_priority : 'Medium';
  },

  /* ----- evidence submitted directly by the complainant ----- */
  addComplainantEvidence(intakeId, files, description) {
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake || !files || !files.length) return [];
    const created = files.map(f => {
      const rec = { id: nextId(db.complainant_evidence), intake_id: intake.id,
        file_name: f.name, file_type: f.type, file_size: f.size, data_url: f.dataUrl,
        description: description || '', uploaded_at: new Date().toISOString(),
        review_status: 'pending', reviewed_by: null, reviewed_at: null,
        review_note: '', linked_exhibit_id: null };
      db.complainant_evidence.push(rec);
      return rec;
    });
    const docket = intake.docket_id ? db.dockets.find(d => d.id === intake.docket_id) : null;
    if (docket) docket.last_activity_at = new Date().toISOString();
    logAudit(db, { action_type: 'evidence_submitted', entity_type: 'intake', entity_id: intake.id,
      case_id: docket ? docket.id : null,
      description: `Complainant submitted ${created.length} file(s) as evidence on ${intake.intake_number}` });
    write(db);
    return created;
  },

  complainantEvidence(intakeId) {
    return read().complainant_evidence.filter(e => e.intake_id === Number(intakeId));
  },

  reviewComplainantEvidence(id, actor, decision, note, saps13) {
    const db = read();
    const ce = db.complainant_evidence.find(e => e.id === Number(id));
    if (!ce) return null;
    if (decision === 'rejected' && !(note || '').trim()) {
      return { ok: false, error: 'A reason is required to reject submitted evidence.' };
    }
    /* Accepting turns the file into an exhibit, and an exhibit needs a register
       entry like any other — where it came from does not change that. */
    if (decision === 'accepted' && !(saps13 || '').trim()) {
      return { ok: false, error: 'A SAPS 13 register number is required to accept this as an exhibit.' };
    }
    const intake = db.intakes.find(i => i.id === ce.intake_id);
    const docket = intake && intake.docket_id ? db.dockets.find(d => d.id === intake.docket_id) : null;
    ce.review_status = decision;
    ce.reviewed_by = actor.id;
    ce.reviewed_at = new Date().toISOString();
    ce.review_note = (note || '').trim();

    if (decision === 'accepted' && docket) {
      const ev = createExhibit(db, docket, actor, {
        description: ce.description || ce.file_name,
        evidence_type: ce.file_type.startsWith('image/') ? 'Photograph' : 'Document',
        storage_location: 'Submitted by complainant',
        saps13_number: saps13.trim(),
        image_data_url: ce.data_url,
        custody_purpose: 'Accepted from complainant submission'
      });
      ce.linked_exhibit_id = ev.id;
    }

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: decision === 'accepted' ? 'evidence_accepted' : 'evidence_rejected',
      entity_type: 'complainant_evidence', entity_id: ce.id, case_id: docket ? docket.id : null,
      description: decision === 'accepted'
        ? `Complainant-submitted file "${ce.file_name}" accepted as an exhibit`
        : `Complainant-submitted file "${ce.file_name}" rejected — ${ce.review_note}` });
    write(db);
    return { ok: true, evidence: ce };
  },

  /* ----- withdrawal requests ----- */
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
    const db = read();
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (!intake) return { ok: false, error: 'Report not found.' };
    const elig = Store.withdrawalEligibility(intakeId);
    if (!elig.allowed) return { ok: false, error: elig.reason };

    const rec = { id: nextId(db.withdrawals), intake_id: intake.id,
      docket_id: intake.docket_id || null,
      reason_category: payload.reason_category, reason_detail: payload.reason_detail,
      requested_at: new Date().toISOString(), protected_category: elig.protectedCategory,
      status: 'pending', decision: null, decided_by: null, decided_at: null, decision_reason: null };
    db.withdrawals.push(rec);
    logAudit(db, { action_type: 'withdrawal_request', entity_type: 'intake', entity_id: intake.id,
      case_id: intake.docket_id || null,
      description: `Complainant requested withdrawal of ${intake.intake_number} — ${payload.reason_category}` });
    write(db);
    return { ok: true, withdrawal: rec };
  },

  decideWithdrawal(id, actor, decision, reason) {
    const db = read();
    const w = db.withdrawals.find(x => x.id === Number(id));
    if (!w) return { ok: false, error: 'Withdrawal request not found.' };
    if (!reason || !reason.trim()) return { ok: false, error: 'A reason is required for this decision.' };
    const intake = db.intakes.find(i => i.id === w.intake_id);
    const docket = w.docket_id ? db.dockets.find(d => d.id === w.docket_id) : null;

    w.status = 'decided';
    w.decision = decision;
    w.decided_by = actor.id;
    w.decided_at = new Date().toISOString();
    w.decision_reason = reason.trim();

    if (decision === 'approved') {
      if (docket) {
        const prevStatus = docket.current_status;
        docket.current_status = 'closed';
        docket.closure_type = 'Withdrawn by complainant';
        docket.last_activity_at = w.decided_at;
        db.status_history.push({ id: nextId(db.status_history), docket_id: docket.id,
          previous_status: prevStatus, new_status: 'closed', changed_by: actor.id,
          changed_at: w.decided_at, notes: `Withdrawn by complainant — ${reason.trim()}` });
      } else if (intake) {
        intake.disposition = 'withdrawn';
        intake.disposed_at = w.decided_at;
        intake.disposed_by = actor.id;
      }
    }

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'withdrawal_decision', entity_type: 'withdrawal', entity_id: w.id,
      case_id: docket ? docket.id : null,
      description: `Withdrawal request on ${intake ? intake.intake_number : '—'} — ${decision}: ${reason.trim()}` });
    write(db);
    return { ok: true, withdrawal: w };
  },

  withdrawals(filter = {}) {
    const db = read();
    return db.withdrawals.filter(w => !filter.status || w.status === filter.status)
      .slice().reverse();
  },

  /* ----- arrests / handover ----- */
  addArrest(docketId, actor, payload) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    db.arrests.push({ id: nextId(db.arrests), docket_id: d.id, accused_name: payload.accused_name,
      arrested_by: actor.id, arrest_datetime: new Date().toISOString(),
      charge_description: payload.charge_description });
    d.last_activity_at = new Date().toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'create', entity_type: 'arrest', entity_id: d.id, case_id: d.id,
      description: `Arrest recorded on ${d.cas_number}: ${payload.accused_name}` });
    write(db);
  },

  arrests(docketId) { return read().arrests.filter(a => a.docket_id === Number(docketId)); },

  handover(docketId, actor, payload) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    db.handovers.push({ id: nextId(db.handovers), docket_id: d.id, handed_by: actor.id,
      recipient_name: payload.recipient_name, recipient_organisation: payload.recipient_organisation,
      handover_datetime: new Date().toISOString(), acknowledged: false, receipt_reference: payload.receipt_reference });
    d.current_status = 'sent_to_prosecutor';
    d.last_activity_at = new Date().toISOString();
    db.status_history.push({ id: nextId(db.status_history), docket_id: d.id,
      previous_status: 'under_investigation', new_status: 'sent_to_prosecutor',
      changed_by: actor.id, changed_at: d.last_activity_at, notes: 'Handed to prosecutor' });
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'handover', entity_type: 'docket', entity_id: d.id, case_id: d.id,
      description: `${d.cas_number} handed to ${payload.recipient_name} (${payload.recipient_organisation})` });
    write(db);
  },

  handovers(docketId) { return read().handovers.filter(h => h.docket_id === Number(docketId)); },

  /* ----- escalation ----- */
  raiseEscalation(payload) {
    const db = read();
    /* An escalation never returns to the person who took the decision being
       complained about (Diagram 7). Record who that was, so respondEscalation
       can refuse them and the matter routes upward instead. */
    const decisionMaker = decisionMakerFor(db, payload.docket_id, payload.intake_id);
    const rec = { id: nextId(db.escalations), docket_id: payload.docket_id || null,
      intake_id: payload.intake_id || null, reason: payload.reason,
      raised_by_complainant: payload.raised_by_complainant !== false,
      raised_at: new Date().toISOString(), commander_id: null,
      decision_maker_id: decisionMaker, routed_upward: false,
      response: null, responded_at: null, status: 'open' };
    db.escalations.push(rec);
    logAudit(db, { action_type: 'escalate', entity_type: 'escalation', entity_id: rec.id,
      case_id: payload.docket_id || null,
      description: payload.raised_by_complainant === false
        ? `System raised escalation: ${payload.reason}`
        : `Complainant raised escalation: ${payload.reason}` });
    write(db);
    return rec;
  },

  respondEscalation(id, actor, outcome, response) {
    const db = read();
    const e = db.escalations.find(x => x.id === Number(id));
    if (!e) return null;
    /* The whole point of escalating is to reach someone above the decision.
       If the decision-maker is the one holding this queue, the escalation goes
       up to cluster level instead of being answered by them. */
    if (e.decision_maker_id && e.decision_maker_id === actor.id) {
      e.routed_upward = true;
      e.status = 'routed_upward';
      logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
        action_type: 'escalation_routed', entity_type: 'escalation', entity_id: e.id,
        case_id: e.docket_id,
        description: `Escalation on a decision taken by ${actor.name} routed to cluster level — it cannot be answered by the decision-maker` });
      write(db);
      return { ok: false, routedUpward: true,
        error: 'You took the decision being complained about, so you cannot answer this escalation. It has been routed to cluster level.' };
    }
    e.commander_id = actor.id;
    e.response = `${outcome} — ${response}`;
    e.responded_at = new Date().toISOString();
    e.status = 'responded';
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'escalation_response', entity_type: 'escalation', entity_id: e.id,
      case_id: e.docket_id, description: `Escalation answered: ${outcome}` });
    write(db);
    return { ok: true, escalation: e };
  },

  escalations(filter = {}) {
    const db = read();
    return db.escalations.filter(e => !filter.status || e.status === filter.status);
  },

  /* ----- assignment ----- */
  reassignmentReasons() { return REASSIGNMENT_REASONS.slice(); },

  /* Diagram 3. Three guards, in the order the diagram puts them: the role,
     a reason off the fixed list, and separation of duties — a commander who
     approved a closure on this docket may not also move it to a different
     detective, because that is the same person shaping the same case twice.
     That request goes to the cluster commander instead. */
  reassign(docketId, detectiveId, actor, reason, detail) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    const det = db.users.find(u => u.id === Number(detectiveId));
    if (!d || !det) return { ok: false, error: 'Case or detective not found.' };

    if (actor.role !== 'commander') {
      return { ok: false, code: 'allocation',
        error: 'Only the station commander allocates and reassigns dockets.' };
    }
    if (!REASSIGNMENT_REASONS.includes(reason)) {
      return { ok: false, code: 'reassign', error: 'Choose a reason from the list.' };
    }
    if (reason === 'Other' && !(detail || '').trim()) {
      return { ok: false, code: 'reassign', error: 'Give the detail when the reason is "Other".' };
    }

    const approvedClosure = db.closures.some(c => c.docket_id === d.id &&
      c.status === 'decided' && c.decision === 'approved' && c.decided_by === actor.id);
    if (approvedClosure) {
      db.escalations.push({ id: nextId(db.escalations), docket_id: d.id, intake_id: null,
        reason: `Reassignment of ${d.cas_number} requested by the commander who approved its closure — routed to cluster level.`,
        raised_by_complainant: false, raised_at: new Date().toISOString(),
        decision_maker_id: actor.id, routed_upward: true, commander_id: null,
        response: null, responded_at: null, status: 'routed_upward' });
      logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
        action_type: 'reassign_blocked', entity_type: 'docket', entity_id: d.id, case_id: d.id,
        description: `Reassignment of ${d.cas_number} blocked — ${actor.name} approved a closure on this docket. Routed to the cluster commander.` });
      write(db);
      return { ok: false, code: 'separation', routedToCluster: true,
        error: 'You approved a closure on this docket, so you cannot also reassign it. The request has gone to the cluster commander.' };
    }

    const fullReason = reason === 'Other' ? `Other — ${detail.trim()}`
      : detail && detail.trim() ? `${reason} — ${detail.trim()}` : reason;
    const now = new Date().toISOString();
    const open = db.assignments.find(a => a.docket_id === d.id && a.is_active);
    const previous = open ? db.users.find(u => u.id === open.detective_id) : null;
    if (open) { open.is_active = false; open.unassigned_at = now; }
    db.assignments.push({ id: nextId(db.assignments), docket_id: d.id, detective_id: det.id,
      previous_detective_id: previous ? previous.id : null,
      assigned_by: actor.id, assigned_at: now,
      assignment_method: 'commander_override', is_active: true,
      reason_category: reason, override_reason: fullReason });
    d.detective_id = det.id;
    d.last_activity_at = now;

    const intake = db.intakes.find(i => i.id === d.intake_id);
    if (intake) notify(db, intake, `The officer investigating ${d.cas_number} has changed. ${det.name} is now handling it.`);

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'override', entity_type: 'assignment', entity_id: d.id, case_id: d.id,
      description: `${d.cas_number} reassigned to ${det.name} — ${fullReason}` });
    write(db);
    return { ok: true, docket: d, detective: det };
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

  /* ----- administration ----- */
  saveUser(payload, actor) {
    const db = read();
    let u = payload.id ? db.users.find(x => x.id === Number(payload.id)) : null;
    if (u) {
      Object.assign(u, payload);
      logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
        action_type: 'update', entity_type: 'user', entity_id: u.id,
        description: `Account updated: ${u.name}` });
    } else {
      u = { id: nextId(db.users), name: payload.name, email: payload.email,
            password: payload.password || 'demo1234', role: payload.role,
            rank: payload.rank || '', station_id: Number(payload.station_id),
            specialisation_id: payload.specialisation_id ? Number(payload.specialisation_id) : null,
            availability: 'available', max_caseload: 12, is_active: true, last_login: null };
      db.users.push(u);
      logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
        action_type: 'create', entity_type: 'user', entity_id: u.id,
        description: `Account created: ${u.name} (${labelRole(u.role)})` });
    }
    write(db);
    return u;
  },

  deactivateUser(id, actor) {
    const db = read();
    const u = db.users.find(x => x.id === Number(id));
    if (!u) return { ok: false, error: 'Account not found.' };
    const open = db.dockets.filter(d => d.detective_id === u.id && d.current_status !== 'closed');
    if (open.length) {
      return { ok: false, error: `${u.name} still holds ${open.length} open docket(s). Reassign them before deactivating this account.` };
    }
    const held = db.evidence.filter(e => e.current_holder_id === u.id);
    if (held.length) {
      return { ok: false, error: `${u.name} still holds ${held.length} exhibit(s). Transfer them before deactivating this account.` };
    }
    u.is_active = false;
    u.deactivated_at = new Date().toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'deactivate', entity_type: 'user', entity_id: u.id,
      description: `Account deactivated: ${u.name}. Activity record retained.` });
    write(db);
    return { ok: true };
  },

  /* ----- audit ----- */
  audit(filter = {}) {
    const db = read();
    return db.audit_log.filter(a =>
      (!filter.case_id || a.case_id === Number(filter.case_id)) &&
      (!filter.user_id || a.user_id === Number(filter.user_id)) &&
      (!filter.action_type || a.action_type === filter.action_type))
      .slice().reverse();
  },

  verifyChain() {
    const db = read();
    let prev = '00000000';
    for (const e of db.audit_log) {
      if (e.prev_hash !== prev) return { ok: false, at: e.id };
      const expect = shortHash(e.prev_hash + e.action_type + e.description + e.performed_at);
      if (expect !== e.entry_hash) return { ok: false, at: e.id };
      prev = e.entry_hash;
    }
    return { ok: true, entries: db.audit_log.length };
  },

  /* ----- oversight reports ----- */
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

/* ---------------- shared docket creation ----------------
   Used by the ordinary "open a docket" path and by the wrong-jurisdiction
   transfer, so a docket is registered the same way whichever door it came
   through, and the case number is issued before anything else happens. */
function openDocketInternal(db, intake, actor) {
  const station = db.stations.find(s => s.id === intake.station_id);
  const cat = db.categories.find(c => c.id === intake.category_id);
  const now = new Date().toISOString();

  const docket = {
    id: nextId(db.dockets),
    cas_number: newCasNumber(db, station.code),
    intake_id: intake.id,
    complainant_id: intake.complainant_id,
    category_id: intake.category_id,
    station_id: intake.station_id,
    registered_by: actor.id,
    current_status: 'registered',
    registered_at: now,
    last_activity_at: now,
    detective_id: null,
    closure_type: null,
    brought_forward_at: null,
    priority: cat ? cat.default_priority : 'Medium'
  };
  db.dockets.push(docket);

  intake.disposition = 'docket_opened';
  intake.disposed_at = now;
  intake.disposed_by = actor.id;
  intake.docket_id = docket.id;

  db.status_history.push({ id: nextId(db.status_history), docket_id: docket.id,
    previous_status: null, new_status: 'registered', changed_by: actor.id,
    changed_at: now, notes: 'Docket opened from report' });

  logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
    action_type: 'create', entity_type: 'docket', entity_id: docket.id, case_id: docket.id,
    description: `Docket opened from ${intake.intake_number}, ${docket.cas_number} issued — priority ${docket.priority} (auto by category)` });

  /* Witnesses the complainant named when reporting are carried onto the docket
     straight away. Otherwise they live only in the report text, and the
     closure checklist cannot see that anyone was ever identified. */
  (intake.witnesses_reported || []).forEach(w => {
    db.witnesses.push({ id: nextId(db.witnesses), docket_id: docket.id,
      name: w.name, contact: w.contact, identified_by: actor.id, identified_at: now,
      statement_text: '', statement_taken_at: null, no_statement_reason: '',
      reported_by_complainant: true });
  });

  // FR14 — auto-assign by crime category and lowest caseload
  const assigned = autoAssign(db, docket);
  return { docket, assigned };
}

/* Who took the decision a complainant is escalating about: the official who
   refused the report, or on a live case the detective holding it, falling back
   to whoever registered the docket. */
function decisionMakerFor(db, docketId, intakeId) {
  if (docketId) {
    const d = db.dockets.find(x => x.id === Number(docketId));
    if (d) return d.detective_id || d.registered_by || null;
  }
  if (intakeId) {
    const refusal = db.refusals.find(r => r.intake_id === Number(intakeId) && r.status === 'confirmed');
    if (refusal) return refusal.officer_id;
    const intake = db.intakes.find(i => i.id === Number(intakeId));
    if (intake) return intake.disposed_by || null;
  }
  return null;
}

/* ---------------- complainant notifications ----------------
   Every terminal state in the activity diagrams ends with the complainant
   being told. Recording it makes that promise checkable: if the notification
   is not in this table, it was not sent. */
function notify(db, intake, message) {
  const rec = { id: nextId(db.notifications), intake_id: intake.id,
    docket_id: intake.docket_id || null, message,
    created_at: new Date().toISOString() };
  db.notifications.push(rec);
  return rec;
}

/* ---------------- routing by incident location ----------------
   No mapping/geocoding service is wired up (this is a client-only prototype),
   so each station lists the suburbs/areas it covers and the incident location
   text is matched against them. Falls back to the first station if nothing
   matches, mirroring how a real intake desk would escalate an unclear address. */
function routeByLocation(db, locationText) {
  const text = String(locationText || '').toLowerCase();
  const match = db.stations.find(s => (s.service_areas || []).some(area => text.includes(area)));
  return match || db.stations[0];
}

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

/* ---------------- shared exhibit creation ----------------
   Used by both direct registration and accepted complainant submissions, so the
   mandatory-image rule cannot drift between the two entry points. */
function createExhibit(db, docket, actor, payload) {
  const ev = { id: nextId(db.evidence), docket_id: docket.id,
    exhibit_number: `EX-${docket.cas_number.slice(-6)}-${pad(db.evidence.filter(e => e.docket_id === docket.id).length + 1).slice(-3)}`,
    description: payload.description, evidence_type: payload.evidence_type,
    collected_by: actor.id, collected_at: new Date().toISOString(),
    current_holder_id: actor.id, storage_location: payload.storage_location || '',
    saps13_number: (payload.saps13_number || '').trim() || null,
    image_data_url: payload.image_data_url,
    suspect_name: payload.suspect_name || null,
    suspect_id_number: payload.suspect_id_number || null,
    suspect_photo_data_url: payload.suspect_photo_data_url || null,
    linked_arrest_id: payload.linked_arrest_id ? Number(payload.linked_arrest_id) : null };
  db.evidence.push(ev);
  db.custody.push({ id: nextId(db.custody), evidence_id: ev.id, from_user_id: null,
    to_user_id: actor.id, transferred_at: ev.collected_at,
    purpose: payload.custody_purpose || 'Initial collection', acknowledged: true });
  docket.last_activity_at = ev.collected_at;
  return ev;
}

/* ---------------- auto-assignment (FR14–FR16, FR18) ---------------- */

function autoAssign(db, docket) {
  const cat = db.categories.find(c => c.id === docket.category_id);
  const needed = cat ? cat.required_specialisation_id : null;

  const pool = db.users.filter(u =>
    u.role === 'detective' &&
    u.is_active &&
    u.station_id === docket.station_id &&
    u.availability === 'available' &&
    (!needed || u.specialisation_id === needed));

  const withLoad = pool.map(u => ({
    u, load: db.dockets.filter(d => d.detective_id === u.id && d.current_status !== 'closed').length
  })).filter(x => x.load < x.u.max_caseload);

  if (!withLoad.length) {
    logAudit(db, { action_type: 'assign_failed', entity_type: 'docket', entity_id: docket.id,
      case_id: docket.id,
      description: `${docket.cas_number} awaiting assignment — no available detective with ${cat ? cat.name : 'required'} specialisation` });
    docket.current_status = 'awaiting_assignment';
    return null;
  }

  withLoad.sort((a, b) => a.load - b.load);
  const pick = withLoad[0].u;

  db.assignments.push({ id: nextId(db.assignments), docket_id: docket.id, detective_id: pick.id,
    assigned_by: null, assigned_at: new Date().toISOString(),
    assignment_method: 'auto_by_category', is_active: true, override_reason: null });
  docket.detective_id = pick.id;

  logAudit(db, { action_type: 'assign', entity_type: 'assignment', entity_id: docket.id,
    case_id: docket.id,
    description: `${docket.cas_number} auto-assigned to ${pick.name} (${cat ? cat.name : 'general'}, lowest caseload)` });

  return pick;
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

/* ==========================================================================
   Seed data — enough to demonstrate every accountability feature, including
   one report deliberately left undisposed past the reconciliation threshold.
   ========================================================================== */

function seed() {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();

  const db = {
    counters: { intake: 0, cas: 0, complainant: 0 },
    stations: [
      { id: 1, name: 'Durban Central SAPS', code: 'DBN', province: 'KwaZulu-Natal',
        service_areas: ['durban central', 'smith street', 'glenwood', 'berea', 'overport',
          'morningside', 'umbilo', 'point', 'city centre', 'anton lembede'] },
      { id: 2, name: 'Umlazi SAPS', code: 'UML', province: 'KwaZulu-Natal',
        service_areas: ['umlazi'] },
      { id: 3, name: 'Pinetown SAPS', code: 'PTN', province: 'KwaZulu-Natal',
        service_areas: ['pinetown', 'westville', 'kloof', 'new germany'] }
    ],
    specialisations: [
      { id: 1, name: 'General Detective' },
      { id: 2, name: 'FCS (Family Violence, Child Protection and Sexual Offences)' },
      { id: 3, name: 'Commercial Crime' },
      { id: 4, name: 'Vehicle Crime' }
    ],
    categories: CATEGORIES.map(c => Object.assign({}, c)),
    users: [
      { id: 1, name: 'Sgt. M. Dlamini', email: 'official@saps.demo', password: 'demo1234',
        role: 'official', rank: 'Sergeant', station_id: 1, specialisation_id: null,
        availability: 'available', max_caseload: 0, is_active: true, last_login: null },
      { id: 2, name: 'Cst. T. Khumalo', email: 'official2@saps.demo', password: 'demo1234',
        role: 'official', rank: 'Constable', station_id: 1, specialisation_id: null,
        availability: 'available', max_caseload: 0, is_active: true, last_login: null },
      { id: 3, name: 'Det. S. Pillay', email: 'detective@saps.demo', password: 'demo1234',
        role: 'detective', rank: 'Detective Sergeant', station_id: 1, specialisation_id: 1,
        availability: 'available', max_caseload: 12, is_active: true, last_login: null },
      { id: 4, name: 'Det. N. Mthembu', email: 'detective2@saps.demo', password: 'demo1234',
        role: 'detective', rank: 'Detective Constable', station_id: 1, specialisation_id: 2,
        availability: 'on_leave', max_caseload: 10, is_active: true, last_login: null },
      { id: 5, name: 'Det. R. Naidoo', email: 'detective3@saps.demo', password: 'demo1234',
        role: 'detective', rank: 'Detective Sergeant', station_id: 1, specialisation_id: 4,
        availability: 'available', max_caseload: 12, is_active: true, last_login: null },
      { id: 6, name: 'Col. N. Zulu', email: 'commander@saps.demo', password: 'demo1234',
        role: 'commander', rank: 'Colonel', station_id: 1, specialisation_id: null,
        availability: 'available', max_caseload: 0, is_active: true, last_login: null },
      { id: 7, name: 'A. Sithole', email: 'admin@saps.demo', password: 'demo1234',
        role: 'admin', rank: 'System Administrator', station_id: 1, specialisation_id: null,
        availability: 'available', max_caseload: 0, is_active: true, last_login: null }
    ],
    complainants: [], intakes: [], dockets: [], refusals: [], escalations: [],
    assignments: [], status_history: [], notes: [], evidence: [], custody: [],
    arrests: [], handovers: [], audit_log: [], complainant_evidence: [], withdrawals: [],
    notifications: [], closures: [], transfers: []
  };

  /* --- seeded reports --- */
  const seeds = [
    { name: 'Thandeka Ngcobo', contact: '+27 82 555 0141', gender: 'Female', id_number: '8804120832087',
      cat: 1, station: 1, channel: 'public_web',
      loc: '14 Smith Street, Durban Central', desc: 'Handbag taken from a parked vehicle overnight.',
      age: 6, action: 'docket' },
    { name: 'Sipho Mabaso', contact: '+27 83 555 0192', gender: 'Male', id_number: '7905235190876',
      cat: 7, station: 1, channel: 'public_web',
      loc: '8 Broad Street, Glenwood', desc: 'Forced entry through a back window, television removed.',
      age: 40, action: 'docket_stale' },
    { name: 'Lerato Khoza', contact: '+27 71 555 0163', gender: 'Female', id_number: '9207140481083',
      cat: 6, station: 1, channel: 'station',
      loc: 'Parking garage, Anton Lembede Street', desc: 'Vehicle removed from a secured parking bay.',
      age: 12, action: 'docket' },
    { name: 'Bongani Zwane', contact: '+27 84 555 0128', gender: 'Male', id_number: '8511095732081',
      cat: 2, station: 1, channel: 'assisted',
      loc: 'Berea Road taxi rank', desc: 'Assaulted by two men following a dispute over a fare.',
      age: 30, action: 'refused' },
    { name: 'Nomsa Cele', contact: '+27 72 555 0175', gender: 'Female', id_number: '9001010923086',
      cat: 3, station: 1, channel: 'public_web',
      loc: 'Residential address, Overport', desc: 'Reported for assessment by FCS unit.',
      age: 54, action: 'pending' },
    { name: 'Ayanda Mkhize', contact: '+27 76 555 0119', gender: 'Female', id_number: '9503220614087',
      cat: 5, station: 1, channel: 'public_web',
      loc: 'Online transaction, Durban', desc: 'Funds transferred to a fraudulent account.',
      age: 3, action: 'pending' },
    { name: 'Precious Dube', contact: '+27 79 555 0187', gender: 'Female', id_number: '8207300257086',
      cat: 8, station: 1, channel: 'third_party',
      loc: 'School premises, Chatsworth', desc: 'Reported by school principal on behalf of the school.',
      age: 20, action: 'referred' }
  ];

  seeds.forEach(s => {
    const station = db.stations.find(x => x.id === s.station);
    const comp = { id: nextId(db.complainants), complainant_number: newComplainantNumber(db),
                   name: s.name, contact: s.contact, gender: s.gender, id_number: s.id_number,
                   verified_at: iso(now - s.age * 36e5) };
    db.complainants.push(comp);

    db.counters.intake += 1;
    const intake = {
      id: nextId(db.intakes),
      intake_number: `INT-2026-${station.code}-${pad(db.counters.intake)}`,
      complainant_id: comp.id, category_id: s.cat, station_id: station.id,
      channel: s.channel, incident_description: s.desc, incident_location: s.loc,
      incident_datetime: iso(now - (s.age + 4) * 36e5),
      created_by: s.channel === 'assisted' ? 1 : null,
      created_at: iso(now - s.age * 36e5),
      disposition: 'pending', disposed_at: null, disposed_by: null, docket_id: null
    };
    db.intakes.push(intake);

    logAudit(db, { action_type: 'create', entity_type: 'intake', entity_id: intake.id,
      performed_at: intake.created_at,
      description: `Report ${intake.intake_number} received via ${labelChannel(s.channel)}` });
    logAudit(db, { action_type: 'route', entity_type: 'intake', entity_id: intake.id,
      performed_at: intake.created_at,
      description: `Routed to ${station.name} on incident location` });

    if (s.action === 'docket' || s.action === 'docket_stale') {
      db.counters.cas += 1;
      const openedAt = iso(now - (s.age - 2) * 36e5);
      const docket = {
        id: nextId(db.dockets),
        cas_number: `CAS-2026-${station.code}-${pad(db.counters.cas)}`,
        intake_id: intake.id, complainant_id: comp.id, category_id: s.cat,
        station_id: station.id, registered_by: 1,
        current_status: s.action === 'docket_stale' ? 'under_investigation' : 'registered',
        registered_at: openedAt,
        last_activity_at: s.action === 'docket_stale' ? iso(now - 38 * 864e5) : openedAt,
        detective_id: null, closure_type: null,
        priority: (db.categories.find(c => c.id === s.cat) || {}).default_priority || 'Medium'
      };
      db.dockets.push(docket);
      intake.disposition = 'docket_opened';
      intake.disposed_at = openedAt; intake.disposed_by = 1; intake.docket_id = docket.id;

      db.status_history.push({ id: nextId(db.status_history), docket_id: docket.id,
        previous_status: null, new_status: 'registered', changed_by: 1,
        changed_at: openedAt, notes: 'Docket opened from report' });

      logAudit(db, { user_id: 1, user_name: 'Sgt. M. Dlamini', user_role: 'official',
        action_type: 'create', entity_type: 'docket', entity_id: docket.id, case_id: docket.id,
        performed_at: openedAt,
        description: `Docket opened from ${intake.intake_number}, ${docket.cas_number} issued` });

      autoAssign(db, docket);

      if (s.action === 'docket_stale') {
        db.status_history.push({ id: nextId(db.status_history), docket_id: docket.id,
          previous_status: 'registered', new_status: 'under_investigation', changed_by: 3,
          changed_at: iso(now - 38 * 864e5), notes: 'Statements being obtained from neighbours' });
      }
    }

    /* A refusal that has been proposed and signed off by a second person. */
    if (s.action === 'refused') {
      const at = iso(now - (s.age - 1) * 36e5);
      db.refusals.push({ id: nextId(db.refusals), intake_id: intake.id, station_id: station.id,
        officer_id: 2, reason_category: DUPLICATE_REASON,
        reason_detail: 'The same assault was already reported by the complainant three days earlier under CAS-2026-DBN-000001.',
        duplicate_of: 'CAS-2026-DBN-000001', status: 'confirmed',
        raised_at: at, refused_at: at, complainant_notified_at: at,
        cosigned_by: 1, cosigned_at: at, cosign_note: 'Duplicate verified against the original docket.' });
      intake.disposition = 'refused'; intake.disposed_at = at; intake.disposed_by = 2;
      notify(db, intake, `No docket was opened. Reason: ${DUPLICATE_REASON}.`);
      logAudit(db, { user_id: 1, user_name: 'Sgt. M. Dlamini', user_role: 'official',
        action_type: 'refusal', entity_type: 'intake', entity_id: intake.id, performed_at: at,
        description: `Refusal on ${intake.intake_number} signed off — ${DUPLICATE_REASON}` });
    }

    /* Wrong jurisdiction: registered here first, then transferred, so the
       complainant walks away holding a case number either way. */
    if (s.action === 'referred') {
      const at = iso(now - (s.age - 1) * 36e5);
      const to = db.stations.find(x => x.code === 'PTN');
      const opened = openDocketInternal(db, intake, { id: 2, name: 'Cst. T. Khumalo', role: 'official' });
      opened.docket.station_id = to.id;
      opened.docket.detective_id = null;
      opened.docket.registered_at = at;
      opened.docket.last_activity_at = at;
      db.assignments.filter(a => a.docket_id === opened.docket.id && a.is_active)
        .forEach(a => { a.is_active = false; a.unassigned_at = at; });
      db.transfers.push({ id: nextId(db.transfers), docket_id: opened.docket.id,
        from_station_id: station.id, to_station_id: to.id, transferred_by: 2,
        transferred_at: at, reason: 'Incident occurred within the Pinetown policing precinct.' });
      notify(db, intake, `Your case number is ${opened.docket.cas_number}. It was registered at ${station.name} and transferred to ${to.name}.`);
      logAudit(db, { user_id: 2, user_name: 'Cst. T. Khumalo', user_role: 'official',
        action_type: 'transfer', entity_type: 'docket', entity_id: opened.docket.id,
        case_id: opened.docket.id, performed_at: at,
        description: `${opened.docket.cas_number} registered at ${station.name} and transferred to ${to.name}` });
    }
  });

  /* --- an escalation raised by a complainant, still open --- */
  const stale = db.dockets.find(d => d.current_status === 'under_investigation');
  if (stale) {
    db.escalations.push({ id: nextId(db.escalations), docket_id: stale.id, intake_id: null,
      reason: 'No contact from the investigating officer since the case was opened.',
      raised_by_complainant: true, raised_at: iso(now - 5 * 864e5),
      commander_id: null, response: null, responded_at: null, status: 'open' });
    logAudit(db, { action_type: 'escalate', entity_type: 'escalation', entity_id: 1,
      case_id: stale.id, performed_at: iso(now - 5 * 864e5),
      description: 'Complainant raised escalation: no contact since the case was opened' });
  }

  /* --- system-raised escalation on the report deliberately left undisposed --- */
  const overdue = db.intakes.find(i => i.disposition === 'pending' &&
    (now - new Date(i.created_at).getTime()) > 24 * 36e5);
  if (overdue) {
    db.escalations.push({ id: nextId(db.escalations), docket_id: null, intake_id: overdue.id,
      reason: 'Report undisposed for more than 24 hours',
      raised_by_complainant: false, raised_at: iso(now - 30 * 36e5),
      commander_id: null, response: null, responded_at: null, status: 'open' });
    logAudit(db, { action_type: 'escalate', entity_type: 'escalation', entity_id: 2,
      performed_at: iso(now - 30 * 36e5),
      description: `System raised escalation: ${overdue.intake_number} undisposed for more than 24 hours` });
  }

  return db;
}
