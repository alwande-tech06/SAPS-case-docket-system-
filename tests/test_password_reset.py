from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from app.extensions import db
from app.models import AuditLog, PasswordReset, User

from .conftest import act, login


def token_from(link):
    return parse_qs(urlparse(link).query)['token'][0]


def ask(client, email='detective@saps.demo'):
    r = client.post('/api/auth/reset-request', json={'email': email})
    assert r.status_code == 200 and r.json['ok']
    return r.json['demo_link']


def test_forgotten_password_is_reset_from_the_emailed_link(client):
    link = ask(client)
    assert link.startswith('http://localhost/reset-password?token=')
    assert client.get(urlparse(link).path + '?' + urlparse(link).query).status_code == 200
    r = client.post('/api/auth/reset', json={'token': token_from(link), 'new': 'fresh-password-2026'})
    assert r.json == {'ok': True}
    assert client.post('/api/auth/login', json={'email': 'detective@saps.demo', 'password': 'demo1234'}).status_code == 401
    login(client, 'detective@saps.demo', 'fresh-password-2026')
    assert AuditLog.query.filter_by(action_type='password_reset').count() == 1


def test_a_link_works_once_and_expires(client):
    token = token_from(ask(client))
    assert client.post('/api/auth/reset', json={'token': token, 'new': 'fresh-password-2026'}).json['ok']
    again = client.post('/api/auth/reset', json={'token': token, 'new': 'another-password-2026'})
    assert again.status_code == 400 and 'expired or has already been used' in again.json['error']

    token = token_from(ask(client))
    rec = PasswordReset.query.filter_by(used_at=None).one()
    rec.expires_at = rec.expires_at - timedelta(hours=1)
    db.session.commit()
    assert client.post('/api/auth/reset', json={'token': token, 'new': 'another-password-2026'}).status_code == 400
    assert 'cannot be used' in client.get(f'/reset-password?token={token}').get_data(as_text=True)


def test_asking_again_cancels_the_earlier_link(client):
    first = token_from(ask(client))
    second = token_from(ask(client))
    assert client.post('/api/auth/reset', json={'token': first, 'new': 'fresh-password-2026'}).status_code == 400
    assert client.post('/api/auth/reset', json={'token': second, 'new': 'fresh-password-2026'}).json['ok']


def test_the_answer_never_reveals_whether_an_account_exists(client):
    unknown = client.post('/api/auth/reset-request', json={'email': 'nobody@saps.demo'}).json
    User.query.filter_by(email='official2@saps.demo').one().is_active = False
    db.session.commit()
    inactive = client.post('/api/auth/reset-request', json={'email': 'official2@saps.demo'}).json
    assert unknown == inactive == {'ok': True, 'demo_link': None}
    assert PasswordReset.query.count() == 0


def test_the_new_password_must_be_strong(client):
    token = token_from(ask(client))
    r = client.post('/api/auth/reset', json={'token': token, 'new': 'short'})
    assert r.status_code == 400 and 'at least 10' in r.json['error']
    # A weak attempt does not use the link up.
    assert client.post('/api/auth/reset', json={'token': token, 'new': 'good-password-2026'}).json['ok']


def test_only_a_hash_of_the_token_is_stored(client):
    token = token_from(ask(client))
    assert token not in PasswordReset.query.one().token_hash


def test_a_reset_signs_the_account_out_everywhere_else(app):
    elsewhere, here = app.test_client(), app.test_client()
    login(elsewhere, 'detective@saps.demo')
    assert elsewhere.get('/api/auth/me').status_code == 200
    token = token_from(ask(here))
    here.post('/api/auth/reset', json={'token': token, 'new': 'fresh-password-2026'})
    assert elsewhere.get('/api/auth/me').status_code == 401
    assert elsewhere.get('/dashboard-detective').status_code == 302


def test_changing_your_own_password_keeps_you_signed_in_here_only(app):
    elsewhere, here = app.test_client(), app.test_client()
    login(elsewhere, 'official@saps.demo')
    login(here, 'official@saps.demo')
    assert here.post('/api/auth/password', json={'current': 'demo1234', 'new': 'changed-password-2026'}).json['ok']
    assert here.get('/api/auth/me').status_code == 200
    assert elsewhere.get('/api/auth/me').status_code == 401


def test_admin_can_reset_someone_who_cannot_reach_email(client, as_role, app):
    elsewhere = app.test_client()
    login(elsewhere, 'detective@saps.demo')
    as_role('admin')
    res = act(client, 'resetUserPassword', id=3)[1]
    assert res['ok'] and len(res['temporary_password']) >= 10
    assert elsewhere.get('/api/auth/me').status_code == 401
    assert act(client, 'resetUserPassword', id=7)[1]['ok'] is False          # not your own
    client.post('/api/auth/logout', json={})
    r = login(client, 'detective@saps.demo', res['temporary_password'])
    assert r.json['must_change_password'] is True
    as_role('official')
    assert act(client, 'resetUserPassword', id=3)[0] == 403


def test_smtp_sends_the_link_by_email(app, client, monkeypatch):
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            sent.append(('connect', host, port))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self):
            sent.append(('starttls',))

        def login(self, user, password):
            sent.append(('login', user))

        def send_message(self, msg):
            sent.append(('send', msg['To'], msg.get_content()))

    import app.services.mail as mail
    monkeypatch.setattr(mail.smtplib, 'SMTP', FakeSMTP)
    app.config.update(EMAIL_PROVIDER='smtp', SMTP_HOST='smtp.example.org', SMTP_PORT=587, SMTP_FROM='noreply@example.org',
                      SMTP_USERNAME='mailer', SMTP_PASSWORD='x', PUBLIC_BASE_URL='https://dockets.example.org')
    r = client.post('/api/auth/reset-request', json={'email': 'detective@saps.demo'})
    assert r.json == {'ok': True, 'demo_link': None}                          # never on screen outside demo
    assert sent[0] == ('connect', 'smtp.example.org', 587) and ('starttls',) in sent and ('login', 'mailer') in sent
    to, body = sent[-1][1], sent[-1][2]
    assert to == 'detective@saps.demo' and 'https://dockets.example.org/reset-password?token=' in body
