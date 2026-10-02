"""Urgency, consent, the map pin, requests for information, docket receipts,
structured diary entries, supervisory reviews, the bell, and account status."""
from datetime import timedelta

from app.extensions import db
from app.models import (AuditLog, Docket, DocketMovement, Intake, Note, StaffNotification, Station,
                        SupervisoryReview, User)
from app.services.common import now

from .conftest import act, login
from .test_intakes import file_report


def docket_of(intake_number):
    return Docket.query.join(Intake, Docket.intake_id == Intake.id).filter(Intake.intake_number == intake_number).one()


def bell(client):
    return client.get('/api/snapshot').json['snapshot']['my_notifications']


# ----- the report form -----

def test_urgent_reports_are_flagged_and_officials_are_told(client, as_role):
    intake = file_report(client, urgent=True).json['intake']
    assert intake['urgent'] is True and intake['consent_at']
    as_role('official')
    assert any(n['kind'] == 'urgent' and intake['intake_number'] in n['message'] for n in bell(client))
    as_role('detective')
    assert bell(client) == []                       # only the people who must act are told


def test_online_report_needs_consent(client):
    r = file_report(client, consent=False)
    assert r.status_code == 400 and 'agree' in r.json['error']
    assert Intake.query.count() == 7


def test_map_pin_is_kept_and_checked(client):
    intake = file_report(client, latitude='-29.8587', longitude='31.0218').json['intake']
    assert (intake['latitude'], intake['longitude']) == (-29.8587, 31.0218)
    assert 'outside South Africa' in file_report(client, latitude='51.5', longitude='-0.12').json['error']
    assert 'not valid' in file_report(client, latitude='north', longitude='east').json['error']
    assert file_report(client).json['intake']['latitude'] is None      # the pin is optional


# ----- asking the complainant for more -----

def test_official_asks_and_complainant_answers(client, as_role):
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    as_role('official')
    assert act(client, 'requestInfo', intakeId=fraud.id, message='short')[1]['ok'] is False
    res = act(client, 'requestInfo', intakeId=fraud.id, message='Which bank account did you pay into?')[1]
    assert res['ok'] and res['intake']['info_request'] and db.session.get(Intake, fraud.id).disposition == 'pending'
    client.post('/api/auth/logout', json={})

    assert act(client, 'respondInfo', intakeId=fraud.id, response='FNB 123')[0] == 403     # not proved theirs yet
    snap = client.post('/api/track', json={'reference': fraud.intake_number, 'name': 'Ayanda Mkhize'}).json['snapshot']
    assert snap['intakes'][0]['info_request'] == 'Which bank account did you pay into?'
    assert 'info_requested_by' not in snap['intakes'][0]
    assert any('needs more information' in n['message'] for n in snap['notifications'])
    assert act(client, 'respondInfo', intakeId=fraud.id, response='FNB account 62000000000.')[1]['ok']
    assert act(client, 'respondInfo', intakeId=fraud.id, response='Again.')[1]['ok'] is False   # answered once

    as_role('official')
    assert any('answered your question' in n['message'] for n in bell(client))
    assert db.session.get(Intake, fraud.id).info_response == 'FNB account 62000000000.'


def test_info_cannot_be_requested_on_a_disposed_report(client, as_role):
    as_role('official')
    refused = Intake.query.filter_by(intake_number='INT-2026-DBN-000004').one()
    assert act(client, 'requestInfo', intakeId=refused.id, message='Tell me more please.')[1]['ok'] is False


# ----- docket receipt -----

def test_detective_signs_for_an_allocated_docket(client, as_role):
    as_role('official')
    r = client.post('/api/intakes', json={'name': 'Anele Dube', 'contact': '082 555 0100', 'id_number': '9001015009087',
                                          'category_id': 7, 'location': 'Berea', 'description': 'Break-in.',
                                          'incident_datetime': '2026-09-28T08:00:00Z'})
    res = act(client, 'openDocket', intakeId=r.json['intake']['id'])[1]
    docket_id = res['docket']['id']
    m = DocketMovement.query.filter_by(docket_id=docket_id).one()
    assert m.to_user_id == 3 and m.from_user_id == 1 and m.acknowledged_at is None

    as_role('detective')
    assert any(n['kind'] == 'docket' for n in bell(client))
    assert act(client, 'acknowledgeDocket', docketId=docket_id, note='Received with 2 annexures.')[1]['ok']
    assert DocketMovement.query.filter_by(docket_id=docket_id).one().acknowledged_at is not None
    assert act(client, 'acknowledgeDocket', docketId=docket_id)[1]['ok'] is False     # nothing left to sign
    assert AuditLog.query.filter_by(action_type='docket_acknowledged').count() == 1


def test_reassignment_is_a_new_movement_and_supersedes_the_old(client, as_role):
    theft = docket_of('INT-2026-DBN-000001')
    DocketMovement.query.filter_by(docket_id=theft.id).one().acknowledged_at = None
    db.session.commit()
    as_role('admin')
    act(client, 'saveUser', payload={'name': 'Det. New', 'email': 'det.new@saps.demo', 'role': 'detective',
                                     'station_id': 1, 'specialisation_id': 1})
    new_det = User.query.filter_by(email='det.new@saps.demo').one()
    as_role('commander')
    assert act(client, 'reassign', docketId=theft.id, detectiveId=new_det.id, reason='Urgency', detail='')[1]['ok']
    moves = DocketMovement.query.filter_by(docket_id=theft.id).order_by(DocketMovement.id).all()
    assert len(moves) == 2 and moves[0].acknowledged_at is not None and 'Superseded' in moves[0].acknowledgement_note
    assert moves[1].to_user_id == new_det.id and moves[1].acknowledged_at is None


def test_holder_sends_the_docket_and_custody_passes_only_on_signature(client, as_role):
    from app.services.dockets import custodian_id
    theft = docket_of('INT-2026-DBN-000001')
    det, commander = theft.detective_id, 6
    why = 'For 24-hour inspection by the commander.'
    assert custodian_id(theft) == det

    as_role('commander')                                        # not the holder
    assert act(client, 'transferDocket', docketId=theft.id, toUserId=det, reason=why)[1]['code'] == 'not_custodian'

    as_role('detective')
    assert act(client, 'transferDocket', docketId=theft.id, toUserId=commander, reason='short')[1]['ok'] is False
    other = User.query.filter(User.role == 'detective', User.id != det, User.station_id == theft.station_id).first()
    assert act(client, 'transferDocket', docketId=theft.id, toUserId=other.id, reason=why)[1]['code'] == 'recipient'
    assert act(client, 'transferDocket', docketId=theft.id, toUserId=commander, reason=why)[1]['ok']
    assert custodian_id(theft) == det                           # still the sender's until signed for
    assert act(client, 'transferDocket', docketId=theft.id, toUserId=commander, reason=why)[1]['code'] == 'in_transit'
    assert act(client, 'acknowledgeDocket', docketId=theft.id)[1]['ok'] is False      # not sent to them

    as_role('commander')
    assert any(n['kind'] == 'docket' and theft.cas_number in n['message'] for n in bell(client))
    assert act(client, 'acknowledgeDocket', docketId=theft.id, note='Complete.')[1]['ok']
    assert custodian_id(theft) == commander
    assert db.session.get(Docket, theft.id).detective_id == det                       # the investigator is unchanged
    assert act(client, 'transferDocket', docketId=theft.id, toUserId=det, reason='Inspected; returned to continue.')[1]['ok']

    as_role('detective')
    assert any('signed for' in n['message'] for n in bell(client))                    # the sender is told
    assert act(client, 'acknowledgeDocket', docketId=theft.id)[1]['ok']
    assert custodian_id(theft) == det
    assert [a.action_type for a in AuditLog.query.filter(AuditLog.action_type.in_(['docket_sent', 'docket_acknowledged']))
            .order_by(AuditLog.id)] == ['docket_sent', 'docket_acknowledged', 'docket_sent', 'docket_acknowledged']


def test_an_unsigned_reassignment_leaves_custody_where_it_was(client, as_role):
    from app.services.dockets import custodian_id
    theft = docket_of('INT-2026-DBN-000001')
    first = theft.detective_id
    other = User.query.filter(User.role == 'detective', User.id != first, User.station_id == theft.station_id).first()
    as_role('commander')
    assert act(client, 'reassign', docketId=theft.id, detectiveId=other.id, reason='Urgency', detail='')[1]['ok']
    assert custodian_id(theft) == first


def test_seeded_dockets_start_signed_for_and_quiet(app):
    assert DocketMovement.query.filter_by(acknowledged_at=None).count() == 0
    assert StaffNotification.query.count() == 0


# ----- the diary and the review -----

def test_diary_entries_record_type_outcome_and_next_action(client, as_role):
    theft = docket_of('INT-2026-DBN-000001')
    as_role('detective')
    act(client, 'addNote', docketId=theft.id, text='Interviewed the car guard.',
        entry={'entry_type': 'witness_interview', 'outcome': 'He saw a white Polo.', 'next_action': 'Trace the Polo.'})
    act(client, 'addNote', docketId=theft.id, text='Plain note, as before.')
    notes = Note.query.filter_by(docket_id=theft.id).order_by(Note.id).all()
    assert (notes[0].entry_type, notes[0].outcome, notes[0].next_action) == \
        ('witness_interview', 'He saw a white Polo.', 'Trace the Polo.')
    assert notes[1].entry_type == 'investigation_note' and notes[1].outcome is None


def test_supervisory_review_with_directive_blocks_closure(client, as_role):
    stale = docket_of('INT-2026-DBN-000002')
    as_role('detective')
    assert act(client, 'recordReview', docketId=stale.id, payload={})[0] == 403        # the commander's job
    as_role('commander')
    assert act(client, 'recordReview', docketId=stale.id, payload={'outcome': 'satisfactory', 'review_notes': 'ok'})[1]['ok'] is False
    assert 'directive' in act(client, 'recordReview', docketId=stale.id, payload={
        'outcome': 'further_directives', 'review_notes': 'Diary shows no activity for a month.'})[1]['error']
    tomorrow = (now() + timedelta(days=14)).date().isoformat()
    res = act(client, 'recordReview', docketId=stale.id, payload={
        'outcome': 'further_directives', 'review_notes': 'Diary shows no activity for a month.',
        'further_action': 'Re-interview the neighbour at number 10.', 'next_review_date': tomorrow})[1]
    assert res['ok'] and res['review']['next_review_date'].startswith(tomorrow)
    assert SupervisoryReview.query.filter_by(docket_id=stale.id).count() == 1
    instruction = Note.query.filter_by(docket_id=stale.id, note_type='instruction').one()
    assert instruction.status == 'open' and 'neighbour' in instruction.note_text
    assert 'future' in act(client, 'recordReview', docketId=stale.id, payload={
        'outcome': 'satisfactory', 'review_notes': 'All in order after inspection today.',
        'next_review_date': '2020-01-01'})[1]['error']
    as_role('detective')
    assert any(n['kind'] == 'review' for n in bell(client))


# ----- the bell -----

def test_notifications_reach_the_right_role_and_can_be_marked_read(client, as_role):
    stale = docket_of('INT-2026-DBN-000002')
    as_role('commander')
    act(client, 'addInstruction', docketId=stale.id, text='Take the neighbour statement.')
    assert bell(client) == []
    as_role('detective')
    notes = bell(client)
    assert [n['kind'] for n in notes] == ['instruction'] and notes[0]['read_at'] is None
    assert act(client, 'markNotificationsRead')[1]['ok']
    assert bell(client)[0]['read_at'] is not None
    # Nobody sees anyone else's.
    as_role('official')
    assert bell(client) == []


def test_commander_is_told_about_cosign_closure_withdrawal_and_escalation(client, as_role):
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    as_role('official')
    act(client, 'recordRefusal', intakeId=fraud.id, payload={
        'reason_category': 'No offence disclosed — an element of the definition is missing',
        'reason_detail': 'The transfer was a loan she agreed to, not a deception.',
        'missing_element': 'Conduct', 'definition_reference': 'Fraud manual'})
    client.post('/api/auth/logout', json={})
    theft = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    client.post('/api/track', json={'reference': theft.intake_number, 'name': 'Thandeka Ngcobo'})
    act(client, 'requestWithdrawal', intakeId=theft.id, payload={'reason_category': 'Settled'})
    act(client, 'raiseEscalation', intakeId=theft.id, payload={'reason': 'No feedback.'})
    as_role('commander')
    assert {n['kind'] for n in bell(client)} == {'cosign', 'withdrawal', 'escalation'}


# ----- accounts -----

def test_suspend_and_reactivate(client, as_role, app):
    official = app.test_client()
    login(official, 'official2@saps.demo')
    as_role('admin')
    assert act(client, 'suspendUser', id=2, reason='short')[1]['ok'] is False
    assert act(client, 'suspendUser', id=7, reason='Suspending myself for a while.')[1]['ok'] is False
    assert act(client, 'suspendUser', id=2, reason='Pending a disciplinary hearing.')[1]['ok']
    r = official.get('/api/auth/me')                                             # signed out at once, and told why
    assert r.status_code == 401 and r.json['code'] == 'inactive' and 'suspended' in r.json['error']
    assert official.get('/api/auth/me').json['code'] == 'unauthenticated'
    r = official.post('/api/auth/login', json={'email': 'official2@saps.demo', 'password': 'demo1234'})
    assert r.status_code == 403 and 'suspended' in r.json['error']
    assert act(client, 'reactivateUser', id=2)[1]['ok']
    assert act(client, 'reactivateUser', id=2)[1]['ok'] is False
    login(official, 'official2@saps.demo')
    assert [a.action_type for a in AuditLog.query.filter(AuditLog.action_type.in_(['suspend', 'reactivate']))] == \
        ['suspend', 'reactivate']


def test_a_deactivated_account_can_be_reactivated(client, as_role):
    as_role('admin')
    act(client, 'deactivateUser', id=2)
    assert db.session.get(User, 2).account_status == 'deactivated'
    assert act(client, 'reactivateUser', id=2)[1]['ok'] and db.session.get(User, 2).is_active


def test_personnel_number_is_unique_and_profile_is_your_own(client, as_role):
    as_role('admin')
    payload = {'name': 'Sgt. Two', 'email': 'two@saps.demo', 'role': 'official', 'station_id': 1,
               'personnel_number': '7010001', 'phone': '031 555 0100'}
    assert 'personnel number' in act(client, 'saveUser', payload=payload)[1]['error']
    assert act(client, 'saveUser', payload=dict(payload, personnel_number='7099999'))[1]['ok']
    as_role('official')
    assert act(client, 'updateProfile', payload={'phone': 'not a phone'})[1]['ok'] is False
    assert act(client, 'updateProfile', payload={'phone': '082 555 0111'})[1]['ok']
    assert db.session.get(User, 1).phone == '082 555 0111'
    users = client.get('/api/snapshot').json['snapshot']['users']
    me = next(u for u in users if u['id'] == 1)
    other = next(u for u in users if u['id'] == 3)
    assert me['phone'] == '082 555 0111' and 'phone' not in other and 'personnel_number' not in other


def test_stations_have_a_place_on_the_map(app):
    assert all(s.latitude and s.longitude and s.address for s in Station.query)
