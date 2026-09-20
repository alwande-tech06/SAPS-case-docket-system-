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

/* ---------------- core read / write ---------------- */

function read() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) { const fresh = seed(); write(fresh); return fresh; }
  try { return JSON.parse(raw); }
  catch (e) { const fresh = seed(); write(fresh); return fresh; }
}

function write(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

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
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  set(user) { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); },
  clear() { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); }
};

/* ==========================================================================
   Public API — grouped the way the Flask blueprints will be
   ========================================================================== */

const Store = {

  /* ----- meta ----- */
  all() { return read(); },
  reset() { localStorage.removeItem(DB_KEY); Session.clear(); },

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
      complainant_id: comp.id,
      category_id: Number(data.category_id),
      station_id: station.id,
      channel: data.channel || 'public_web',
      incident_description: data.description,
      incident_location: data.location,
      incident_datetime: data.incident_datetime,
      created_by: data.created_by || null,
      created_at: new Date().toISOString(),
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
  openDocket(intakeId, actor) {
    const db = read();
    const intake = db.intakes.find(i => i.id === intakeId);
    if (!intake || intake.disposition !== 'pending') return null;
    const station = db.stations.find(s => s.id === intake.station_id);
    const cat = db.categories.find(c => c.id === intake.category_id);

    const docket = {
      id: nextId(db.dockets),
      cas_number: newCasNumber(db, station.code),
      intake_id: intake.id,
      complainant_id: intake.complainant_id,
      category_id: intake.category_id,
      station_id: intake.station_id,
      registered_by: actor.id,
      current_status: 'registered',
      registered_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      detective_id: null,
      closure_type: null,
      priority: cat ? cat.default_priority : 'Medium'
    };
    db.dockets.push(docket);

    intake.disposition = 'docket_opened';
    intake.disposed_at = new Date().toISOString();
    intake.disposed_by = actor.id;
    intake.docket_id = docket.id;

    db.status_history.push({ id: nextId(db.status_history), docket_id: docket.id,
      previous_status: null, new_status: 'registered', changed_by: actor.id,
      changed_at: docket.registered_at, notes: 'Docket opened from report' });

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'create', entity_type: 'docket', entity_id: docket.id, case_id: docket.id,
      description: `Docket opened from ${intake.intake_number}, ${docket.cas_number} issued — priority ${docket.priority} (auto by category)` });

    // FR14 — auto-assign by crime category and lowest caseload
    const assigned = autoAssign(db, docket);
    write(db);
    return { docket, assigned };
  },

  recordRefusal(intakeId, actor, payload) {
    const db = read();
    const intake = db.intakes.find(i => i.id === intakeId);
    if (!intake || intake.disposition !== 'pending') return null;

    const rec = {
      id: nextId(db.refusals),
      intake_id: intake.id,
      station_id: intake.station_id,
      officer_id: actor.id,
      reason_category: payload.reason_category,
      reason_detail: payload.reason_detail,
      refused_at: new Date().toISOString(),
      complainant_notified_at: new Date().toISOString(),
      reviewed_by: null,
      reviewed_at: null
    };
    db.refusals.push(rec);

    intake.disposition = 'refused';
    intake.disposed_at = rec.refused_at;
    intake.disposed_by = actor.id;

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'refusal', entity_type: 'intake', entity_id: intake.id,
      description: `Refusal recorded on ${intake.intake_number} — ${payload.reason_category}` });
    write(db);
    return rec;
  },

  recordReferral(intakeId, actor, payload) {
    const db = read();
    const intake = db.intakes.find(i => i.id === intakeId);
    if (!intake || intake.disposition !== 'pending') return null;

    const rec = {
      id: nextId(db.refusals),
      intake_id: intake.id,
      station_id: intake.station_id,
      officer_id: actor.id,
      reason_category: 'Referred — jurisdiction',
      reason_detail: payload.reason_detail,
      referred_to_station: payload.referred_to_station,
      refused_at: new Date().toISOString(),
      complainant_notified_at: new Date().toISOString()
    };
    db.refusals.push(rec);

    intake.disposition = 'referred';
    intake.disposed_at = rec.refused_at;
    intake.disposed_by = actor.id;

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'referral', entity_type: 'intake', entity_id: intake.id,
      description: `Referred ${intake.intake_number} to ${payload.referred_to_station}` });
    write(db);
    return rec;
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
    const prev = d.current_status;
    d.current_status = newStatus;
    d.last_activity_at = new Date().toISOString();
    if (newStatus === 'closed') d.closure_type = notes || 'Finalised';

    db.status_history.push({ id: nextId(db.status_history), docket_id: d.id,
      previous_status: prev, new_status: newStatus, changed_by: actor.id,
      changed_at: d.last_activity_at, notes: notes || '' });

    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'status_change', entity_type: 'docket', entity_id: d.id, case_id: d.id,
      description: `${d.cas_number}: ${labelStatus(prev)} to ${labelStatus(newStatus)}` });
    write(db);
    return d;
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
      return { ok: false, error: 'Describe the exhibit before it can be recorded.' };
    }
    if (!payload.image_data_url) {
      return { ok: false, error: 'A photograph of the exhibit (or a scanned copy, for a document) is required before it can be recorded.' };
    }

    const suspectFields = [payload.suspect_name, payload.suspect_id_number, payload.suspect_photo_data_url];
    if (suspectFields.some(f => f) && !suspectFields.every(f => f)) {
      return { ok: false, error: 'To link a suspect, their name, ID number and photograph are all required.' };
    }
    if (payload.suspect_id_number && !/^\d{13}$/.test(payload.suspect_id_number)) {
      return { ok: false, error: "The suspect's ID number must be 13 digits." };
    }
    if (payload.linked_arrest_id &&
        !db.arrests.some(a => a.id === Number(payload.linked_arrest_id) && a.docket_id === d.id)) {
      return { ok: false, error: 'The charge you linked does not belong to this case.' };
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

  reviewComplainantEvidence(id, actor, decision, note) {
    const db = read();
    const ce = db.complainant_evidence.find(e => e.id === Number(id));
    if (!ce) return null;
    if (decision === 'rejected' && !(note || '').trim()) {
      return { ok: false, error: 'A reason is required to reject submitted evidence.' };
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
    const rec = { id: nextId(db.escalations), docket_id: payload.docket_id || null,
      intake_id: payload.intake_id || null, reason: payload.reason,
      raised_by_complainant: payload.raised_by_complainant !== false,
      raised_at: new Date().toISOString(), commander_id: null,
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
    e.commander_id = actor.id;
    e.response = `${outcome} — ${response}`;
    e.responded_at = new Date().toISOString();
    e.status = 'responded';
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'escalation_response', entity_type: 'escalation', entity_id: e.id,
      case_id: e.docket_id, description: `Escalation answered: ${outcome}` });
    write(db);
    return e;
  },

  escalations(filter = {}) {
    const db = read();
    return db.escalations.filter(e => !filter.status || e.status === filter.status);
  },

  /* ----- assignment ----- */
  reassign(docketId, detectiveId, actor, reason) {
    const db = read();
    const d = db.dockets.find(x => x.id === Number(docketId));
    const det = db.users.find(u => u.id === Number(detectiveId));
    if (!d || !det) return null;
    const open = db.assignments.find(a => a.docket_id === d.id && a.is_active);
    if (open) { open.is_active = false; open.unassigned_at = new Date().toISOString(); }
    db.assignments.push({ id: nextId(db.assignments), docket_id: d.id, detective_id: det.id,
      assigned_by: actor.id, assigned_at: new Date().toISOString(),
      assignment_method: 'commander_override', is_active: true, override_reason: reason });
    d.detective_id = det.id;
    d.last_activity_at = new Date().toISOString();
    logAudit(db, { user_id: actor.id, user_name: actor.name, user_role: actor.role,
      action_type: 'override', entity_type: 'assignment', entity_id: d.id, case_id: d.id,
      description: `${d.cas_number} reassigned to ${det.name} — ${reason}` });
    write(db);
    return d;
  },

  assignments(docketId) { return read().assignments.filter(a => a.docket_id === Number(docketId)); },

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

  staleDockets(stationId, days = 30) {
    const db = read();
    const cut = Date.now() - days * 864e5;
    return db.dockets.filter(d =>
      (!stationId || d.station_id === stationId) &&
      d.current_status !== 'closed' &&
      new Date(d.last_activity_at).getTime() < cut);
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

/* Case-sensitive on purpose: the name given when tracking must match the one
   captured on the report exactly, capitals included. Only whitespace is
   normalised, because trailing spaces and double spaces are invisible on screen
   and a complainant could never see what to correct. */
function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
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
    categories: [
      { id: 1, name: 'Theft', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
      { id: 2, name: 'Common assault', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
      { id: 3, name: 'Sexual offence', required_specialisation_id: 2, sla_days: 14, default_priority: 'Critical', protected_from_withdrawal: true },
      { id: 4, name: 'Domestic violence', required_specialisation_id: 2, sla_days: 14, default_priority: 'High', protected_from_withdrawal: true },
      { id: 5, name: 'Fraud', required_specialisation_id: 3, sla_days: 45, default_priority: 'Medium', protected_from_withdrawal: false },
      { id: 6, name: 'Vehicle theft', required_specialisation_id: 4, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
      { id: 7, name: 'Burglary', required_specialisation_id: 1, sla_days: 30, default_priority: 'Medium', protected_from_withdrawal: false },
      { id: 8, name: 'Malicious damage to property', required_specialisation_id: 1, sla_days: 30, default_priority: 'Low', protected_from_withdrawal: false }
    ],
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
    arrests: [], handovers: [], audit_log: [], complainant_evidence: [], withdrawals: []
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

    if (s.action === 'refused') {
      const at = iso(now - (s.age - 1) * 36e5);
      db.refusals.push({ id: nextId(db.refusals), intake_id: intake.id, station_id: station.id,
        officer_id: 2, reason_category: 'Insufficient evidence',
        reason_detail: 'Complainant unable to identify either party and no witnesses were present at the time.',
        refused_at: at, complainant_notified_at: at, reviewed_by: null, reviewed_at: null });
      intake.disposition = 'refused'; intake.disposed_at = at; intake.disposed_by = 2;
      logAudit(db, { user_id: 2, user_name: 'Cst. T. Khumalo', user_role: 'official',
        action_type: 'refusal', entity_type: 'intake', entity_id: intake.id, performed_at: at,
        description: `Refusal recorded on ${intake.intake_number} — Insufficient evidence` });
    }

    if (s.action === 'referred') {
      const at = iso(now - (s.age - 1) * 36e5);
      db.refusals.push({ id: nextId(db.refusals), intake_id: intake.id, station_id: station.id,
        officer_id: 2, reason_category: 'Referred — jurisdiction',
        reason_detail: 'Incident occurred within the Chatsworth policing precinct.',
        referred_to_station: 'Chatsworth SAPS', refused_at: at, complainant_notified_at: at });
      intake.disposition = 'referred'; intake.disposed_at = at; intake.disposed_by = 2;
      logAudit(db, { user_id: 2, user_name: 'Cst. T. Khumalo', user_role: 'official',
        action_type: 'referral', entity_type: 'intake', entity_id: intake.id, performed_at: at,
        description: `Referred ${intake.intake_number} to Chatsworth SAPS` });
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
