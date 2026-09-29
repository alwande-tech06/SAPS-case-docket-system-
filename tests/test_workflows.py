"""The workflows in the activity diagrams, through the API the pages use."""
import base64

from app.extensions import db
from app.models import (AuditLog, Closure, Custody, Docket, Escalation, Evidence, Intake, Notification, Refusal,
                        Station, User, Withdrawal)

from .conftest import act

PNG = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'0' * 64).decode()


def docket_of(intake_number):
    return Docket.query.join(Intake, Docket.intake_id == Intake.id).filter(Intake.intake_number == intake_number).one()


# ----- Diagram 1/2: disposition at intake -----

def test_open_docket_issues_a_case_number_and_auto_assigns(client, as_role):
    as_role('official')
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    status, res, snap = act(client, 'openDocket', intakeId=fraud.id)
    assert status == 200 and res['docket']['cas_number'] == 'CAS-2026-DBN-000005'
    # No Commercial Crime detective at the station: it waits for the commander.
    assert res['assigned'] is None and res['docket']['current_status'] == 'awaiting_assignment'
    assert db.session.get(Intake, fraud.id).disposition == 'docket_opened'
    assert Notification.query.filter_by(intake_id=fraud.id).count() == 1
    assert any(d['cas_number'] == 'CAS-2026-DBN-000005' for d in snap['dockets'])
    # A report cannot be opened twice.
    assert act(client, 'openDocket', intakeId=fraud.id)[1] is None


def test_other_category_must_be_classified_first(client, as_role):
    as_role('official')
    r = client.post('/api/intakes', json={'name': 'Anele Dube', 'contact': '082 555 0100', 'id_number': '9001015009087',
                                          'category_id': 11, 'location': 'Berea', 'description': 'Something happened',
                                          'incident_datetime': '2026-09-28T08:00:00Z'})
    intake_id = r.json['intake']['id']
    assert act(client, 'openDocket', intakeId=intake_id)[1] is None
    res = act(client, 'openDocket', intakeId=intake_id, options={'category_id': 7})[1]
    assert res['docket']['category_id'] == 7 and res['assigned']['name'] == 'Det. S. Pillay'


def test_refusal_needs_a_second_signature_from_someone_else(client, as_role):
    as_role('official')
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    res = act(client, 'recordRefusal', intakeId=fraud.id, payload={
        'reason_category': 'Not enough evidence', 'reason_detail': 'x' * 30})[1]
    assert res['code'] == 'insufficient_at_intake'
    res = act(client, 'recordRefusal', intakeId=fraud.id, payload={
        'reason_category': 'Duplicate of an existing report (verified)', 'reason_detail': 'Same fraud reported twice by her.',
        'duplicate_of': 'CAS-2026-DBN-999999'})[1]
    assert res['code'] == 'duplicate'          # the duplicate has to exist
    res = act(client, 'recordRefusal', intakeId=fraud.id, payload={
        'reason_category': 'No offence disclosed — an element of the definition is missing',
        'reason_detail': 'The transfer was a loan she agreed to, not a deception.',
        'missing_element': 'Conduct', 'definition_reference': 'Fraud — Crime Definitions Manual'})[1]
    assert res['ok'] and res['refusal']['status'] == 'pending_cosign'
    assert db.session.get(Intake, fraud.id).disposition == 'pending'
    refusal_id = res['refusal']['id']
    # Officials cannot sign; the commander must, with reasons.
    assert act(client, 'cosignRefusal', refusalId=refusal_id, agree=True, note='x' * 30)[0] == 403
    as_role('commander')
    assert act(client, 'cosignRefusal', refusalId=refusal_id, agree=True, note='x' * 30)[1]['code'] == 'cosign'
    res = act(client, 'cosignRefusal', refusalId=refusal_id, agree=True, note='Compared with the definition; no deception.',
              options={'definition_checked': True})[1]
    assert res['ok'] and db.session.get(Intake, fraud.id).disposition == 'refused'


def test_a_rejected_refusal_means_the_docket_is_opened(client, as_role):
    as_role('official')
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    rid = act(client, 'recordRefusal', intakeId=fraud.id, payload={
        'reason_category': 'No offence disclosed — an element of the definition is missing',
        'reason_detail': 'The transfer was a loan she agreed to, not a deception.',
        'missing_element': 'Conduct', 'definition_reference': 'Fraud manual'})[1]['refusal']['id']
    assert act(client, 'openDocket', intakeId=fraud.id)[1] is None   # waiting on the commander
    as_role('commander')
    res = act(client, 'cosignRefusal', refusalId=rid, agree=False, note='The facts do disclose a misrepresentation.')[1]
    assert res['mustOpenDocket'] and db.session.get(Refusal, rid).reversed_official_id == 1
    assert act(client, 'openDocket', intakeId=fraud.id)[1]['docket']['cas_number']


def test_wrong_station_is_registered_here_then_transferred(client, as_role):
    as_role('official')
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    assert act(client, 'registerAndTransfer', intakeId=fraud.id, payload={'to_station_id': 1, 'reason': 'x'})[1]['code'] == 'transfer'
    res = act(client, 'registerAndTransfer', intakeId=fraud.id, payload={'to_station_id': 2, 'reason': 'Happened in Umlazi.'})[1]
    assert res['ok'] and res['docket']['station_id'] == 2 and res['docket']['detective_id'] is None
    assert res['docket']['cas_number'].startswith('CAS-2026-DBN-')   # numbered where it was reported


# ----- Diagram 5: investigation and closure -----

def investigate(client, docket):
    act(client, 'addNote', docketId=docket.id, text='Canvassed neighbours; no witnesses.')
    res = act(client, 'addEvidence', docketId=docket.id, payload={
        'description': 'Broken window latch', 'evidence_type': 'Physical', 'storage_location': 'SAP13 store, shelf 4',
        'saps13_number': 'SAP13/1/2026', 'image_data_url': PNG})[1]
    assert res['ok'], res
    return res['evidence']


def test_closure_is_requested_by_the_detective_and_approved_by_the_commander(client, as_role):
    stale = docket_of('INT-2026-DBN-000002')
    as_role('detective')
    res = act(client, 'requestClosure', docketId=stale.id, payload={'category': 'undetected', 'motivation': 'Nothing more.'})[1]
    assert res['code'] == 'closure_evidence'          # no diary and no exhibit yet
    ev = investigate(client, stale)
    assert ev['image_data_url'].startswith('/api/files/') and ev['exhibit_number'].endswith('-001')
    assert Custody.query.filter_by(evidence_id=ev['id']).count() == 1
    res = act(client, 'requestClosure', docketId=stale.id, payload={'category': 'undetected', 'motivation': 'All leads exhausted.'})[1]
    assert res['ok']
    closure_id = res['closure']['id']

    as_role('commander')
    act(client, 'addInstruction', docketId=stale.id, text='Check the pawn shops in Glenwood.')
    res = act(client, 'decideClosure', closureId=closure_id, decision='approved', reason='Satisfied.')[1]
    assert res['code'] == 'closure_diary'             # the instruction is still open
    as_role('detective')
    note = [n for n in client.get('/api/snapshot').json['snapshot']['notes'] if n['note_type'] == 'instruction'][0]
    assert act(client, 'answerInstruction', noteId=note['id'], outcome='executed', response='Checked three shops.')[1]['ok']
    as_role('commander')
    res = act(client, 'decideClosure', closureId=closure_id, decision='approved', reason='Checklist satisfied.')[1]
    assert res['ok']
    d = db.session.get(Docket, stale.id)
    assert d.current_status == 'closed' and d.brought_forward_at is not None
    assert Notification.query.filter_by(intake_id=d.intake_id).order_by(Notification.id.desc()).first().message.startswith(
        f'Your case {d.cas_number} has been filed')
    # The commander who approved the closure cannot also move the docket.
    res = act(client, 'reassign', docketId=stale.id, detectiveId=3, reason='Urgency', detail='')[1]
    assert res['routedToCluster'] and Escalation.query.filter_by(status='routed_upward').count() == 1


def test_refusing_a_closure_sends_it_back(client, as_role):
    stale = docket_of('INT-2026-DBN-000002')
    as_role('detective')
    investigate(client, stale)
    cid = act(client, 'requestClosure', docketId=stale.id, payload={'category': 'undetected', 'motivation': 'Done.'})[1]['closure']['id']
    as_role('commander')
    assert act(client, 'decideClosure', closureId=cid, decision='refused', reason='Interview the neighbour again.')[1]['ok']
    assert db.session.get(Closure, cid).decision == 'refused'
    assert db.session.get(Docket, stale.id).current_status == 'under_investigation'


def test_only_the_assigned_detective_works_a_docket(client, as_role):
    vehicle = docket_of('INT-2026-DBN-000003')            # assigned to Det. Naidoo, not Det. Pillay
    as_role('detective')
    assert act(client, 'addNote', docketId=vehicle.id, text='Trying.')[0] == 403
    assert act(client, 'addWitness', docketId=vehicle.id, payload={'name': 'X'})[0] == 403


def test_status_cannot_be_set_to_closed(client, as_role):
    theft = docket_of('INT-2026-DBN-000001')
    as_role('detective')
    assert act(client, 'updateStatus', docketId=theft.id, newStatus='closed', notes='x')[1] is None
    assert act(client, 'updateStatus', docketId=theft.id, newStatus='under_investigation', notes='Started.')[1]['current_status'] == 'under_investigation'


def test_witnesses_forensics_arrest_and_handover(client, as_role):
    theft = docket_of('INT-2026-DBN-000001')
    as_role('detective')
    w = act(client, 'addWitness', docketId=theft.id, payload={'name': 'Mr Naidoo', 'contact': '082 555 0000'})[1]['witness']
    assert act(client, 'recordWitnessStatement', witnessId=w['id'], statementText='', noStatementReason='')[1]['ok'] is False
    assert act(client, 'recordWitnessStatement', witnessId=w['id'], statementText='Saw a man run.', noStatementReason='')[1]['ok']
    f = act(client, 'submitForensic', docketId=theft.id, payload={'description': 'Prints', 'lab_reference': 'LCRC-9'})[1]['forensic']
    assert act(client, 'recordForensicResult', forensicId=f['id'], result='No match', accountedForReason='')[1]['ok']
    act(client, 'addArrest', docketId=theft.id, payload={'accused_name': 'J. Doe', 'charge_description': 'Theft'})
    # With a suspect on the case, an exhibit must be linked to them.
    res = act(client, 'addEvidence', docketId=theft.id, payload={
        'description': 'Handbag', 'storage_location': 'Store', 'saps13_number': 'S13/2', 'image_data_url': PNG})[1]
    assert 'linked to a suspect or to a charge' in res['error']
    act(client, 'handover', docketId=theft.id, payload={'recipient_name': 'Adv. Moodley', 'recipient_organisation': 'NPA',
                                                      'receipt_reference': 'NPA-1'})
    assert db.session.get(Docket, theft.id).current_status == 'sent_to_prosecutor'


def test_reopening_a_filed_docket_needs_something_new(client, as_role):
    stale = docket_of('INT-2026-DBN-000002')
    stale.current_status = 'closed'
    db.session.commit()
    as_role('detective')
    assert act(client, 'reopenDocket', docketId=stale.id, payload={'trigger': 'manual'})[1]['ok'] is False
    res = act(client, 'reopenDocket', docketId=stale.id, payload={'trigger': 'manual', 'new_evidence': 'CCTV found.'})[1]
    assert res['ok'] and db.session.get(Docket, stale.id).current_status == 'under_investigation'


# ----- Diagram 7: escalation; withdrawal -----

def test_escalation_cannot_be_answered_by_the_decision_maker(client, as_role):
    as_role('commander')
    esc = Escalation.query.filter_by(intake_id=Intake.query.filter_by(intake_number='INT-2026-DBN-000005').one().id).one()
    res = act(client, 'respondEscalation', id=esc.id, outcome='Instruction issued', response='Dispose today.')[1]
    assert res['ok'] and db.session.get(Escalation, esc.id).status == 'responded'

    # A complainant escalating a refusal the commander himself signed.
    commander = User.query.filter_by(role='commander').one()
    bongani = Intake.query.filter_by(intake_number='INT-2026-DBN-000004').one()
    Refusal.query.filter_by(intake_id=bongani.id).one().officer_id = commander.id
    db.session.commit()
    client.post('/api/auth/logout', json={})
    client.post('/api/track', json={'reference': bongani.intake_number, 'name': 'Bongani Zwane'})
    raised = act(client, 'raiseEscalation', intakeId=bongani.id, payload={'reason': 'The refusal was wrong.'})[1]
    as_role('commander')
    res = act(client, 'respondEscalation', id=raised['id'], outcome='Unfounded', response='It was right.')[1]
    assert res['routedUpward'] and db.session.get(Escalation, raised['id']).status == 'routed_upward'


def test_complainant_actions_need_the_report_to_be_theirs(client):
    theft = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    assert act(client, 'requestWithdrawal', intakeId=theft.id, payload={'reason_category': 'Settled'})[0] == 403
    client.post('/api/track', json={'reference': theft.intake_number, 'name': 'Thandeka Ngcobo'})
    res = act(client, 'requestWithdrawal', intakeId=theft.id, payload={'reason_category': 'Settled privately'})[1]
    assert res['ok'] and res['withdrawal']['status'] == 'pending'
    assert act(client, 'requestWithdrawal', intakeId=theft.id, payload={'reason_category': 'Again'})[1]['ok'] is False


def test_withdrawal_approved_by_the_commander_closes_the_case(client, as_role):
    theft = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    client.post('/api/track', json={'reference': theft.intake_number, 'name': 'Thandeka Ngcobo'})
    wid = act(client, 'requestWithdrawal', intakeId=theft.id, payload={'reason_category': 'Settled'})[1]['withdrawal']['id']
    as_role('commander')
    assert act(client, 'decideWithdrawal', id=wid, decision='approved', reason='')[1]['ok'] is False
    assert act(client, 'decideWithdrawal', id=wid, decision='approved', reason='Voluntary, confirmed by phone.')[1]['ok']
    assert db.session.get(Withdrawal, wid).decision == 'approved'
    assert docket_of(theft.intake_number).current_status == 'closed'


def test_protected_category_withdrawal_can_only_be_noted(client, as_role):
    nomsa = Intake.query.filter_by(intake_number='INT-2026-DBN-000005').one()     # sexual offence
    client.post('/api/track', json={'reference': nomsa.intake_number, 'name': 'Nomsa Cele'})
    wid = act(client, 'requestWithdrawal', intakeId=nomsa.id, payload={'reason_category': 'Pressure'})[1]['withdrawal']['id']
    as_role('commander')
    assert act(client, 'decideWithdrawal', id=wid, decision='approved', reason='Asked to.')[1]['ok'] is False
    assert act(client, 'decideWithdrawal', id=wid, decision='noted', reason='Investigation continues.')[1]['ok']


# ----- evidence from the complainant, and files -----

def test_complainant_evidence_is_reviewed_into_an_exhibit(client, as_role):
    theft = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    client.post('/api/track', json={'reference': theft.intake_number, 'name': 'Thandeka Ngcobo'})
    created = act(client, 'addComplainantEvidence', intakeId=theft.id,
                  files=[{'name': 'bag.png', 'type': 'image/png', 'size': 72, 'dataUrl': PNG}], description='My bag')[1]
    url = created[0]['data_url']
    assert url.startswith('/api/files/') and client.get(url).status_code == 200     # the complainant may see it
    client.post('/api/auth/logout', json={})
    assert client.get(url).status_code == 404                                         # a stranger may not
    as_role('detective')
    assert client.get(url).status_code == 200
    res = act(client, 'reviewComplainantEvidence', id=created[0]['id'], decision='accepted', note='', saps13='S13/9')[1]
    assert res['ok'] and Evidence.query.filter_by(image_data_url=url).count() == 1


def test_uploaded_files_can_never_run_on_this_site(client, as_role):
    theft = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    client.post('/api/track', json={'reference': theft.intake_number, 'name': 'Thandeka Ngcobo'})
    html = 'data:text/html;base64,' + base64.b64encode(b'<script>alert(1)</script>').decode()
    url = act(client, 'addComplainantEvidence', intakeId=theft.id,
              files=[{'name': 'x.html', 'type': 'text/html', 'size': 25, 'dataUrl': html}])[1][0]['data_url']
    r = client.get(url)
    assert r.headers['Content-Type'] == 'application/octet-stream'
    assert r.headers['Content-Disposition'].startswith('attachment')
    assert 'sandbox' in r.headers['Content-Security-Policy']


# ----- stations and roles -----

def test_staff_see_and_act_only_on_their_own_station(client, as_role):
    as_role('admin')
    temp = act(client, 'saveUser', payload={'name': 'Col. P. Mhlongo', 'email': 'umlazi.cmd@saps.demo',
                                            'role': 'commander', 'station_id': 2})[1]['temporary_password']
    client.post('/api/auth/logout', json={})
    client.post('/api/auth/login', json={'email': 'umlazi.cmd@saps.demo', 'password': temp})
    client.post('/api/auth/password', json={'current': temp, 'new': 'umlazi-commander-2026'})
    snap = client.get('/api/snapshot').json['snapshot']
    assert snap['intakes'] == [] and snap['dockets'] == []
    theft = docket_of('INT-2026-DBN-000001')
    assert act(client, 'addInstruction', docketId=theft.id, text='Mine now.')[0] == 403
    assert act(client, 'openDocket', intakeId=6)[0] == 403


def test_roles_are_enforced_whatever_the_browser_sends(client, as_role):
    as_role('official')
    for name in ('decideClosure', 'reassign', 'saveUser', 'addEvidence', 'cosignRefusal'):
        assert act(client, name, closureId=1, docketId=1, refusalId=1, payload={})[0] == 403, name
    client.post('/api/auth/logout', json={})
    assert act(client, 'openDocket', intakeId=6)[0] == 401
    assert act(client, 'noSuchThing')[0] == 404


def test_admin_cannot_deactivate_someone_holding_work(client, as_role):
    as_role('admin')
    res = act(client, 'deactivateUser', id=3)[1]
    assert res['ok'] is False and 'open docket' in res['error']
    assert act(client, 'deactivateUser', id=7)[1]['ok'] is False                      # not yourself
    assert act(client, 'deactivateUser', id=2)[1]['ok']


def test_every_change_is_on_the_audit_chain(client, as_role):
    before = AuditLog.query.count()
    as_role('official')
    act(client, 'openDocket', intakeId=6)
    assert AuditLog.query.count() > before and AuditLog.verify_chain()['ok']
    assert db.session.get(Station, 1) is not None
