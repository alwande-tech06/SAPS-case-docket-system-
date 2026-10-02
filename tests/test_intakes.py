from datetime import date

import pytest

from app.models import AuditLog, Complainant, Intake

from .conftest import login


def report(**overrides):
    data = {
        'name': 'Zanele Mokoena', 'contact': '082 555 0199', 'id_number': '9001015009087',
        'gender': 'Female', 'category_id': 1, 'location': '14 Smith Street, Durban Central',
        'description': 'Phone taken from my bag.', 'incident_datetime': '2026-09-28T08:00:00.000Z',
        'details': {'what_taken': 'Phone', 'blank': '  '},
        'suspect': {'name': '', 'description': 'Tall, red cap'},
        'witnesses': [{'name': 'Sipho', 'contact': ''}, {'name': '  '}],
        'consent': True,
    }
    data.update(overrides)
    return data


def file_report(client, **overrides):
    """The public flow: a code to the phone, then the report with that code."""
    data = report(**overrides)
    sent = client.post('/api/otp/report', json={k: data[k] for k in ('name', 'contact', 'id_number')})
    assert sent.status_code == 200, sent.json
    return client.post('/api/intakes', json=dict(data, otp=sent.json['demo_code']))


def test_public_report_is_numbered_routed_and_shaped_like_store_js(client):
    r = file_report(client)
    assert r.status_code == 201, r.json
    i, c = r.json['intake'], r.json['complainant']
    assert i['intake_number'].endswith('-DBN-000008')           # after the seven seeded reports
    assert i['station_id'] == 1 and i['channel'] == 'public_web' and i['disposition'] == 'pending'
    assert i['created_by'] is None and len(i['track_token']) == 32
    assert i['details'] == {'what_taken': 'Phone'}
    assert i['suspect'] == {'can_identify': True, 'name': '', 'description': 'Tall, red cap', 'contact': ''}
    assert i['witnesses_reported'] == [{'name': 'Sipho', 'contact': ''}]
    assert i['incident_datetime'] == '2026-09-28T08:00:00.000Z' and i['created_at'].endswith('Z')
    assert c['complainant_number'] == 'CMP-000008' and c['verified_at']
    # The person who filed it can see it straight away, and nothing else.
    snap = r.json['snapshot']
    assert [x['id'] for x in snap['intakes']] == [i['id']] and snap['me'] is None
    assert [a.action_type for a in AuditLog.query.order_by(AuditLog.id)][-2:] == ['create', 'route']


def test_public_report_needs_the_code_sent_to_that_phone(client):
    data = report()
    assert client.post('/api/intakes', json=dict(data, otp='123456')).json['code'] == 'otp_invalid'
    sent = client.post('/api/otp/report', json={'name': data['name'], 'contact': '083 555 0100',
                                                'id_number': data['id_number']}).json
    # A code sent to a different number does not verify this one.
    assert client.post('/api/intakes', json=dict(data, otp=sent['demo_code'])).json['code'] == 'otp_invalid'
    sent = client.post('/api/otp/report', json={k: data[k] for k in ('name', 'contact', 'id_number')}).json
    for _ in range(5):
        client.post('/api/intakes', json=dict(data, otp='000000'))
    # Five wrong guesses use the code up, even the right one after them.
    assert client.post('/api/intakes', json=dict(data, otp=sent['demo_code'])).json['code'] == 'otp_invalid'
    assert Intake.query.count() == 7


def test_a_code_works_once(client):
    data = report()
    sent = client.post('/api/otp/report', json={k: data[k] for k in ('name', 'contact', 'id_number')}).json
    assert client.post('/api/intakes', json=dict(data, otp=sent['demo_code'])).status_code == 201
    assert client.post('/api/intakes', json=dict(data, otp=sent['demo_code'])).status_code == 400


@pytest.mark.parametrize('location,code', [('Section V, Umlazi', 'UML'), ('Kloof station road', 'PTN'),
                                           ('Somewhere unlisted', 'DBN')])
def test_routing_by_location(client, location, code):
    assert f'-{code}-' in file_report(client, location=location).json['intake']['intake_number']


def test_same_id_number_is_the_same_complainant(client):
    a = file_report(client).json
    b = file_report(client, contact='083 555 0100').json
    assert a['complainant']['id'] == b['complainant']['id']
    assert b['complainant']['contact'] == '083 555 0100'
    assert Complainant.query.count() == 8


@pytest.mark.parametrize('overrides,message', [
    ({'category_id': 99}, 'type of incident'),
    ({'location': ''}, 'location'),
    ({'description': ''}, 'description'),
    ({'incident_datetime': 'yesterday'}, 'not valid'),
])
def test_invalid_reports_are_refused(client, overrides, message):
    r = file_report(client, **overrides)
    assert r.status_code == 400 and message in r.json['error']
    assert Intake.query.count() == 7


@pytest.mark.parametrize('person,message', [
    ({'name': 'Zanele'}, 'first name and a surname'),
    ({'contact': '12345'}, 'mobile number'),
    ({'id_number': '123'}, '13-digit'),
    ({'id_number': '9013325009087'}, 'not valid'),
])
def test_no_code_is_sent_for_invalid_details(client, person, message):
    data = dict({k: report()[k] for k in ('name', 'contact', 'id_number')}, **person)
    r = client.post('/api/otp/report', json=data)
    assert r.status_code == 400 and message in r.json['error']


def test_sexual_offence_needs_no_typed_description(client):
    assert file_report(client, category_id=3, description='').status_code == 201


def test_minor_cannot_report_online_but_can_be_captured(client):
    minor = f'{(date.today().year - 10) % 100:02d}01015009087'
    assert 'must be 18' in file_report(client, id_number=minor).json['error']
    login(client, 'official@saps.demo')
    r = client.post('/api/intakes', json=report(id_number=minor, channel='assisted', location='Section V, Umlazi'))
    assert r.status_code == 201
    # Captured at the official's own station, whatever the address says.
    assert r.json['intake']['station_id'] == 1 and r.json['intake']['created_by'] == 1
    assert r.json['intake']['channel'] == 'assisted'


def test_public_cannot_pick_a_station_or_channel(client):
    i = file_report(client, station_id=3, channel='assisted').json['intake']
    assert i['station_id'] == 1 and i['channel'] == 'public_web'


def test_tracking_needs_the_right_name_or_id(client):
    miss = {'ok': False, 'error': 'No report found.', 'code': 'not_found'}
    assert client.post('/api/track', json={'reference': 'INT-2026-DBN-000001', 'name': 'Someone Else'}).json == miss
    assert client.post('/api/track', json={'reference': 'INT-2026-DBN-999999', 'name': 'x'}).json == miss
    found = client.post('/api/track', json={'reference': 'int-2026-dbn-000001', 'name': '  thandeka   NGCOBO '}).json
    assert [i['intake_number'] for i in found['snapshot']['intakes']] == ['INT-2026-DBN-000001']
    assert [d['cas_number'] for d in found['snapshot']['dockets']] == ['CAS-2026-DBN-000001']
    by_cas = client.post('/api/track', json={'reference': 'CAS-2026-DBN-000002', 'name': 'Sipho Mabaso'}).json
    assert {i['intake_number'] for i in by_cas['snapshot']['intakes']} == {'INT-2026-DBN-000001', 'INT-2026-DBN-000002'}
    by_id = client.post('/api/track', json={'id_number': '9207140481083', 'name': 'Lerato Khoza'}).json
    assert 'INT-2026-DBN-000003' in [i['intake_number'] for i in by_id['snapshot']['intakes']]
    by_cmp = client.post('/api/track', json={'complainant_number': 'cmp-000004', 'name': 'Bongani Zwane'}).json
    assert 'INT-2026-DBN-000004' in [i['intake_number'] for i in by_cmp['snapshot']['intakes']]


def test_a_complainant_never_sees_staff_data(client):
    snap = client.post('/api/track', json={'reference': 'INT-2026-DBN-000002', 'name': 'Sipho Mabaso'}).json['snapshot']
    assert snap['users'] == [] and snap['notes'] == [] and snap['evidence'] == [] and snap['audit_log'] == []
    assert all('created_by' not in i for i in snap['intakes'])
    assert [c['name'] for c in snap['complainants']] == ['Sipho Mabaso']


def test_tracking_link_needs_the_id_and_a_code_before_showing_anything(client):
    intake = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    ref, token = intake.intake_number, intake.track_token
    assert client.post('/api/track/link', json={'reference': ref, 'token': 'wrong'}).status_code == 404
    hint = client.post('/api/track/link', json={'reference': ref, 'token': token}).json
    assert hint == {'ok': True, 'has_id': True, 'id_hint': '2087'}
    bad = client.post('/api/track/link', json={'reference': ref, 'token': token, 'id_number': '1'})
    assert bad.status_code == 403 and 'snapshot' not in bad.json
    step = client.post('/api/track/link', json={'reference': ref, 'token': token, 'id_number': '8804120832087'}).json
    assert step['ok'] and step['name'] == 'Thandeka Ngcobo' and 'snapshot' not in step
    assert client.post('/api/track/link', json={'reference': ref, 'token': token, 'otp': '000000'}).status_code == 403
    done = client.post('/api/track/link', json={'reference': ref, 'token': token, 'otp': step['demo_code']}).json
    assert [i['id'] for i in done['snapshot']['intakes']] == [intake.id]
