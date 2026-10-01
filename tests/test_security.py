"""Protections that apply to every request."""
import pytest

from app.security import reset_rate_limits


def test_api_writes_must_be_json(client):
    r = client.post('/api/auth/login', data={'email': 'official@saps.demo', 'password': 'demo1234'})
    assert r.status_code == 415


def test_security_headers_and_no_caching_of_pages(client):
    r = client.get('/')
    assert r.headers['X-Frame-Options'] == 'DENY'
    assert r.headers['X-Content-Type-Options'] == 'nosniff'
    assert r.headers['Cache-Control'] == 'no-store'
    assert 'no-store' not in client.get('/static/css/style.css').headers.get('Cache-Control', '')


def test_pages_embed_only_what_the_reader_may_see(client):
    page = client.get('/').get_data(as_text=True)
    assert 'window.SAPS_SNAPSHOT' in page
    assert 'Thandeka' not in page and 'official@saps.demo' not in page


def test_sign_in_is_rate_limited(app, client):
    app.config['RATELIMIT_ENABLED'] = True
    reset_rate_limits()
    codes = [client.post('/api/auth/login', json={'email': 'official@saps.demo', 'password': 'x'}).status_code
             for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429


def test_tracking_is_rate_limited(app, client):
    app.config['RATELIMIT_ENABLED'] = True
    reset_rate_limits()
    codes = [client.post('/api/track', json={'reference': 'INT-2026-DBN-000001', 'name': 'guess'}).status_code
             for _ in range(21)]
    assert codes[-1] == 429


def test_demo_reset_only_in_demo_mode(app, client):
    app.config['DEMO_MODE'] = False
    assert client.post('/api/demo/reset', json={}).status_code == 404
    # Not just hidden: the button is not in the page at all.
    assert 'id="resetData"' not in client.get('/login').get_data(as_text=True)
    app.config['DEMO_MODE'] = True
    assert 'id="resetData"' in client.get('/login').get_data(as_text=True)


def test_hidden_always_wins_in_the_stylesheet(client):
    css = client.get('/static/css/style.css').get_data(as_text=True)
    assert '[hidden] { display: none !important; }' in css
    assert 'input[type="email"]' in css


def test_production_refuses_a_weak_secret_key(monkeypatch):
    from app import create_app
    import config
    monkeypatch.setattr(config.ProductionConfig, 'SECRET_KEY', 'dev-only-change-me')
    monkeypatch.setattr(config.ProductionConfig, 'SQLALCHEMY_DATABASE_URI', 'sqlite://')
    with pytest.raises(RuntimeError, match='SECRET_KEY'):
        create_app('production')


@pytest.mark.parametrize('path', ['/track.html?ref=X&t=Y', '/index.html', '/report.html'])
def test_old_file_addresses_still_work(client, path):
    r = client.get(path)
    assert r.status_code == 301 and '.html' not in r.headers['Location']


def test_the_site_opens_on_the_landing_page(client):
    home = client.get('/').get_data(as_text=True)
    assert 'js/report.js' not in home and 'href="/report"' in home and 'href="/track"' in home
    assert 'js/report.js' in client.get('/report').get_data(as_text=True)
    r = client.get('/index')
    assert r.status_code == 301 and r.headers['Location'].endswith('/')
    assert client.get('/index.html').headers['Location'] == '/'


def test_sign_in_page_is_shown_even_when_already_signed_in(client):
    from .conftest import login
    login(client, 'official@saps.demo')
    r = client.get('/login')
    assert r.status_code == 200
    page = r.get_data(as_text=True)
    assert 'id="signedInCard"' in page and 'id="signInCard"' in page
