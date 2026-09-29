"""Reports (intakes) and everything the complainant can do: filing, the
official's disposition, the second signature on a refusal, transfers,
evidence the complainant sends in, withdrawals, escalations and tracking.

Ported from app/static/js/store.js. Results are dicts in the shape the pages
already read. Nothing here commits; the API commits once the whole action
has succeeded.
"""
import re
import secrets
from datetime import date, datetime, timezone

from ..extensions import db
from ..models import (Arrest, Category, Complainant, ComplainantEvidence, Counter, Docket, Escalation, Intake,
                      Refusal, Station, Transfer, Withdrawal)
from .common import (DUPLICATE_REASON, INTAKE_REFUSAL_REASONS, MIN_REASON_LENGTH, MISSING_ELEMENTS,
                     NO_OFFENCE_REASON, ActionError, audit, label_channel, notify, now, store_data_url, text,
                     user_name)
from .dockets import create_exhibit, get_docket, open_docket_internal, reopen_docket

SEXUAL_OFFENCE = 3                     # the one category with no typed description
STAFF_CHANNELS = ('station', 'assisted', 'third_party')
TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'


class ValidationError(Exception):
    pass


def normalize_name(s):
    return ' '.join(str(s or '').split()).lower()


def is_valid_sa_mobile(num):
    return re.fullmatch(r'(?:\+27|0)[6-8]\d{8}', re.sub(r'[\s()-]', '', str(num or ''))) is not None


def age_from_sa_id(id_number):
    digits = re.sub(r'\D', '', str(id_number or ''))
    if len(digits) != 13:
        return None
    yy, mm, dd = int(digits[:2]), int(digits[2:4]), int(digits[4:6])
    today = date.today()
    year = 2000 + yy if yy <= today.year % 100 else 1900 + yy
    try:
        dob = date(year, mm, dd)
    except ValueError:
        return None
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def parse_datetime(value):
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        raise ValidationError('The date and time of the incident are not valid.')
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def route_by_location(location):
    """No geocoding: each station lists the areas it covers and the location
    text is matched against them, falling back to the first station."""
    t = str(location or '').lower()
    stations = Station.query.order_by(Station.id).all()
    return next((s for s in stations if any(a in t for a in (s.service_areas or []))), stations[0])


def get_intake(intake_id, actor):
    i = db.session.get(Intake, int(intake_id)) if str(intake_id).isdigit() else None
    if i is None:
        raise ActionError('Report not found.', 404)
    if actor is not None and actor.role != 'admin' and i.station_id != actor.station_id:
        raise ActionError('That report belongs to another station.')
    return i


# ----- filing -----

def validate_contact(name, contact, id_number):
    if len(text(name).split()) < 2:
        raise ValidationError('Enter both a first name and a surname.')
    if not is_valid_sa_mobile(contact):
        raise ValidationError('Enter a valid South African mobile number, e.g. 082 555 0141.')
    if not re.fullmatch(r'\d{13}', text(id_number)):
        raise ValidationError('Enter a 13-digit South African ID number.')
    age = age_from_sa_id(id_number)
    if age is None:
        raise ValidationError('That ID number is not valid — the first six digits must be a real date of birth.')
    return age


def create_intake(data, actor=None):
    """File a report. actor is the official for assisted capture, None for a
    member of the public (whose phone number the API has already verified)."""
    name, contact, id_number = text(data.get('name')), text(data.get('contact')), text(data.get('id_number'))
    location, description = text(data.get('location')), text(data.get('description'))
    try:
        category = db.session.get(Category, int(data.get('category_id')))
    except (TypeError, ValueError):
        category = None
    missing = [label for label, ok in (
        ('type of incident', category is not None),
        ('date', bool(data.get('incident_datetime'))),
        ('location', bool(location)),
        ('description', bool(description) or (category and category.id == SEXUAL_OFFENCE)),
    ) if not ok]
    if missing:
        raise ValidationError('Still needed: ' + ', '.join(missing))
    age = validate_contact(name, contact, id_number)
    # A minor reports in person, where a guardian can be recorded.
    if actor is None and age < 18:
        raise ValidationError('You must be 18 or older to report online.')
    incident_at = parse_datetime(data.get('incident_datetime'))

    if actor is not None:
        channel = data.get('channel') if data.get('channel') in STAFF_CHANNELS else 'assisted'
        station = db.session.get(Station, actor.station_id)
    else:
        channel, station = 'public_web', route_by_location(location)

    when = now()
    comp = Complainant.query.filter_by(id_number=id_number).first()
    if comp is None:
        n = Counter.next('complainant')
        comp = Complainant(complainant_number=f'CMP-{n:06d}', name=name, contact=contact, id_number=id_number,
                           gender=data.get('gender') or None, verified_at=when)
        db.session.add(comp)
        db.session.flush()
    else:
        comp.name, comp.contact, comp.verified_at = name, contact, when
        if data.get('gender'):
            comp.gender = data['gender']

    suspect = data.get('suspect') or {}
    if suspect.get('description') or suspect.get('name'):
        suspect = {'can_identify': True, 'name': text(suspect.get('name')), 'description': text(suspect.get('description')),
                   'contact': text(suspect.get('contact'))}
    else:
        suspect = {'can_identify': False}
    witnesses = [{'name': text(w.get('name')), 'contact': text(w.get('contact'))}
                 for w in (data.get('witnesses') or []) if text(w.get('name'))]
    details = {str(k): text(v) for k, v in (data.get('details') or {}).items() if text(v)}

    n = Counter.next('intake')
    intake = Intake(intake_number=f'INT-{when.year}-{station.code}-{n:06d}',
                    track_token=''.join(secrets.choice(TOKEN_ALPHABET) for _ in range(32)),
                    complainant_id=comp.id, category_id=category.id, station_id=station.id, channel=channel,
                    incident_description=description, incident_location=location, incident_datetime=incident_at,
                    created_by=actor.id if actor else None, created_at=when, details=details, suspect=suspect,
                    witnesses_reported=witnesses, disposition='pending')
    db.session.add(intake)
    db.session.flush()
    audit('create', f'Report {intake.intake_number} received via {label_channel(channel)}', actor,
          entity_type='intake', entity_id=intake.id)
    audit('route', f'Routed to {station.name} on incident location', actor, entity_type='intake', entity_id=intake.id)
    return intake, comp


# ----- disposition (police official) -----

def open_docket(intake_id, actor, options):
    intake = get_intake(intake_id, actor)
    if intake.disposition != 'pending':
        return None
    if Refusal.query.filter_by(intake_id=intake.id, status='pending_cosign').count() and actor.role != 'commander':
        return None
    current = db.session.get(Category, intake.category_id)
    if current and current.requires_classification:
        chosen = db.session.get(Category, int(options['category_id'])) \
            if str((options or {}).get('category_id') or '').isdigit() else None
        if chosen is None or chosen.requires_classification:
            return None
        intake.category_id = chosen.id
        audit('classify', f'{intake.intake_number} classified as {chosen.name} (was "{current.name}") by {actor.name}',
              actor, entity_type='intake', entity_id=intake.id)
    d, assigned = open_docket_internal(intake, actor)
    notify(intake, f'A case has been opened. Your case number is {d.cas_number}, and {assigned.name} is investigating it.'
           if assigned else f'A case has been opened. Your case number is {d.cas_number}. An investigating officer is '
                            'being allocated by the station commander.')
    return {'docket': d.to_dict(), 'assigned': assigned.to_dict() if assigned else None}


def refusal_reasons_for(intake):
    cat = db.session.get(Category, intake.category_id)
    return [DUPLICATE_REASON] if cat and cat.protected_from_withdrawal else list(INTAKE_REFUSAL_REASONS)


def reference_resolves(reference):
    ref = text(reference).upper()
    return bool(ref) and bool(Intake.query.filter(db.func.upper(Intake.intake_number) == ref).count()
                              or Docket.query.filter(db.func.upper(Docket.cas_number) == ref).count())


def record_refusal(intake_id, actor, payload):
    """A refusal is a request; it takes effect only when a second person signs it."""
    intake = get_intake(intake_id, actor)
    if intake.disposition != 'pending':
        return {'ok': False, 'code': 'intake_preconditions', 'error': 'That report has already been dealt with.'}
    if Refusal.query.filter_by(intake_id=intake.id, status='pending_cosign').count():
        return {'ok': False, 'code': 'cosign', 'error': 'A refusal on this report is already waiting for a second signature.'}
    ground = payload.get('reason_category') or ''
    if ground not in refusal_reasons_for(intake):
        cat = db.session.get(Category, intake.category_id)
        insufficient = re.search(r'insufficient|not enough|no evidence', ground, re.I)
        return {'ok': False,
                'code': 'protected_categories' if cat and cat.protected_from_withdrawal
                else 'insufficient_at_intake' if insufficient else 'invalid_grounds',
                'error': f'For {cat.name.lower()}, a docket may only be withheld for a verified duplicate.'
                if cat and cat.protected_from_withdrawal
                else 'Whether evidence is sufficient is decided after an investigation, not at intake.' if insufficient
                else 'That is not a reason a docket may be refused at intake.'}
    detail = text(payload.get('reason_detail'))
    if len(detail) < MIN_REASON_LENGTH:
        return {'ok': False, 'code': 'no_offence',
                'error': f'Write the full reason — at least {MIN_REASON_LENGTH} characters. Another person has to '
                         'weigh this decision on what you write here.'}
    if ground == NO_OFFENCE_REASON:
        if payload.get('missing_element') not in MISSING_ELEMENTS:
            return {'ok': False, 'code': 'no_offence', 'error': 'Name the element that is missing: legality, or conduct.'}
        if not text(payload.get('definition_reference')):
            return {'ok': False, 'code': 'no_offence', 'error': 'Record the crime definition you consulted.'}
    if ground == DUPLICATE_REASON:
        if not text(payload.get('duplicate_of')):
            return {'ok': False, 'code': 'duplicate',
                    'error': 'Give the case or report number this duplicates, so it can be verified.'}
        if not reference_resolves(payload.get('duplicate_of')):
            return {'ok': False, 'code': 'duplicate', 'error': 'No report or case was found under that number.'}

    rec = Refusal(intake_id=intake.id, station_id=intake.station_id, officer_id=actor.id, reason_category=ground,
                  reason_detail=detail, duplicate_of=text(payload.get('duplicate_of')) or None,
                  missing_element=payload.get('missing_element') or None,
                  definition_reference=text(payload.get('definition_reference')) or None,
                  status='pending_cosign', raised_at=now(), cosign_note='')
    db.session.add(rec)
    db.session.flush()
    audit('refusal_proposed', f'Refusal proposed on {intake.intake_number} — {ground}. Awaiting a second signature.',
          actor, entity_type='intake', entity_id=intake.id)
    return {'ok': True, 'refusal': rec.to_dict()}


def cosign_refusal(refusal_id, actor, agree, note, options):
    rec = db.session.get(Refusal, int(refusal_id)) if str(refusal_id).isdigit() else None
    if rec is None or rec.status != 'pending_cosign':
        return {'ok': False, 'code': 'cosign', 'error': 'That refusal is no longer waiting for a signature.'}
    intake = get_intake(rec.intake_id, actor)
    if actor.role != 'commander':
        return {'ok': False, 'code': 'cosign', 'error': 'Only the station commander can sign off a decision not to open a docket.'}
    if rec.officer_id == actor.id:
        return {'ok': False, 'code': 'separation',
                'error': 'The official who proposed a refusal cannot sign it off. A second person must.'}
    cosign_note = text(note)
    if len(cosign_note) < MIN_REASON_LENGTH:
        return {'ok': False, 'code': 'cosign',
                'error': f'Record why the facts disclose no offence — at least {MIN_REASON_LENGTH} characters.' if agree
                else f'Record why a docket must be opened — at least {MIN_REASON_LENGTH} characters.'}
    checked = bool((options or {}).get('definition_checked'))
    if agree and not checked:
        return {'ok': False, 'code': 'cosign',
                'error': 'Confirm that you compared the facts against the crime definition before signing.'}

    when = now()
    rec.cosigned_by, rec.cosigned_at, rec.cosign_note, rec.definition_checked = actor.id, when, cosign_note, checked
    if not agree:
        rec.status, rec.reversed_official_id = 'rejected', rec.officer_id
        audit('decision_reversed', f'Decision by {user_name(rec.officer_id)} reversed on {intake.intake_number}: '
                                   f'refusal not signed off — {cosign_note}. A docket must be opened.', actor,
              entity_type='intake', entity_id=intake.id)
        return {'ok': True, 'refusal': rec.to_dict(), 'mustOpenDocket': True}

    rec.status, rec.refused_at, rec.complainant_notified_at = 'confirmed', when, when
    intake.disposition, intake.disposed_at, intake.disposed_by = 'refused', when, rec.officer_id
    notify(intake, f'No docket was opened. Reason: {rec.reason_category}. '
                   'You may escalate this to the station commander from your tracking page.', when)
    audit('refusal', f'Refusal on {intake.intake_number} signed off by {actor.name} — {rec.reason_category}', actor,
          entity_type='intake', entity_id=intake.id)
    return {'ok': True, 'refusal': rec.to_dict()}


def register_and_transfer(intake_id, actor, payload):
    """Wrong jurisdiction: registered here first, so the complainant holds a
    case number, then transferred (NI 3/2011)."""
    intake = get_intake(intake_id, actor)
    if intake.disposition != 'pending':
        return {'ok': False, 'code': 'intake_preconditions', 'error': 'That report has already been dealt with.'}
    to = db.session.get(Station, int(payload['to_station_id'])) \
        if str(payload.get('to_station_id') or '').isdigit() else None
    if to is None:
        return {'ok': False, 'code': 'transfer', 'error': 'Choose the station that should receive this case.'}
    if to.id == intake.station_id:
        return {'ok': False, 'code': 'transfer', 'error': 'That is the station already handling this report.'}
    if not text(payload.get('reason')):
        return {'ok': False, 'code': 'transfer', 'error': 'A reason for the transfer is required.'}

    d, _ = open_docket_internal(intake, actor)
    frm = db.session.get(Station, d.station_id)
    when = now()
    d.station_id, d.last_activity_at, d.detective_id = to.id, when, None
    from ..models import Assignment
    for a in Assignment.query.filter_by(docket_id=d.id, is_active=True):
        a.is_active, a.unassigned_at = False, when
    db.session.add(Transfer(docket_id=d.id, from_station_id=frm.id, to_station_id=to.id, transferred_by=actor.id,
                            transferred_at=when, reason=text(payload['reason'])))
    notify(intake, f'Your case number is {d.cas_number}. It has been registered at {frm.name} and transferred to '
                   f'{to.name}, which covers where this happened. You do not need to report it again.', when)
    audit('transfer', f'{d.cas_number} registered at {frm.name} and transferred to {to.name} — {text(payload["reason"])}',
          actor, entity_type='docket', entity_id=d.id, case_id=d.id)
    return {'ok': True, 'docket': d.to_dict(), 'to': to.to_dict()}


# ----- evidence the complainant sends in -----

def add_complainant_evidence(intake_id, files, description):
    intake = db.session.get(Intake, int(intake_id)) if str(intake_id).isdigit() else None
    if intake is None or not files:
        return []
    if len(files) > 5:
        raise ActionError('Attach at most 5 files at a time.', 400)
    when = now()
    created = []
    for f in files:
        try:
            url = store_data_url(f.get('dataUrl') or f.get('data_url'), f.get('name'), intake_id=intake.id)
        except ValueError as e:
            raise ActionError(str(e), 400)
        rec = ComplainantEvidence(intake_id=intake.id, file_name=text(f.get('name'))[:255] or 'file',
                                  file_type=text(f.get('type')) or 'application/octet-stream',
                                  file_size=int(f.get('size') or 0), data_url=url, description=text(description),
                                  uploaded_at=when)
        db.session.add(rec)
        created.append(rec)
    d = db.session.get(Docket, intake.docket_id) if intake.docket_id else None
    if d:
        d.last_activity_at = when
    db.session.flush()
    audit('evidence_submitted', f'Complainant submitted {len(created)} file(s) as evidence on {intake.intake_number}',
          entity_type='intake', entity_id=intake.id, case_id=d.id if d else None)
    return [r.to_dict() for r in created]


def review_complainant_evidence(ce_id, actor, decision, note, saps13):
    ce = db.session.get(ComplainantEvidence, int(ce_id)) if str(ce_id).isdigit() else None
    if ce is None:
        return None
    intake = get_intake(ce.intake_id, actor)
    d = db.session.get(Docket, intake.docket_id) if intake.docket_id else None
    if d is not None:
        get_docket(d.id, actor)
    if decision not in ('accepted', 'rejected'):
        return {'ok': False, 'error': 'Accept or reject the file.'}
    if decision == 'rejected' and not text(note):
        return {'ok': False, 'error': 'A reason is required to reject submitted evidence.'}
    if decision == 'accepted' and not text(saps13):
        return {'ok': False, 'error': 'A SAPS 13 register number is required to accept this as an exhibit.'}
    when = now()
    ce.review_status, ce.reviewed_by, ce.reviewed_at, ce.review_note = decision, actor.id, when, text(note)
    if decision == 'accepted' and d is not None:
        ev = create_exhibit(d, actor, {
            'description': ce.description or ce.file_name,
            'evidence_type': 'Photograph' if ce.file_type.startswith('image/') else 'Document',
            'storage_location': 'Submitted by complainant', 'saps13_number': text(saps13),
            'image_data_url': ce.data_url, 'custody_purpose': 'Accepted from complainant submission'}, when)
        ce.linked_exhibit_id = ev.id
    audit('evidence_accepted' if decision == 'accepted' else 'evidence_rejected',
          f'Complainant-submitted file "{ce.file_name}" accepted as an exhibit' if decision == 'accepted'
          else f'Complainant-submitted file "{ce.file_name}" rejected — {ce.review_note}', actor,
          entity_type='complainant_evidence', entity_id=ce.id, case_id=d.id if d else None)
    return {'ok': True, 'evidence': ce.to_dict()}


# ----- withdrawals -----

def withdrawal_eligibility(intake):
    cat = db.session.get(Category, intake.category_id)
    protected = bool(cat and cat.protected_from_withdrawal)
    d = db.session.get(Docket, intake.docket_id) if intake.docket_id else None
    if Withdrawal.query.filter_by(intake_id=intake.id, status='pending').count():
        return {'allowed': False, 'pending': True, 'protectedCategory': protected,
                'reason': 'A withdrawal request for this case is already awaiting a decision.'}
    if d:
        if d.current_status == 'closed':
            return {'allowed': False, 'protectedCategory': protected, 'reason': 'This case is already closed.'}
        if d.current_status == 'sent_to_prosecutor':
            return {'allowed': False, 'protectedCategory': protected,
                    'reason': 'This case has already been handed to the prosecutor and can no longer be withdrawn.'}
        if Arrest.query.filter_by(docket_id=d.id).count():
            return {'allowed': False, 'protectedCategory': protected,
                    'reason': 'An arrest has already been made on this case, so it can no longer be withdrawn.'}
    elif intake.disposition != 'pending':
        return {'allowed': False, 'protectedCategory': protected, 'reason': 'This report has already been disposed of.'}
    return {'allowed': True, 'protectedCategory': protected}


def request_withdrawal(intake_id, payload):
    intake = db.session.get(Intake, int(intake_id)) if str(intake_id).isdigit() else None
    if intake is None:
        return {'ok': False, 'error': 'Report not found.'}
    elig = withdrawal_eligibility(intake)
    if not elig['allowed']:
        return {'ok': False, 'error': elig['reason']}
    if not text(payload.get('reason_category')):
        return {'ok': False, 'error': 'Choose a reason so the request can be reviewed.'}
    rec = Withdrawal(intake_id=intake.id, docket_id=intake.docket_id, reason_category=text(payload['reason_category']),
                     reason_detail=text(payload.get('reason_detail')), requested_at=now(),
                     protected_category=elig['protectedCategory'], status='pending')
    db.session.add(rec)
    db.session.flush()
    audit('withdrawal_request', f'Complainant requested withdrawal of {intake.intake_number} — {rec.reason_category}',
          entity_type='intake', entity_id=intake.id, case_id=intake.docket_id)
    return {'ok': True, 'withdrawal': rec.to_dict()}


def decide_withdrawal(withdrawal_id, actor, decision, reason):
    from ..models import StatusHistory
    w = db.session.get(Withdrawal, int(withdrawal_id)) if str(withdrawal_id).isdigit() else None
    if w is None:
        return {'ok': False, 'error': 'Withdrawal request not found.'}
    intake = get_intake(w.intake_id, actor)
    if w.status != 'pending':
        return {'ok': False, 'error': 'That request has already been decided.'}
    allowed = ('noted', 'declined') if w.protected_category else ('approved', 'declined')
    if decision not in allowed:
        return {'ok': False, 'error': 'That decision is not available for this case.'}
    if not text(reason):
        return {'ok': False, 'error': 'A reason is required for this decision.'}
    d = db.session.get(Docket, w.docket_id) if w.docket_id else None
    when = now()
    w.status, w.decision, w.decided_by, w.decided_at, w.decision_reason = 'decided', decision, actor.id, when, text(reason)
    if decision == 'approved':
        if d:
            prev = d.current_status
            d.current_status, d.closure_type, d.last_activity_at = 'closed', 'Withdrawn by complainant', when
            db.session.add(StatusHistory(docket_id=d.id, previous_status=prev, new_status='closed', changed_by=actor.id,
                                         changed_at=when, notes=f'Withdrawn by complainant — {text(reason)}'))
        else:
            intake.disposition, intake.disposed_at, intake.disposed_by = 'withdrawn', when, actor.id
    audit('withdrawal_decision', f'Withdrawal request on {intake.intake_number} — {decision}: {text(reason)}', actor,
          entity_type='withdrawal', entity_id=w.id, case_id=d.id if d else None)
    return {'ok': True, 'withdrawal': w.to_dict()}


# ----- escalations (Diagram 7) -----

def decision_maker_for(docket_id, intake_id):
    if docket_id:
        d = db.session.get(Docket, docket_id)
        if d:
            return d.detective_id or d.registered_by
    if intake_id:
        r = Refusal.query.filter_by(intake_id=intake_id, status='confirmed').first()
        if r:
            return r.officer_id
        i = db.session.get(Intake, intake_id)
        if i:
            return i.disposed_by
    return None


def raise_escalation(intake, payload):
    """A complainant escalating their own case, from the tracking page."""
    if not text(payload.get('reason')):
        return {'ok': False, 'error': 'Choose a reason so the commander knows what to look at.'}
    docket_id = intake.docket_id
    rec = Escalation(docket_id=docket_id, intake_id=None if docket_id else intake.id, reason=text(payload['reason']),
                     raised_by_complainant=True, raised_at=now(),
                     decision_maker_id=decision_maker_for(docket_id, intake.id), routed_upward=False, status='open')
    db.session.add(rec)
    db.session.flush()
    audit('escalate', f'Complainant raised escalation: {rec.reason}', entity_type='escalation', entity_id=rec.id,
          case_id=docket_id)
    return rec.to_dict()


def respond_escalation(escalation_id, actor, outcome, response):
    e = db.session.get(Escalation, int(escalation_id)) if str(escalation_id).isdigit() else None
    if e is None:
        return None
    station = (db.session.get(Docket, e.docket_id).station_id if e.docket_id
               else db.session.get(Intake, e.intake_id).station_id if e.intake_id else None)
    if station is not None and station != actor.station_id:
        raise ActionError('That escalation belongs to another station.')
    if e.status != 'open':
        return {'ok': False, 'error': 'That escalation has already been dealt with.'}
    if not text(outcome) or not text(response):
        return {'ok': False, 'error': 'Record the outcome and your response.'}
    # The decision-maker cannot answer a complaint about their own decision.
    if e.decision_maker_id and e.decision_maker_id == actor.id:
        e.routed_upward, e.status = True, 'routed_upward'
        audit('escalation_routed', f'Escalation on a decision taken by {actor.name} routed to cluster level — it cannot '
                                   'be answered by the decision-maker', actor, entity_type='escalation', entity_id=e.id,
              case_id=e.docket_id)
        return {'ok': False, 'routedUpward': True,
                'error': 'You took the decision being complained about, so you cannot answer this escalation. '
                         'It has been routed to cluster level.'}
    e.commander_id, e.response, e.responded_at, e.status = actor.id, f'{text(outcome)} — {text(response)}', now(), 'responded'
    audit('escalation_response', f'Escalation answered: {text(outcome)}', actor, entity_type='escalation',
          entity_id=e.id, case_id=e.docket_id)
    return {'ok': True, 'escalation': e.to_dict()}


def reopen_by_complainant(intake, new_evidence):
    d = db.session.get(Docket, intake.docket_id) if intake.docket_id else None
    if d is None:
        return {'ok': False, 'error': 'Case not found.'}
    if d.current_status != 'closed':
        return {'ok': False, 'error': 'This case is not filed.'}
    if not text(new_evidence):
        return {'ok': False, 'error': 'Tell us what is new. A filed case reopens on new evidence or new information.'}
    return reopen_docket(d, None, {'trigger': 'manual', 'new_evidence': f'Raised by the complainant: {text(new_evidence)}'})


# ----- tracking -----
# Each lookup returns intakes only when the caller has shown what the page
# asks for; otherwise None, and the caller says the same thing either way.

def find_by_reference(reference):
    ref = text(reference).upper()
    intake = Intake.query.filter(db.func.upper(Intake.intake_number) == ref).first()
    if intake is None:
        d = Docket.query.filter(db.func.upper(Docket.cas_number) == ref).first()
        intake = db.session.get(Intake, d.intake_id) if d else None
    return intake


def track_by_reference(reference, full_name):
    intake = find_by_reference(reference)
    if intake is None or normalize_name(intake.complainant.name) != normalize_name(full_name):
        return None
    return [intake]


def track_by_person(full_name, complainant_number=None, id_number=None):
    if complainant_number:
        comp = Complainant.query.filter(db.func.upper(Complainant.complainant_number) == text(complainant_number).upper()).first()
    else:
        comp = Complainant.query.filter_by(id_number=re.sub(r'\D', '', str(id_number or ''))).first()
    if comp is None or normalize_name(comp.name) != normalize_name(full_name):
        return None
    return Intake.query.filter_by(complainant_id=comp.id).order_by(Intake.id).all()


def track_link(reference, token):
    intake = find_by_reference(reference)
    if intake is None or not token or not secrets.compare_digest(intake.track_token, str(token)):
        return None
    return intake
