"""One-time codes by real SMS through BulkSMS (the HTTP call is replaced)."""
import base64
import io
import json
import urllib.error

import pytest

from app.models import Intake
from app.services import otp


class FakeResponse:
    status = 201

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def bulksms(app, monkeypatch):
    sent = []

    def fake_urlopen(req, timeout=None):
        sent.append({'url': req.full_url, 'auth': req.headers['Authorization'],
                     'body': json.loads(req.data.decode())})
        return FakeResponse()

    monkeypatch.setattr(otp.urllib.request, 'urlopen', fake_urlopen)
    app.config.update(SMS_PROVIDER='bulksms', BULKSMS_USERNAME='TOKENID', BULKSMS_PASSWORD='TOKENSECRET')
    return sent


@pytest.mark.parametrize('given,expected', [('082 555 0141', '+27825550141'), ('+27 82 555 0141', '+27825550141'),
                                            ('27825550141', '+27825550141'), ('(073) 555-0145', '+27735550145')])
def test_south_african_numbers_go_out_in_international_form(given, expected):
    assert otp.international(given) == expected


def test_report_code_is_sent_by_sms_and_never_shown(client, bulksms):
    r = client.post('/api/otp/report', json={'name': 'Zanele Mokoena', 'contact': '082 555 0199',
                                             'id_number': '9001015009087'})
    assert r.status_code == 200 and r.json == {'ok': True, 'demo_code': None}
    msg = bulksms[0]
    assert msg['url'] == 'https://api.bulksms.com/v1/messages'
    assert msg['auth'] == 'Basic ' + base64.b64encode(b'TOKENID:TOKENSECRET').decode()
    assert msg['body']['to'] == '+27825550199'
    code = msg['body']['body'].split('code is ')[1][:6]
    # The code that arrived by SMS is the one that files the report.
    filed = client.post('/api/intakes', json={
        'name': 'Zanele Mokoena', 'contact': '082 555 0199', 'id_number': '9001015009087', 'category_id': 1,
        'location': 'Berea', 'description': 'Phone taken.', 'incident_datetime': '2026-09-28T08:00:00Z', 'otp': code})
    assert filed.status_code == 201


def test_tracking_link_code_goes_to_the_number_on_the_report(client, bulksms):
    intake = Intake.query.filter_by(intake_number='INT-2026-DBN-000001').one()
    r = client.post('/api/track/link', json={'reference': intake.intake_number, 'token': intake.track_token,
                                             'id_number': '8804120832087'})
    assert r.json['ok'] and r.json['demo_code'] is None
    assert bulksms[0]['body']['to'] == '+27825550141'


def test_a_failed_send_gives_a_clear_message_not_a_crash(app, client, bulksms, monkeypatch):
    def refuse(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 403, 'Forbidden', {}, io.BytesIO(b'{"title":"No credits"}'))
    monkeypatch.setattr(otp.urllib.request, 'urlopen', refuse)
    r = client.post('/api/otp/report', json={'name': 'Zanele Mokoena', 'contact': '082 555 0199',
                                             'id_number': '9001015009087'})
    assert r.status_code == 503 and r.json['code'] == 'sms_failed' and 'could not send the code' in r.json['error']
    # Nothing half-made is left behind for the next attempt.
    with client.session_transaction() as s:
        assert 'otp_report' not in s


@pytest.fixture
def otp_by_email(app, monkeypatch):
    mailed = []
    import app.services.mail as mail
    monkeypatch.setattr(mail, 'send_email', lambda to, subject, body: mailed.append((to, subject, body)))
    app.config.update(SMS_PROVIDER='email', OTP_EMAIL_TO='presenter@example.org')
    return mailed


def test_demo_codes_can_go_by_email_to_one_inbox(client, otp_by_email):
    r = client.post('/api/otp/report', json={'name': 'Zanele Mokoena', 'contact': '082 555 0199',
                                             'id_number': '9001015009087'})
    assert r.json == {'ok': True, 'demo_code': None}            # still never on the page
    to, subject, body = otp_by_email[0]
    assert to == 'presenter@example.org' and subject == 'SAPS verification code for 0825550199'
    code = body.split('code is ')[1][:6]
    filed = client.post('/api/intakes', json={
        'name': 'Zanele Mokoena', 'contact': '082 555 0199', 'id_number': '9001015009087', 'category_id': 1,
        'location': 'Berea', 'description': 'Phone taken.', 'incident_datetime': '2026-09-28T08:00:00Z', 'otp': code})
    assert filed.status_code == 201


def test_email_codes_without_an_inbox_fail_clearly(app, client, otp_by_email):
    app.config['OTP_EMAIL_TO'] = None
    r = client.post('/api/otp/report', json={'name': 'Zanele Mokoena', 'contact': '082 555 0199',
                                             'id_number': '9001015009087'})
    assert r.status_code == 503 and not otp_by_email


def test_missing_token_is_a_failed_send(app, client, bulksms):
    app.config['BULKSMS_PASSWORD'] = None
    r = client.post('/api/otp/report', json={'name': 'Zanele Mokoena', 'contact': '082 555 0199',
                                             'id_number': '9001015009087'})
    assert r.status_code == 503 and not bulksms
