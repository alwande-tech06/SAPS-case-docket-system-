"""What each person's pages may see — the data a page is rendered with.

The pages read the Store synchronously (app/static/js/store.js), so each page
is handed, when Flask renders it, everything its reader is entitled to and
nothing else:

  staff        — their own station's reports and cases, and everything on them
                 (an administrator sees every station)
  complainant  — only the reports they have proved are theirs this session
  anyone else  — reference data only
"""
from ..models import (Arrest, Assignment, AuditLog, Category, Closure, Complainant, ComplainantEvidence, Custody,
                      Docket, DocketMovement, Escalation, Evidence, Forensic, Handover, Intake, Note, Notification,
                      Refusal, Specialisation, StaffNotification, Station, StatusHistory, SupervisoryReview, Transfer,
                      User, Witness, Withdrawal)

TABLES = ['stations', 'specialisations', 'categories', 'users', 'complainants', 'intakes', 'dockets', 'refusals',
          'escalations', 'assignments', 'status_history', 'notes', 'evidence', 'custody', 'arrests', 'handovers',
          'audit_log', 'complainant_evidence', 'withdrawals', 'notifications', 'closures', 'transfers', 'witnesses',
          'forensics', 'docket_movements', 'reviews']

BY_DOCKET = {'assignments': Assignment, 'status_history': StatusHistory, 'notes': Note, 'evidence': Evidence,
             'arrests': Arrest, 'handovers': Handover, 'closures': Closure, 'transfers': Transfer,
             'witnesses': Witness, 'forensics': Forensic, 'docket_movements': DocketMovement,
             'reviews': SupervisoryReview}
BY_INTAKE = {'refusals': Refusal, 'notifications': Notification, 'withdrawals': Withdrawal,
             'complainant_evidence': ComplainantEvidence}


def _dicts(query):
    return [r.to_dict() for r in query.order_by('id')]


def _in(model, column, ids):
    return model.query.filter(getattr(model, column).in_(ids or [-1]))


def reference():
    return {'stations': _dicts(Station.query), 'specialisations': _dicts(Specialisation.query),
            'categories': _dicts(Category.query)}


def build(user=None, tracked_ids=(), demo_mode=False):
    snap = {t: [] for t in TABLES}
    snap.update(reference())
    snap['me'] = user.to_session() if user else None
    snap['must_change_password'] = bool(user and user.must_change_password)
    snap['demo_mode'] = demo_mode
    # The bell: this person's latest notifications, newest first.
    snap['my_notifications'] = [n.to_dict() for n in StaffNotification.query.filter_by(user_id=user.id)
                                .order_by(StaffNotification.id.desc()).limit(30)] if user else []
    snap['audit_chain'] = {'ok': True, 'entries': 0}

    if user is not None:
        if user.role == 'admin':
            intakes = Intake.query
            dockets = Docket.query
        else:
            here = user.station_id
            # Reports routed here, and cases registered or held here (a transfer
            # moves a docket, so both ends keep sight of it).
            docket_ids = {d.id for d in Docket.query.filter(Docket.station_id == here)}
            docket_ids |= {d.id for d in Docket.query.join(Intake, Docket.intake_id == Intake.id)
                           .filter(Intake.station_id == here)}
            dockets = _in(Docket, 'id', docket_ids)
            intake_ids = {i.id for i in Intake.query.filter(Intake.station_id == here)}
            intake_ids |= {d.intake_id for d in dockets}
            intakes = _in(Intake, 'id', intake_ids)
        snap['users'] = _dicts(User.query)
        if user.role != 'admin':
            # Colleagues' names and roles, not their contact details or account notes.
            for u in snap['users']:
                if u['id'] != user.id:
                    for private in ('email', 'phone', 'personnel_number', 'status_reason'):
                        u.pop(private, None)
    else:
        intakes = _in(Intake, 'id', list(tracked_ids))
        dockets = Docket.query.filter(Docket.intake_id.in_(list(tracked_ids) or [-1]))

    snap['intakes'] = _dicts(intakes)
    snap['dockets'] = _dicts(dockets)
    intake_ids = [i['id'] for i in snap['intakes']]
    docket_ids = [d['id'] for d in snap['dockets']]
    complainant_ids = {i['complainant_id'] for i in snap['intakes']} | {d['complainant_id'] for d in snap['dockets']}
    snap['complainants'] = _dicts(_in(Complainant, 'id', complainant_ids))
    for name, model in BY_INTAKE.items():
        snap[name] = _dicts(_in(model, 'intake_id', intake_ids))
    snap['escalations'] = _dicts(Escalation.query.filter(
        Escalation.docket_id.in_(docket_ids or [-1]) | Escalation.intake_id.in_(intake_ids or [-1])))

    if user is None:
        # A complainant sees the course of their case, not the police file.
        snap['status_history'] = _dicts(_in(StatusHistory, 'docket_id', docket_ids))
        snap['arrests'] = [{'id': a.id, 'docket_id': a.docket_id} for a in _in(Arrest, 'docket_id', docket_ids)]
        for i in snap['intakes']:
            for staff_field in ('created_by', 'disposed_by', 'info_requested_by'):
                i.pop(staff_field, None)
        return snap

    for name, model in BY_DOCKET.items():
        snap[name] = _dicts(_in(model, 'docket_id', docket_ids))
    snap['custody'] = _dicts(_in(Custody, 'evidence_id', [e['id'] for e in snap['evidence']]))

    if user.role in ('commander', 'admin'):
        audit_q = AuditLog.query
        if user.role != 'admin':
            station_users = [u['id'] for u in snap['users'] if u['station_id'] == user.station_id]
            audit_q = audit_q.filter(
                AuditLog.case_id.in_(docket_ids or [-1])
                | ((AuditLog.entity_type == 'intake') & AuditLog.entity_id.in_(intake_ids or [-1]))
                | AuditLog.user_id.in_(station_users or [-1]))
        snap['audit_log'] = _dicts(audit_q)
        snap['audit_chain'] = AuditLog.verify_chain()
    else:
        # Officials and detectives see the trail of the cases they can open.
        snap['audit_log'] = _dicts(AuditLog.query.filter(AuditLog.case_id.in_(docket_ids or [-1])))
    return snap
