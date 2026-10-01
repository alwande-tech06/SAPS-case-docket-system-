import pytest

from app.extensions import db
from app.models import AuditLog, User

from .conftest import act, login


@pytest.mark.parametrize('email,role', [
    ('official@saps.demo', 'official'),
    ('detective@saps.demo', 'detective'),
    ('commander@saps.demo', 'commander'),
    ('admin@saps.demo', 'admin'),
])
def test_login_sets_session_and_dashboard_follows_role(client, email, role):
    r = login(client, email)
    assert r.json['user']['role'] == role and r.json['must_change_password'] is False
    with client.session_transaction() as s:
        assert s['role'] == role
    r = client.get('/dashboard')
    assert r.status_code == 302 and r.headers['Location'].endswith(f'/dashboard-{role}')
    page = client.get(f'/dashboard-{role}')
    assert page.status_code == 200
    assert f'/static/js/{role}.js' in page.get_data(as_text=True)


def test_email_is_case_insensitive(client):
    assert client.post('/api/auth/login', json={'email': '  Official@SAPS.demo ', 'password': 'demo1234'}).status_code == 200


def test_unknown_email_and_wrong_password_get_the_same_answer(client):
    wrong = client.post('/api/auth/login', json={'email': 'official@saps.demo', 'password': 'nope'})
    unknown = client.post('/api/auth/login', json={'email': 'nobody@saps.demo', 'password': 'nope'})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json == unknown.json == {'ok': False, 'code': 'invalid_credentials',
                                          'error': 'That email address and password do not match an account.'}
    with client.session_transaction() as s:
        assert 'user_id' not in s


def test_empty_credentials(client):
    r = client.post('/api/auth/login', json={'email': '', 'password': ''})
    assert r.status_code == 400 and r.json['code'] == 'missing_credentials'


def test_failed_sign_ins_are_audited(client):
    client.post('/api/auth/login', json={'email': 'official@saps.demo', 'password': 'guess'})
    last = AuditLog.query.order_by(AuditLog.id.desc()).first()
    assert last.action_type == 'login_failed' and 'Sgt. M. Dlamini' in last.description


def test_inactive_account(client):
    User.query.filter_by(email='official@saps.demo').one().is_active = False
    db.session.commit()
    # Only the right password reveals that the account is switched off.
    assert client.post('/api/auth/login', json={'email': 'official@saps.demo', 'password': 'x'}).json['code'] == 'invalid_credentials'
    assert client.post('/api/auth/login', json={'email': 'official@saps.demo', 'password': 'demo1234'}).status_code == 403


def test_sign_in_page_lists_no_accounts_or_passwords(client):
    page = client.get('/login').get_data(as_text=True)
    assert 'demo1234' not in page and 'saps.demo' not in page and 'demoList' not in page


def test_me_and_logout(client):
    assert client.get('/api/auth/me').status_code == 401
    login(client, 'commander@saps.demo')
    assert client.get('/api/auth/me').json['user']['name'] == 'Col. N. Zulu'
    assert client.post('/api/auth/logout', json={}).status_code == 200
    assert client.get('/api/auth/me').status_code == 401
    r = client.get('/dashboard')
    assert r.status_code == 302 and r.headers['Location'].endswith('/login')


@pytest.mark.parametrize('page,allowed', [
    ('/dashboard-official', 'official'), ('/official-capture', 'official'), ('/official-cases', 'official'),
    ('/dashboard-detective', 'detective'), ('/dashboard-commander', 'commander'), ('/commander-cases', 'commander'),
    ('/commander-refusals', 'commander'), ('/commander-withdrawals', 'commander'), ('/dashboard-admin', 'admin'),
    ('/admin-reference', 'admin'),
])
def test_staff_pages_are_guarded_on_the_server(client, as_role, page, allowed):
    r = client.get(page)
    assert r.status_code == 302 and r.headers['Location'].endswith('/login')
    as_role(allowed)
    assert client.get(page).status_code == 200
    other = 'detective' if allowed != 'detective' else 'official'
    as_role(other)
    r = client.get(page)
    assert r.status_code == 302 and r.headers['Location'].endswith(f'/dashboard-{other}')


def test_audit_page_is_for_commander_and_admin(client, as_role):
    as_role('commander')
    assert client.get('/audit').status_code == 200
    as_role('admin')
    assert client.get('/audit').status_code == 200
    as_role('official')
    assert client.get('/audit').status_code == 302


def test_passwords_are_hashed(app):
    user = User.query.filter_by(email='admin@saps.demo').one()
    assert user.password_hash != 'demo1234' and user.check_password('demo1234')


def test_new_account_must_change_its_one_time_password(client, as_role):
    as_role('admin')
    status, res, _ = act(client, 'saveUser', payload={'name': 'Sgt. New Person', 'email': 'new@saps.demo',
                                                      'role': 'official', 'station_id': '1'})
    temp = res['temporary_password']
    assert status == 200 and res['ok'] and len(temp) >= 10
    client.post('/api/auth/logout', json={})
    r = login(client, 'new@saps.demo', temp)
    assert r.json['must_change_password'] is True
    # Nothing works until the password is changed.
    assert client.get('/dashboard-official').status_code == 302
    assert act(client, 'openDocket', intakeId=5)[0] == 403
    bad = client.post('/api/auth/password', json={'current': temp, 'new': 'short'})
    assert bad.status_code == 400 and 'at least 10' in bad.json['error']
    ok = client.post('/api/auth/password', json={'current': temp, 'new': 'a-much-longer-one-2026'})
    assert ok.json['ok']
    assert client.get('/dashboard-official').status_code == 200
    client.post('/api/auth/logout', json={})
    assert client.post('/api/auth/login', json={'email': 'new@saps.demo', 'password': temp}).status_code == 401
    login(client, 'new@saps.demo', 'a-much-longer-one-2026')


def test_audit_chain_records_logins_and_detects_tampering(client):
    login(client, 'official@saps.demo')
    client.post('/api/auth/logout', json={})
    last = [e.action_type for e in AuditLog.query.order_by(AuditLog.id.desc()).limit(2)]
    assert last == ['logout', 'login']
    assert AuditLog.verify_chain()['ok']
    entry = AuditLog.query.filter_by(action_type='login').one()
    entry.description = 'edited'
    db.session.commit()
    assert AuditLog.verify_chain() == {'ok': False, 'at': entry.id}


def test_audit_hash_ignores_the_zone_a_timestamp_is_read_back_in():
    from datetime import datetime, timedelta, timezone
    utc = datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)
    sast = utc.astimezone(timezone(timedelta(hours=2)))
    assert AuditLog.compute_hash('0', 'login', 'x', utc) == AuditLog.compute_hash('0', 'login', 'x', sast)
