import pytest

from app import create_app
from app.extensions import db
from app.seed import reset_and_seed
from app.security import reset_rate_limits


@pytest.fixture
def app():
    app = create_app('testing')
    with app.app_context():
        db.create_all()
        reset_and_seed()
        reset_rate_limits()
        yield app
        db.session.remove()
        db.drop_all()


@pytest.fixture
def client(app):
    return app.test_client()


def login(client, email, password='demo1234'):
    r = client.post('/api/auth/login', json={'email': email, 'password': password})
    assert r.status_code == 200, r.json
    return r


def act(client, name, **args):
    """Calls /api/actions/<name>; returns (http status, result, snapshot)."""
    r = client.post(f'/api/actions/{name}', json=args)
    return r.status_code, (r.json or {}).get('result'), (r.json or {}).get('snapshot')


@pytest.fixture
def as_role(client):
    def sign_in(role):
        email = {'official': 'official@saps.demo', 'official2': 'official2@saps.demo',
                 'detective': 'detective@saps.demo', 'commander': 'commander@saps.demo',
                 'admin': 'admin@saps.demo'}[role]
        client.post('/api/auth/logout', json={})
        login(client, email)
        return client
    return sign_in
