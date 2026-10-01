"""What a hosted deployment (Render) relies on."""
import importlib

import pytest
from click.testing import CliRunner
from flask.cli import ScriptInfo

from app.extensions import db
from app.models import AuditLog, Category, Station, User


def load_config(monkeypatch, **env):
    # Blank, as a hosting dashboard leaves an unfilled setting — must count as unset.
    for key in ('DATABASE_URL', 'SMTP_HOST', 'MAIL_SERVER', 'SMTP_USERNAME', 'MAIL_USERNAME', 'SMTP_PASSWORD',
                'MAIL_PASSWORD', 'SMTP_FROM', 'MAIL_DEFAULT_SENDER', 'MAIL_PORT', 'SMTP_PORT', 'EMAIL_PROVIDER',
                'PUBLIC_BASE_URL', 'RENDER_EXTERNAL_URL', 'MAIL_USE_TLS', 'SMTP_STARTTLS', 'SMS_PROVIDER'):
        monkeypatch.setenv(key, '')
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import config
    monkeypatch.setattr('dotenv.load_dotenv', lambda *a, **k: None)
    return importlib.reload(config)


@pytest.fixture(autouse=True)
def restore_config():
    yield
    import config
    importlib.reload(config)


@pytest.mark.parametrize('given,expected', [
    ('postgres://u:p@host:5432/db', 'postgresql+psycopg://u:p@host:5432/db'),
    ('postgresql://u:p@host/db', 'postgresql+psycopg://u:p@host/db'),
    ('postgresql+psycopg://u:p@host/db', 'postgresql+psycopg://u:p@host/db'),
    ('sqlite:///x.db', 'sqlite:///x.db'),
])
def test_render_database_urls_are_accepted(monkeypatch, given, expected):
    assert load_config(monkeypatch, DATABASE_URL=given).Config.SQLALCHEMY_DATABASE_URI == expected


def test_mail_names_from_other_guides_work(monkeypatch):
    cfg = load_config(monkeypatch, MAIL_SERVER='smtp.gmail.com', MAIL_PORT='465', MAIL_USERNAME='me@gmail.com',
                      MAIL_PASSWORD='secret', MAIL_DEFAULT_SENDER='SAPS <me@gmail.com>').ProductionConfig
    assert (cfg.SMTP_HOST, cfg.SMTP_PORT, cfg.SMTP_USERNAME, cfg.SMTP_PASSWORD, cfg.SMTP_FROM) == \
        ('smtp.gmail.com', 465, 'me@gmail.com', 'secret', 'SAPS <me@gmail.com>')
    assert cfg.EMAIL_PROVIDER == 'smtp'          # chosen once a mail server is set


def test_sender_defaults_to_the_mail_account(monkeypatch):
    cfg = load_config(monkeypatch, SMTP_HOST='smtp.gmail.com', SMTP_USERNAME='me@gmail.com').Config
    assert cfg.SMTP_FROM == 'me@gmail.com'


def test_links_in_emails_use_the_render_address(monkeypatch):
    cfg = load_config(monkeypatch, RENDER_EXTERNAL_URL='https://saps-docket.onrender.com').Config
    assert cfg.PUBLIC_BASE_URL == 'https://saps-docket.onrender.com'
    assert load_config(monkeypatch).ProductionConfig.EMAIL_PROVIDER == 'console'


def run_bootstrap(app):
    return CliRunner().invoke(app.cli.commands['bootstrap'], obj=ScriptInfo(create_app=lambda: app))


@pytest.fixture
def empty_app(app):
    for table in reversed(db.metadata.sorted_tables):
        db.session.execute(table.delete())
    db.session.commit()
    return app


def test_bootstrap_creates_the_first_admin_on_an_empty_database(empty_app, monkeypatch, client):
    monkeypatch.setenv('ADMIN_EMAIL', 'Head.Admin@saps.example')
    monkeypatch.setenv('ADMIN_PASSWORD', 'a-strong-admin-password-1')
    monkeypatch.setenv('ADMIN_NAME', 'Capt. B. Admin')
    out = run_bootstrap(empty_app)
    assert out.exit_code == 0 and 'Administrator head.admin@saps.example created' in out.output
    assert Station.query.count() == 3 and Category.query.count() == 11
    assert User.query.one().role == 'admin'
    assert client.post('/api/auth/login', json={'email': 'head.admin@saps.example',
                                                'password': 'a-strong-admin-password-1'}).status_code == 200
    # Deploying again changes nothing.
    monkeypatch.setenv('ADMIN_PASSWORD', 'something-else-entirely-2')
    out = run_bootstrap(empty_app)
    assert 'nothing else to do' in out.output and User.query.count() == 1
    assert AuditLog.verify_chain()['ok']


def test_bootstrap_can_load_the_demo_data_once(empty_app, monkeypatch):
    monkeypatch.setenv('SEED_DEMO_DATA', 'true')
    assert 'demonstration data loaded' in run_bootstrap(empty_app).output
    assert User.query.count() == 7
    run_bootstrap(empty_app)
    assert User.query.count() == 7                # never reseeded over a live system


def test_bootstrap_refuses_a_weak_admin_password(empty_app, monkeypatch):
    monkeypatch.setenv('ADMIN_EMAIL', 'a@b.example')
    monkeypatch.setenv('ADMIN_PASSWORD', 'short')
    out = run_bootstrap(empty_app)
    assert out.exit_code != 0 and 'too weak' in out.output and User.query.count() == 0


def test_bootstrap_without_settings_explains_what_to_do(empty_app, monkeypatch):
    monkeypatch.delenv('ADMIN_EMAIL', raising=False)
    monkeypatch.delenv('SEED_DEMO_DATA', raising=False)
    out = run_bootstrap(empty_app)
    assert out.exit_code == 0 and 'ADMIN_EMAIL' in out.output and User.query.count() == 0


def test_deployment_files_agree():
    import pathlib
    import yaml
    root = pathlib.Path(__file__).resolve().parent.parent
    service = yaml.safe_load((root / 'render.yaml').read_text())['services'][0]
    assert service['buildCommand'] == 'bash build.sh' and 'wsgi:app' in service['startCommand']
    assert '$PORT' in service['startCommand']
    keys = {e['key']: e for e in service['envVars']}
    assert keys['FLASK_CONFIG']['value'] == 'production' and keys['SECRET_KEY']['generateValue'] is True
    build = (root / 'build.sh').read_text()
    assert 'flask db upgrade' in build and 'flask bootstrap' in build and 'flask seed' not in build
    assert keys['PYTHON_VERSION']['value'] == (root / '.python-version').read_text().strip()
