"""Dockets: registration, assignment, investigation, closure and reopening.

Ported from app/static/js/store.js. The messages and blocking codes are the
same, because the pages turn the codes into "Why is this blocked?" links.
Results are dicts in the shape the pages already read ({'ok': ..., ...}).
"""
from ..extensions import db
from datetime import datetime, timezone

from ..models import (Arrest, Assignment, Category, Closure, Counter, Custody, Docket, DocketMovement, Escalation,
                      Evidence, Forensic, Handover, Intake, Note, Station, StatusHistory, SupervisoryReview, User,
                      Witness, Withdrawal)
from .common import (FILING_CATEGORIES, MIN_REASON_LENGTH, REASSIGNMENT_REASONS, REOPEN_TRIGGERS, ROLE_PAGE, ActionError,
                     add_months, audit, label_role, label_status, notify, now, store_data_url, tell, tell_role, text,
                     user_name)

# What a diary entry records, beyond free text.
DIARY_ENTRY_TYPES = {
    'investigation_note': 'Investigation note',
    'witness_interview': 'Witness interview',
    'evidence_catalogued': 'Evidence catalogued',
    'court_update': 'Court or NPA update',
    'complainant_update': 'Complainant updated',
}

REVIEW_OUTCOMES = {
    'satisfactory': 'Investigation satisfactory',
    'further_directives': 'Further directives issued',
    'ready_for_court': 'Ready for NPA / court referral',
    'closure_recommended': 'Docket closure recommended',
}


# ----- access -----

def get_docket(docket_id, actor, detective_must_hold=True):
    """The docket, if this person may act on it: same station, and for a
    detective, the one it is assigned to."""
    d = db.session.get(Docket, int(docket_id)) if str(docket_id).isdigit() else None
    if d is None:
        raise ActionError('Case not found.', 404)
    if actor is not None:
        if actor.role != 'admin' and d.station_id != actor.station_id:
            raise ActionError('That case belongs to another station.')
        if detective_must_hold and actor.role == 'detective' and d.detective_id != actor.id:
            raise ActionError('Only the detective assigned to this case can do that.')
    return d


def _open_instructions(d):
    return Note.query.filter_by(docket_id=d.id, note_type='instruction', status='open').all()


def _history(d, prev, new, actor, when, notes=''):
    db.session.add(StatusHistory(docket_id=d.id, previous_status=prev, new_status=new,
                                 changed_by=actor.id if actor else None, changed_at=when, notes=notes))


# ----- registration and assignment -----

def auto_assign(docket, when=None):
    """FR14–FR16: a detective of the required specialisation at the docket's
    station, available, under their caseload limit, lowest caseload first."""
    when = when or now()
    cat = db.session.get(Category, docket.category_id)
    needed = cat.required_specialisation_id if cat else None
    pool = User.query.filter_by(role='detective', is_active=True, station_id=docket.station_id,
                                availability='available')
    if needed:
        pool = pool.filter_by(specialisation_id=needed)
    loads = []
    for u in pool.order_by(User.id):
        load = Docket.query.filter(Docket.detective_id == u.id, Docket.current_status != 'closed').count()
        if load < u.max_caseload:
            loads.append((load, u.id, u))
    if not loads:
        audit('assign_failed', f'{docket.cas_number} awaiting assignment — no available detective with '
              f'{cat.name if cat else "required"} specialisation', entity_type='docket',
              entity_id=docket.id, case_id=docket.id, performed_at=when)
        docket.current_status = 'awaiting_assignment'
        return None
    pick = sorted(loads, key=lambda x: (x[0], x[1]))[0][2]
    db.session.add(Assignment(docket_id=docket.id, detective_id=pick.id, assigned_by=None, assigned_at=when,
                              assignment_method='auto_by_category', is_active=True))
    docket.detective_id = pick.id
    send_docket(docket, docket.registered_by, pick, 'Allocated automatically by crime category', when)
    audit('assign', f'{docket.cas_number} auto-assigned to {pick.name} ({cat.name if cat else "general"}, '
          'lowest caseload)', entity_type='assignment', entity_id=docket.id, case_id=docket.id, performed_at=when)
    return pick


def open_docket_internal(intake, actor, when=None):
    """One way to register a docket, whichever door the report came through;
    the case number is issued before anything else happens."""
    when = when or now()
    station = db.session.get(Station, intake.station_id)
    cat = db.session.get(Category, intake.category_id)
    n = Counter.next('cas')
    d = Docket(cas_number=f'CAS-{when.year}-{station.code}-{n:06d}', intake_id=intake.id,
               complainant_id=intake.complainant_id, category_id=intake.category_id, station_id=intake.station_id,
               registered_by=actor.id, current_status='registered', registered_at=when, last_activity_at=when,
               priority=cat.default_priority if cat else 'Medium')
    db.session.add(d)
    db.session.flush()

    intake.disposition = 'docket_opened'
    intake.disposed_at = when
    intake.disposed_by = actor.id
    intake.docket_id = d.id
    _history(d, None, 'registered', actor, when, 'Docket opened from report')
    audit('create', f'Docket opened from {intake.intake_number}, {d.cas_number} issued — priority '
          f'{d.priority} (auto by category)', actor, entity_type='docket', entity_id=d.id, case_id=d.id,
          performed_at=when)
    for w in intake.witnesses_reported or []:
        db.session.add(Witness(docket_id=d.id, name=w['name'], contact=w.get('contact', ''),
                               identified_by=actor.id, identified_at=when, reported_by_complainant=True))
    assigned = auto_assign(d, when)
    return d, assigned


SUPERSEDED = 'Superseded: the docket was moved again before it was signed for.'


def send_docket(docket, from_user_id, to_user, reason, when=None, message=None):
    """Records the docket leaving one person for another. The receiver must
    acknowledge it; an earlier movement nobody signed for is superseded."""
    when = when or now()
    for m in DocketMovement.query.filter_by(docket_id=docket.id, acknowledged_at=None):
        m.acknowledgement_note = SUPERSEDED
        m.acknowledged_at = when
    db.session.add(DocketMovement(docket_id=docket.id, from_user_id=from_user_id, to_user_id=to_user.id,
                                  reason=reason, sent_at=when))
    tell([to_user.id], 'docket',
         message or f'{docket.cas_number} has been allocated to you. Acknowledge receipt of the docket.',
         ROLE_PAGE.get(to_user.role))


def custodian_id(docket):
    """Who holds the docket: the last person to sign for it. Sending a docket
    does not hand over custody — it stays with the sender until the receiver
    signs. Before anyone has signed, it is with whoever first sent it on."""
    moves = DocketMovement.query.filter_by(docket_id=docket.id).order_by(DocketMovement.id).all()
    signed = [m for m in moves if m.acknowledged_at and m.acknowledgement_note != SUPERSEDED]
    if signed:
        return signed[-1].to_user_id
    return moves[0].from_user_id if moves else None


def transfer_docket(docket_id, actor, to_user_id, reason):
    """The person holding the docket sends it on — to the station commander
    for inspection, or back to the officer investigating it. Who investigates
    does not change: giving a docket to a different detective is a
    reassignment, and only the commander makes those."""
    d = get_docket(docket_id, actor, detective_must_hold=False)
    if d.current_status == 'closed':
        return {'ok': False, 'error': 'A filed docket is not moved. Reopen it first.'}
    waiting = DocketMovement.query.filter_by(docket_id=d.id, acknowledged_at=None).first()
    if waiting is not None:
        to = db.session.get(User, waiting.to_user_id)
        return {'ok': False, 'code': 'in_transit',
                'error': f'This docket is already on its way to {to.name} and has not been signed for yet.'}
    if custodian_id(d) != actor.id:
        return {'ok': False, 'code': 'not_custodian', 'error': 'Only the person who holds the docket may send it on.'}
    to = db.session.get(User, int(to_user_id)) if str(to_user_id).isdigit() else None
    if to is None or not to.is_active or to.station_id != d.station_id or to.id == actor.id:
        return {'ok': False, 'error': 'Choose who the docket is going to.'}
    if to.role != 'commander' and to.id != d.detective_id:
        return {'ok': False, 'code': 'recipient',
                'error': 'A docket goes to the station commander or back to its investigating officer. '
                         'Giving it to another detective is a reassignment, which the commander makes.'}
    reason = text(reason)
    if len(reason) < 10:
        return {'ok': False, 'error': 'Record why the docket is being sent.'}
    when = now()
    send_docket(d, actor.id, to, reason, when,
                f'{actor.name} has sent you {d.cas_number}. Acknowledge receipt of the docket.')
    d.last_activity_at = when
    audit('docket_sent', f'{actor.name} sent {d.cas_number} to {to.name}; acknowledgement required — {reason}', actor,
          entity_type='docket', entity_id=d.id, case_id=d.id)
    return {'ok': True, 'to': to.to_dict()}


def acknowledge_docket(docket_id, actor, note=''):
    """The receiver signs for the docket (NI 3/2011 s1.4.10). Only the person
    it was sent to can, and custody passes to them at that moment."""
    d = get_docket(docket_id, actor, detective_must_hold=False)
    m = DocketMovement.query.filter_by(docket_id=d.id, to_user_id=actor.id, acknowledged_at=None) \
        .order_by(DocketMovement.id.desc()).first()
    if m is None:
        return {'ok': False, 'error': 'There is no docket movement waiting for your signature on this case.'}
    when = now()
    m.acknowledged_at, m.acknowledgement_note = when, text(note) or None
    d.last_activity_at = when
    sender = db.session.get(User, m.from_user_id) if m.from_user_id else None
    audit('docket_acknowledged',
          f'{actor.name} acknowledged receipt of {d.cas_number}' + (f' from {sender.name}' if sender else ''), actor,
          entity_type='docket', entity_id=d.id, case_id=d.id)
    if sender is not None:
        tell([sender.id], 'docket', f'{actor.name} has signed for {d.cas_number}.', ROLE_PAGE.get(sender.role))
    return {'ok': True, 'movement': m.to_dict()}


# ----- status -----

def update_status(docket_id, actor, new_status, notes=''):
    d = get_docket(docket_id, actor)
    # Closing goes through a request and a commander's approval, never through here.
    if new_status == 'closed' or new_status not in ('registered', 'awaiting_assignment', 'under_investigation',
                                                    'sent_to_prosecutor'):
        return None
    when = now()
    prev = d.current_status
    d.current_status = new_status
    d.last_activity_at = when
    _history(d, prev, new_status, actor, when, notes or '')
    audit('status_change', f'{d.cas_number}: {label_status(prev)} to {label_status(new_status)}', actor,
          entity_type='docket', entity_id=d.id, case_id=d.id)
    return d.to_dict()


# ----- closure -----

def closure_blocker(d, category_key, payload):
    def block(code, message):
        return {'code': code, 'message': message}
    if d.current_status == 'closed':
        return block('closure_status', 'This case is already closed.')
    if d.current_status != 'under_investigation':
        return block('closure_status', 'A docket cannot be closed before it has been investigated.')
    if category_key == 'undetected':
        if not Note.query.filter_by(docket_id=d.id).count() or not Evidence.query.filter_by(docket_id=d.id).count():
            return block('closure_evidence',
                         'Undetected requires investigation diary entries and at least one evidence item on the docket.')
        return None
    if category_key == 'pending_arrest':
        return None if text(payload.get('warrant_reference')) else \
            block('filing_categories', 'A circulated warrant of arrest reference is required.')
    if category_key == 'pending_recovery':
        return None if text(payload.get('circulation_reference')) else \
            block('filing_categories', 'A property circulation reference is required.')
    if category_key == 'withdrawn':
        approved = Withdrawal.query.filter_by(intake_id=d.intake_id, status='decided', decision='approved').count()
        return None if approved else block(
            'withdrawal', "SAPS may not withdraw a case on the complainant's behalf. The complainant must request "
                          'withdrawal and the commander must approve it first.')
    if category_key == 'evidence_compromised':
        if not text(payload.get('discrepancy_report')):
            return block('filing_categories', 'A discrepancy report is required.')
        any_custody = db.session.query(Custody.id).join(Evidence, Custody.evidence_id == Evidence.id) \
            .filter(Evidence.docket_id == d.id).first()
        return None if any_custody else block('exhibit',
                                              'A custody log entry is required before evidence can be reported compromised.')
    if category_key == 'sent_to_court':
        return None if text(payload.get('prosecutor_reference')) else block(
            'filing_categories', 'The prosecutor reference is required. The decision to prosecute belongs to the NPA.')
    return block('filing_categories', 'Choose a filing category.')


def request_closure(docket_id, actor, payload):
    d = get_docket(docket_id, actor)
    cat = next((c for c in FILING_CATEGORIES if c['key'] == payload.get('category')), None)
    if not cat:
        return {'ok': False, 'code': 'filing_categories', 'error': 'Choose a filing category.'}
    if Closure.query.filter_by(docket_id=d.id, status='pending_approval').count():
        return {'ok': False, 'code': 'closure_request',
                'error': 'A closure request on this case is already awaiting approval.'}
    blocker = closure_blocker(d, cat['key'], payload)
    if blocker:
        return {'ok': False, 'code': blocker['code'], 'error': blocker['message']}

    when = now()
    rec = Closure(docket_id=d.id, category=cat['key'], category_label=cat['label'], requested_by=actor.id,
                  requested_at=when,
                  warrant_reference=text(payload.get('warrant_reference')) or None,
                  circulation_reference=text(payload.get('circulation_reference')) or None,
                  discrepancy_report=text(payload.get('discrepancy_report')) or None,
                  prosecutor_reference=text(payload.get('prosecutor_reference')) or None,
                  motivation=text(payload.get('motivation')), status='pending_approval')
    db.session.add(rec)
    d.last_activity_at = when
    # Evidence going missing is a supervisor matter whatever happens to the request.
    if cat['key'] == 'evidence_compromised':
        db.session.add(Escalation(docket_id=d.id, reason=f'Evidence missing or compromised on {d.cas_number} — '
                                                         f'{rec.discrepancy_report}',
                                  raised_by_complainant=False, raised_at=when, decision_maker_id=actor.id,
                                  status='open'))
    db.session.flush()
    tell_role(d.station_id, 'commander', 'closure', f'Closure requested on {d.cas_number} — {cat["label"]}.')
    audit('closure_requested', f'Closure requested on {d.cas_number} — {cat["label"]}. Awaiting commander approval.',
          actor, entity_type='docket', entity_id=d.id, case_id=d.id)
    return {'ok': True, 'closure': rec.to_dict()}


def closure_checklist(c, approver_id):
    """The commander's inspection: each item is a guard, checked against the
    docket's own record."""
    d = db.session.get(Docket, c.docket_id)
    intake = db.session.get(Intake, d.intake_id)
    items = []

    instructions = Note.query.filter_by(docket_id=d.id, note_type='instruction').order_by(Note.id).all()
    open_ = [n for n in instructions if n.status == 'open']
    items.append({'key': 'instructions', 'code': 'closure_diary',
                  'label': 'Every instruction in the investigation diary was executed or explained',
                  'ok': not open_,
                  'detail': f'{len(instructions)} instruction(s); {len(open_)} still open' if instructions
                  else 'No instructions were written in the diary',
                  'missing': [n.note_text for n in open_]})

    witnesses = Witness.query.filter_by(docket_id=d.id).all()
    gaps = [w for w in witnesses if not w.statement_text and not w.no_statement_reason]
    statement = bool(intake and text(intake.incident_description))
    items.append({'key': 'statements', 'code': 'closure_evidence',
                  'label': 'Statements from the complainant and all identified witnesses are in the docket',
                  'ok': statement and not gaps,
                  'detail': f'Complainant statement {"on file" if statement else "missing"}; {len(witnesses)} '
                            f'witness(es) identified, {len(gaps)} with neither a statement nor a reason',
                  'missing': ([] if statement else ["The complainant's statement is not in the docket"])
                  + [f'No statement and no reason recorded for {w.name}' for w in gaps]})

    forensics = Forensic.query.filter_by(docket_id=d.id).all()
    fgaps = [f for f in forensics if not f.result and not f.accounted_for_reason]
    items.append({'key': 'forensics', 'code': 'closure_evidence',
                  'label': 'Forensic and other evidence was submitted, and results are back or accounted for',
                  'ok': not fgaps,
                  'detail': f'{len(forensics)} submission(s); {len(fgaps)} with no result and no explanation'
                  if forensics else 'Nothing was submitted for forensic analysis',
                  'missing': [f'{f.description} ({f.lab_reference}) — no result, not accounted for' for f in fgaps]})

    exhibits = Evidence.query.filter_by(docket_id=d.id).all()
    egaps = []
    for e in exhibits:
        if not e.saps13_number:
            egaps.append(f'{e.exhibit_number} has no SAPS 13 register number')
        if not Custody.query.filter_by(evidence_id=e.id).count():
            egaps.append(f'{e.exhibit_number} has no custody entry')
        if not e.current_holder_id:
            egaps.append(f'{e.exhibit_number} is held by nobody')
    items.append({'key': 'exhibits', 'code': 'exhibit',
                  'label': 'Exhibits are properly registered, with the chain of custody intact',
                  'ok': not egaps,
                  'detail': f'{len(exhibits)} exhibit(s) on the docket' if exhibits else 'No exhibits on the docket',
                  'missing': egaps})

    suspect = Arrest.query.filter_by(docket_id=d.id).count() or any(e.suspect_id_number for e in exhibits)
    needs = c.category in ('pending_arrest', 'pending_recovery') or (c.category == 'undetected' and suspect)
    ref = c.warrant_reference or c.circulation_reference
    items.append({'key': 'circulation', 'code': 'closure_evidence',
                  'label': 'Circulation was done where a suspect or property is outstanding',
                  'ok': not needs or bool(ref),
                  'detail': (f'Circulated under {ref}' if ref else 'A circulation reference is required and none is recorded')
                  if needs else 'No suspect or property is outstanding on this filing',
                  'missing': ['A suspect or property is outstanding but no circulation reference is recorded']
                  if needs and not ref else []})

    items.append({'key': 'separation', 'code': 'separation', 'label': 'The requesting detective is not the approver',
                  'ok': approver_id is None or c.requested_by != approver_id,
                  'detail': f'Requested by {user_name(c.requested_by)}',
                  'missing': ['You requested this closure, so you cannot approve it']
                  if approver_id is not None and c.requested_by == approver_id else []})

    items.append({'key': 'notify', 'code': 'approve_closure',
                  'label': "The complainant is notified of the outcome and the reason (Victims' Charter)",
                  'ok': True, 'informational': True,
                  'detail': 'Sent automatically on approval, with the filing category and your reason', 'missing': []})
    blocking = [i for i in items if not i.get('informational') and not i['ok']]
    return items, blocking


def decide_closure(closure_id, actor, decision, reason):
    c = db.session.get(Closure, int(closure_id)) if str(closure_id).isdigit() else None
    if c is None or c.status != 'pending_approval':
        return {'ok': False, 'error': 'That closure request has already been decided.'}
    d = get_docket(c.docket_id, actor)
    # The commander's screen sends 'refused'; anything but approval sends the docket back.
    if decision not in ('approved', 'refused', 'rejected'):
        return {'ok': False, 'code': 'approve_closure', 'error': 'Choose whether to approve or refuse the closure.'}
    if c.requested_by == actor.id:
        return {'ok': False, 'code': 'separation',
                'error': 'The investigating officer who requested a closure cannot approve it.'}
    if not text(reason):
        return {'ok': False, 'code': 'approve_closure', 'error': 'A reason is required for this decision.'}
    if decision == 'approved':
        items, blocking = closure_checklist(c, actor.id)
        if blocking:
            return {'ok': False, 'code': blocking[0]['code'] or 'approve_closure', 'blocking': blocking,
                    'error': 'This docket does not yet satisfy the closure checklist: '
                             + '; '.join(b['label'] for b in blocking)}

    when = now()
    intake = db.session.get(Intake, d.intake_id)
    c.status, c.decision, c.decided_by, c.decided_at, c.decision_reason = \
        'decided', decision, actor.id, when, text(reason)
    if decision == 'approved':
        c.approved_by, c.approved_at = actor.id, when
        c.checklist_confirmed = [{'key': i['key'], 'ok': i['ok']} for i in items if not i.get('informational')]
        prev = d.current_status
        d.current_status, d.closure_type, d.last_activity_at = 'closed', c.category_label, when
        cat = next((x for x in FILING_CATEGORIES if x['key'] == c.category), None)
        if cat and cat.get('brought_forward_months'):
            d.brought_forward_at = add_months(when, cat['brought_forward_months'])
        _history(d, prev, 'closed', actor, when, f'{c.category_label} — {c.decision_reason}')
        if intake:
            notify(intake, f'Your case {d.cas_number} has been filed: {c.category_label}. Reason: {c.decision_reason}. '
                           'If you disagree, you may escalate this from your tracking page.', when)
    else:
        d.last_activity_at = when
    db.session.flush()
    tell([c.requested_by], 'closure', f'Your closure request on {d.cas_number} was '
         f'{"approved" if decision == "approved" else "refused"}: {c.decision_reason}', '/dashboard-detective')
    audit('closure_approved' if decision == 'approved' else 'closure_rejected',
          f'Closure of {d.cas_number} {decision} by {actor.name} ({label_role(actor.role)}) on '
          f'{when.isoformat()} — category: {c.category_label}; detective\'s motivation: {c.motivation or "—"}; '
          f'commander\'s reason: {c.decision_reason}'
          + (f'; brought forward for review on {d.brought_forward_at.isoformat()}' if d.brought_forward_at else ''),
          actor, entity_type='docket', entity_id=d.id, case_id=d.id, performed_at=when)
    return {'ok': True, 'closure': c.to_dict()}


# ----- reopening -----

def reopen_docket(d, actor, payload):
    if d.current_status != 'closed':
        return {'ok': False, 'error': 'This case is not filed.'}
    trigger = payload.get('trigger') or 'manual'
    if trigger == 'manual' and not text(payload.get('new_evidence')):
        return {'ok': False, 'error': 'A manual reopening requires new evidence or new information.'}
    if trigger != 'manual' and trigger not in REOPEN_TRIGGERS:
        return {'ok': False, 'error': 'Unknown reason for reopening.'}
    when = now()
    prev = d.current_status
    d.current_status, d.closure_type, d.brought_forward_at, d.last_activity_at = \
        'under_investigation', None, None, when
    why = text(payload.get('new_evidence')) if trigger == 'manual' else REOPEN_TRIGGERS[trigger]
    _history(d, prev, 'under_investigation', actor, when, f'Reopened — {why}')
    assigned = None if d.detective_id else auto_assign(d, when)
    intake = db.session.get(Intake, d.intake_id)
    if intake:
        notify(intake, f'Your case {d.cas_number} has been reopened. Reason: {why}.', when)
    audit('reopen', f'{d.cas_number} reopened — {why}', actor, entity_type='docket', entity_id=d.id, case_id=d.id)
    return {'ok': True, 'docket': d.to_dict(), 'assigned': assigned.to_dict() if assigned else None}


def reopen_by_staff(docket_id, actor, payload):
    return reopen_docket(get_docket(docket_id, actor), actor, payload)


def note_brought_forward_review(docket_id, actor):
    d = get_docket(docket_id, actor)
    if d.current_status != 'closed':
        return {'ok': False, 'error': 'This case is not filed.'}
    d.brought_forward_at = add_months(now(), 12)
    audit('brought_forward_review', f'Brought-forward review of {d.cas_number} — nothing new, remains filed', actor,
          entity_type='docket', entity_id=d.id, case_id=d.id)
    return {'ok': True, 'docket': d.to_dict()}


# ----- the investigation diary -----

def add_note(docket_id, actor, note_text, entry=None):
    """A diary entry. `entry` may add what kind of entry it is, what came of
    the action, and what happens next; plain text alone still works."""
    d = get_docket(docket_id, actor)
    entry = entry or {}
    if not text(note_text):
        return None
    entry_type = entry.get('entry_type') if entry.get('entry_type') in DIARY_ENTRY_TYPES else 'investigation_note'
    when = now()
    db.session.add(Note(docket_id=d.id, author_id=actor.id, note_text=text(note_text), entry_type=entry_type,
                        outcome=text(entry.get('outcome')) or None, next_action=text(entry.get('next_action')) or None,
                        created_at=when))
    d.last_activity_at = when
    audit('update', f'{DIARY_ENTRY_TYPES[entry_type]} added to the diary of {d.cas_number}', actor,
          entity_type='note', entity_id=d.id, case_id=d.id)
    return None


def add_instruction(docket_id, actor, instruction):
    d = get_docket(docket_id, actor)
    if actor.role != 'commander':
        return {'ok': False, 'error': 'Only the station commander writes instructions in the investigation diary.'}
    if not text(instruction):
        return {'ok': False, 'error': 'An instruction cannot be empty.'}
    when = now()
    rec = Note(docket_id=d.id, author_id=actor.id, note_text=text(instruction), note_type='instruction',
               status='open', response='', created_at=when)
    db.session.add(rec)
    d.last_activity_at = when
    db.session.flush()
    tell([d.detective_id], 'instruction', f'The station commander wrote an instruction on {d.cas_number}.',
         '/dashboard-detective')
    audit('instruction', f'Instruction written in the diary of {d.cas_number}: {rec.note_text}', actor,
          entity_type='note', entity_id=rec.id, case_id=d.id)
    return {'ok': True, 'instruction': rec.to_dict()}


# ----- the commander's supervisory review -----

def record_review(docket_id, actor, payload):
    """A periodic inspection on the record: what the commander found, what he
    directed, and when he looks again. Further directives become a diary
    instruction, so they block closure until the detective answers them."""
    d = get_docket(docket_id, actor)
    outcome = payload.get('outcome')
    if outcome not in REVIEW_OUTCOMES:
        return {'ok': False, 'error': 'Choose the outcome of the review.'}
    notes = text(payload.get('review_notes'))
    if len(notes) < MIN_REASON_LENGTH:
        return {'ok': False, 'error': f'Record what you inspected and found — at least {MIN_REASON_LENGTH} characters.'}
    further = text(payload.get('further_action'))
    if outcome == 'further_directives' and not further:
        return {'ok': False, 'error': 'Write the directive the investigating officer must carry out.'}
    next_review = None
    if payload.get('next_review_date'):
        try:
            next_review = datetime.fromisoformat(str(payload['next_review_date'])[:10]).replace(tzinfo=timezone.utc)
        except ValueError:
            return {'ok': False, 'error': 'The next review date is not a valid date.'}
        if next_review.date() <= now().date():
            return {'ok': False, 'error': 'The next review date must be in the future.'}
    when = now()
    rec = SupervisoryReview(docket_id=d.id, commander_id=actor.id, outcome=outcome, review_notes=notes,
                            further_action=further or None, next_review_date=next_review, created_at=when)
    db.session.add(rec)
    d.last_activity_at = when
    if outcome == 'further_directives':
        db.session.add(Note(docket_id=d.id, author_id=actor.id, note_text=further, note_type='instruction',
                            status='open', response='', created_at=when))
    db.session.flush()
    tell([d.detective_id], 'review', f'Supervisory review of {d.cas_number}: {REVIEW_OUTCOMES[outcome]}.',
         '/dashboard-detective')
    audit('supervisory_review', f'Supervisory review of {d.cas_number} by {actor.name}: {REVIEW_OUTCOMES[outcome]}'
          + (f'; next review {next_review.date().isoformat()}' if next_review else ''), actor,
          entity_type='docket', entity_id=d.id, case_id=d.id)
    return {'ok': True, 'review': rec.to_dict()}


def answer_instruction(note_id, actor, outcome, response):
    n = db.session.get(Note, int(note_id)) if str(note_id).isdigit() else None
    if n is None or n.note_type != 'instruction':
        return {'ok': False, 'error': 'Instruction not found.'}
    d = get_docket(n.docket_id, actor)
    if n.status != 'open':
        return {'ok': False, 'error': 'That instruction has already been answered.'}
    if not text(response):
        return {'ok': False, 'error': 'Record what was done.' if outcome == 'executed'
                else 'An explanation is required when an instruction was not carried out.'}
    when = now()
    n.status = 'executed' if outcome == 'executed' else 'explained'
    n.response, n.responded_by, n.responded_at = text(response), actor.id, when
    d.last_activity_at = when
    audit('instruction_answered', f'Diary instruction on {d.cas_number} {n.status} — {n.response}', actor,
          entity_type='note', entity_id=n.id, case_id=d.id)
    return {'ok': True, 'instruction': n.to_dict()}


# ----- witnesses -----

def add_witness(docket_id, actor, payload):
    d = get_docket(docket_id, actor)
    if not text(payload.get('name')):
        return {'ok': False, 'error': "The witness's name is required."}
    when = now()
    rec = Witness(docket_id=d.id, name=text(payload.get('name')), contact=text(payload.get('contact')),
                  identified_by=actor.id, identified_at=when)
    db.session.add(rec)
    d.last_activity_at = when
    db.session.flush()
    audit('witness', f'Witness identified on {d.cas_number}: {rec.name}', actor, entity_type='witness',
          entity_id=rec.id, case_id=d.id)
    return {'ok': True, 'witness': rec.to_dict()}


def record_witness_statement(witness_id, actor, statement_text, no_statement_reason):
    w = db.session.get(Witness, int(witness_id)) if str(witness_id).isdigit() else None
    if w is None:
        return {'ok': False, 'error': 'Witness not found.'}
    d = get_docket(w.docket_id, actor)
    statement, reason = text(statement_text), text(no_statement_reason)
    if not statement and not reason:
        return {'ok': False, 'error': 'Record the statement, or why it could not be taken.'}
    when = now()
    if statement:
        w.statement_text, w.statement_taken_at, w.no_statement_reason = statement, when, ''
    else:
        w.no_statement_reason = reason
    d.last_activity_at = when
    audit('statement', f'Statement taken from witness {w.name} on {d.cas_number}' if statement
          else f'No statement from witness {w.name} on {d.cas_number} — {reason}', actor,
          entity_type='witness', entity_id=w.id, case_id=d.id)
    return {'ok': True, 'witness': w.to_dict()}


# ----- forensics -----

def submit_forensic(docket_id, actor, payload):
    d = get_docket(docket_id, actor)
    if not text(payload.get('description')):
        return {'ok': False, 'error': 'Describe what was submitted.'}
    if not text(payload.get('lab_reference')):
        return {'ok': False, 'error': 'The laboratory reference is required.'}
    ev_id = payload.get('evidence_id')
    if ev_id and not Evidence.query.filter_by(id=int(ev_id), docket_id=d.id).count():
        return {'ok': False, 'error': 'That exhibit does not belong to this case.'}
    when = now()
    rec = Forensic(docket_id=d.id, evidence_id=int(ev_id) if ev_id else None, description=text(payload['description']),
                   lab_reference=text(payload['lab_reference']), submitted_by=actor.id, submitted_at=when)
    db.session.add(rec)
    d.last_activity_at = when
    db.session.flush()
    audit('forensic_submitted', f'Forensic submission on {d.cas_number} — {rec.description} ({rec.lab_reference})',
          actor, entity_type='forensic', entity_id=rec.id, case_id=d.id)
    return {'ok': True, 'forensic': rec.to_dict()}


def record_forensic_result(forensic_id, actor, result, accounted_for_reason):
    f = db.session.get(Forensic, int(forensic_id)) if str(forensic_id).isdigit() else None
    if f is None:
        return {'ok': False, 'error': 'Forensic submission not found.'}
    d = get_docket(f.docket_id, actor)
    res, reason = text(result), text(accounted_for_reason)
    if not res and not reason:
        return {'ok': False, 'error': 'Record the result, or account for why it is outstanding.'}
    when = now()
    if res:
        f.result, f.result_at, f.accounted_for_reason = res, when, ''
    else:
        f.accounted_for_reason = reason
    d.last_activity_at = when
    audit('forensic_result', f'Forensic result on {d.cas_number} ({f.lab_reference}): {res}' if res
          else f'Forensic submission {f.lab_reference} on {d.cas_number} outstanding — {reason}', actor,
          entity_type='forensic', entity_id=f.id, case_id=d.id)
    return {'ok': True, 'forensic': f.to_dict()}


# ----- exhibits and custody -----

def create_exhibit(d, actor, payload, when=None):
    """Shared by direct registration and accepted complainant submissions, so
    the mandatory-image rule cannot drift between the two."""
    when = when or now()
    count = Evidence.query.filter_by(docket_id=d.id).count()
    ev = Evidence(docket_id=d.id, exhibit_number=f'EX-{d.cas_number[-6:]}-{count + 1:03d}',
                  description=payload['description'], evidence_type=payload.get('evidence_type'),
                  collected_by=actor.id, collected_at=when, current_holder_id=actor.id,
                  storage_location=payload.get('storage_location') or '',
                  saps13_number=text(payload.get('saps13_number')) or None,
                  image_data_url=payload['image_data_url'],
                  suspect_name=payload.get('suspect_name') or None,
                  suspect_id_number=payload.get('suspect_id_number') or None,
                  suspect_photo_data_url=payload.get('suspect_photo_data_url') or None,
                  linked_arrest_id=int(payload['linked_arrest_id']) if payload.get('linked_arrest_id') else None)
    db.session.add(ev)
    db.session.flush()
    db.session.add(Custody(evidence_id=ev.id, from_user_id=None, to_user_id=actor.id, transferred_at=when,
                           purpose=payload.get('custody_purpose') or 'Initial collection', acknowledged=True))
    d.last_activity_at = when
    return ev


def add_evidence(docket_id, actor, payload):
    d = get_docket(docket_id, actor)
    if not text(payload.get('description')):
        return {'ok': False, 'code': 'exhibit', 'error': 'Describe the exhibit before it can be recorded.'}
    if not payload.get('image_data_url'):
        return {'ok': False, 'code': 'exhibit', 'error': 'A photograph of the exhibit (or a scanned copy, for a document) '
                                                         'is required before it can be recorded.'}
    if not text(payload.get('storage_location')):
        return {'ok': False, 'code': 'exhibit', 'error': 'The storage location is required — the chain of custody starts '
                                                         'with where the item is.'}
    if not text(payload.get('saps13_number')):
        return {'ok': False, 'code': 'exhibit',
                'error': 'The SAPS 13 register number is required before an exhibit can be recorded.'}
    trio = [payload.get('suspect_name'), payload.get('suspect_id_number'), payload.get('suspect_photo_data_url')]
    if any(trio) and not all(trio):
        return {'ok': False, 'code': 'exhibit',
                'error': 'To link a suspect, their name, ID number and photograph are all required.'}
    if Arrest.query.filter_by(docket_id=d.id).count() and not payload.get('suspect_id_number') \
            and not payload.get('linked_arrest_id'):
        return {'ok': False, 'code': 'exhibit',
                'error': 'This case has a recorded suspect, so the exhibit must be linked to a suspect or to a charge.'}
    if payload.get('suspect_id_number') and not (str(payload['suspect_id_number']).isdigit()
                                                 and len(str(payload['suspect_id_number'])) == 13):
        return {'ok': False, 'code': 'exhibit', 'error': "The suspect's ID number must be 13 digits."}
    if payload.get('linked_arrest_id') and not Arrest.query.filter_by(
            id=int(payload['linked_arrest_id']), docket_id=d.id).count():
        return {'ok': False, 'code': 'exhibit', 'error': 'The charge you linked does not belong to this case.'}
    try:
        payload = dict(payload, description=text(payload['description']),
                       image_data_url=store_data_url(payload['image_data_url'], 'exhibit', actor),
                       suspect_photo_data_url=store_data_url(payload['suspect_photo_data_url'], 'suspect', actor)
                       if payload.get('suspect_photo_data_url') else None)
    except ValueError as e:
        return {'ok': False, 'code': 'exhibit', 'error': str(e)}
    ev = create_exhibit(d, actor, payload)
    audit('create', f'Exhibit {ev.exhibit_number} registered on {d.cas_number}, linked to suspect {ev.suspect_name} '
                    f'({ev.suspect_id_number})' if ev.suspect_name
          else f'Exhibit {ev.exhibit_number} registered on {d.cas_number}', actor,
          entity_type='evidence', entity_id=ev.id, case_id=d.id)
    return {'ok': True, 'evidence': ev.to_dict()}


def transfer_evidence(evidence_id, actor, to_user_id, purpose):
    ev = db.session.get(Evidence, int(evidence_id)) if str(evidence_id).isdigit() else None
    to = db.session.get(User, int(to_user_id)) if str(to_user_id).isdigit() else None
    if ev is None or to is None or not to.is_active:
        return None
    get_docket(ev.docket_id, actor)
    if ev.current_holder_id != actor.id:
        raise ActionError('Only the person holding an exhibit can hand it on.')
    db.session.add(Custody(evidence_id=ev.id, from_user_id=ev.current_holder_id, to_user_id=to.id,
                           transferred_at=now(), purpose=text(purpose), acknowledged=False))
    ev.current_holder_id = to.id
    audit('transfer', f'Exhibit {ev.exhibit_number} transferred to {to.name}, awaiting acknowledgement', actor,
          entity_type='evidence', entity_id=ev.id, case_id=ev.docket_id)
    return ev.to_dict()


# ----- arrests and handover -----

def add_arrest(docket_id, actor, payload):
    d = get_docket(docket_id, actor)
    if not text(payload.get('accused_name')):
        return None
    when = now()
    db.session.add(Arrest(docket_id=d.id, accused_name=text(payload['accused_name']), arrested_by=actor.id,
                          arrest_datetime=when, charge_description=text(payload.get('charge_description'))))
    d.last_activity_at = when
    audit('create', f'Arrest recorded on {d.cas_number}: {text(payload["accused_name"])}', actor,
          entity_type='arrest', entity_id=d.id, case_id=d.id)
    return None


def handover(docket_id, actor, payload):
    d = get_docket(docket_id, actor)
    if not text(payload.get('recipient_name')) or not text(payload.get('recipient_organisation')):
        return None
    when = now()
    db.session.add(Handover(docket_id=d.id, handed_by=actor.id, recipient_name=text(payload['recipient_name']),
                            recipient_organisation=text(payload['recipient_organisation']), handover_datetime=when,
                            acknowledged=False, receipt_reference=text(payload.get('receipt_reference')) or None))
    prev = d.current_status
    d.current_status, d.last_activity_at = 'sent_to_prosecutor', when
    _history(d, prev, 'sent_to_prosecutor', actor, when, 'Handed to prosecutor')
    audit('handover', f'{d.cas_number} handed to {text(payload["recipient_name"])} '
                      f'({text(payload["recipient_organisation"])})', actor,
          entity_type='docket', entity_id=d.id, case_id=d.id)
    return None


# ----- reassignment (Diagram 3) -----

def reassign(docket_id, actor, detective_id, reason, detail):
    d = get_docket(docket_id, actor)
    det = db.session.get(User, int(detective_id)) if str(detective_id).isdigit() else None
    if det is None or det.role != 'detective' or not det.is_active or det.station_id != d.station_id:
        return {'ok': False, 'error': 'Case or detective not found.'}
    if actor.role != 'commander':
        return {'ok': False, 'code': 'allocation', 'error': 'Only the station commander allocates and reassigns dockets.'}
    if reason not in REASSIGNMENT_REASONS:
        return {'ok': False, 'code': 'reassign', 'error': 'Choose a reason from the list.'}
    if reason == 'Other' and not text(detail):
        return {'ok': False, 'code': 'reassign', 'error': 'Give the detail when the reason is "Other".'}

    when = now()
    if Closure.query.filter_by(docket_id=d.id, status='decided', decision='approved', decided_by=actor.id).count():
        db.session.add(Escalation(docket_id=d.id, reason=f'Reassignment of {d.cas_number} requested by the commander who '
                                                         'approved its closure — routed to cluster level.',
                                  raised_by_complainant=False, raised_at=when, decision_maker_id=actor.id,
                                  routed_upward=True, status='routed_upward'))
        audit('reassign_blocked', f'Reassignment of {d.cas_number} blocked — {actor.name} approved a closure on this '
                                  'docket. Routed to the cluster commander.', actor,
              entity_type='docket', entity_id=d.id, case_id=d.id)
        return {'ok': False, 'code': 'separation', 'routedToCluster': True,
                'error': 'You approved a closure on this docket, so you cannot also reassign it. '
                         'The request has gone to the cluster commander.'}

    full = f'Other — {text(detail)}' if reason == 'Other' else (f'{reason} — {text(detail)}' if text(detail) else reason)
    open_ = Assignment.query.filter_by(docket_id=d.id, is_active=True).first()
    previous = open_.detective_id if open_ else None
    if open_:
        open_.is_active, open_.unassigned_at = False, when
    db.session.add(Assignment(docket_id=d.id, detective_id=det.id, previous_detective_id=previous,
                              assigned_by=actor.id, assigned_at=when, assignment_method='commander_override',
                              is_active=True, reason_category=reason, override_reason=full))
    d.detective_id, d.last_activity_at = det.id, when
    send_docket(d, actor.id, det, f'Allocated by the station commander — {full}', when)
    intake = db.session.get(Intake, d.intake_id)
    if intake:
        notify(intake, f'The officer investigating {d.cas_number} has changed. {det.name} is now handling it.', when)
    audit('override', f'{d.cas_number} reassigned to {det.name} — {full}', actor, entity_type='assignment',
          entity_id=d.id, case_id=d.id)
    return {'ok': True, 'docket': d.to_dict(), 'detective': det.to_dict()}
