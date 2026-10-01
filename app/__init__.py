"""SAPS Case Docket Accountability System — Flask application factory.

Serves the pages (app/routes/pages.py) and the REST API under /api
(app/routes/api.py) from one server, so the browser never makes a
cross-origin request.
"""
import os

import click
from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

import config

from . import security
from .extensions import db, migrate


def create_app(config_name=None):
    config_name = config_name or os.getenv('FLASK_CONFIG', 'development')
    app = Flask(__name__)
    app.config.from_object(config.config_by_name[config_name])
    if not app.config.get('SQLALCHEMY_DATABASE_URI'):
        raise RuntimeError('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
    if app.config['EMAIL_PROVIDER'] == 'smtp' and not (app.config['SMTP_HOST'] and app.config['SMTP_FROM']
                                                        and app.config['SMTP_USERNAME']):
        app.logger.warning('EMAIL_PROVIDER=smtp but SMTP_HOST, SMTP_USERNAME or SMTP_FROM is missing: '
                           'password-reset emails will not be sent.')
    if app.config['SMS_PROVIDER'] == 'bulksms' and not (app.config['BULKSMS_USERNAME'] and app.config['BULKSMS_PASSWORD']):
        app.logger.warning('SMS_PROVIDER=bulksms but BULKSMS_USERNAME or BULKSMS_PASSWORD is missing: '
                           'one-time codes cannot be sent.')
    if config_name == 'production':
        if app.config['SECRET_KEY'] in ('', 'dev-only-change-me', 'CHANGE_ME') or len(app.config['SECRET_KEY']) < 32:
            raise RuntimeError('Set SECRET_KEY to a long random value before running in production.')
        if app.config['DEMO_MODE'] or app.config['SMS_PROVIDER'] == 'demo' or app.config['EMAIL_PROVIDER'] == 'demo':
            app.logger.warning('DEMO_MODE, SMS_PROVIDER=demo or EMAIL_PROVIDER=demo is on in production: codes and '
                               'reset links are shown on screen. Turn them off for real use.')
        if app.config['EMAIL_PROVIDER'] == 'smtp' and not (app.config['SMTP_HOST'] and app.config['SMTP_FROM']):
            raise RuntimeError('EMAIL_PROVIDER=smtp needs SMTP_HOST and SMTP_FROM.')
        # Behind a reverse proxy (nginx, a cloud load balancer) that terminates HTTPS.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)
    migrate.init_app(app, db)
    from . import models  # noqa: F401  (register models for migrations)

    from .routes import api, pages
    app.register_blueprint(api.bp)
    app.register_blueprint(pages.bp)

    security.init_app(app)
    _register_errors(app)
    _register_cli(app)
    return app


def _register_errors(app):
    @app.errorhandler(HTTPException)
    def http_error(e):
        if request.path.startswith('/api/'):
            return jsonify({'ok': False, 'error': e.description, 'code': e.name.lower().replace(' ', '_')}), e.code
        return e

    @app.errorhandler(Exception)
    def unhandled(e):
        db.session.rollback()
        app.logger.exception('Unhandled error on %s', request.path)
        if request.path.startswith('/api/'):
            return jsonify({'ok': False, 'error': 'The server could not complete that request.',
                            'code': 'server_error'}), 500
        raise e


def _register_cli(app):
    @app.cli.command('seed')
    @click.option('--yes', is_flag=True, help='Do not ask for confirmation.')
    def seed_cmd(yes):
        """Wipe ALL data and load the demonstration data (keeps the schema)."""
        if not yes:
            click.confirm('This deletes every report, case and account in the database. Continue?', abort=True)
        from .seed import reset_and_seed
        reset_and_seed()
        click.echo('Demonstration data loaded. All accounts use the password demo1234.')

    @app.cli.command('init-reference')
    def init_reference():
        """Load stations, specialisations and crime categories (safe to repeat)."""
        from .seed import load_reference
        load_reference()
        db.session.commit()
        click.echo('Reference data loaded.')

    @app.cli.command('bootstrap')
    def bootstrap():
        """First-deploy setup, safe to run on every deploy (the hosting build runs it).

        Always loads the reference data. Only while the database has no accounts:
        SEED_DEMO_DATA=true loads the demonstration data; otherwise ADMIN_EMAIL and
        ADMIN_PASSWORD (and ADMIN_NAME) create the first administrator. Never wipes
        or changes an existing system."""
        from .models import User
        from .seed import load_reference, reset_and_seed
        from .services.admin import password_problem
        from .services.common import audit
        load_reference()
        db.session.commit()
        if User.query.count():
            click.echo('Reference data checked. Accounts already exist; nothing else to do.')
            return
        if os.getenv('SEED_DEMO_DATA', '').strip().lower() in ('1', 'true', 'yes', 'on'):
            reset_and_seed()
            click.echo('Empty database: demonstration data loaded (all demo accounts use demo1234).')
            return
        email, password = os.getenv('ADMIN_EMAIL', '').strip().lower(), os.getenv('ADMIN_PASSWORD', '')
        if not email or not password:
            click.echo('Empty database and no ADMIN_EMAIL / ADMIN_PASSWORD set: no one can sign in yet. '
                       'Set them (or SEED_DEMO_DATA=true) and deploy again.')
            return
        problem = password_problem(password)
        if problem:
            raise click.ClickException(f'ADMIN_PASSWORD is too weak: {problem}')
        user = User(name=os.getenv('ADMIN_NAME', 'System Administrator').strip(), email=email, role='admin',
                    station_id=1, is_active=True, must_change_password=False)
        user.set_password(password)
        db.session.add(user)
        db.session.flush()
        audit('create', f'Account created: {user.name} (Administrator) at first deployment',
              entity_type='user', entity_id=user.id)
        db.session.commit()
        click.echo(f'Administrator {email} created.')

    @app.cli.command('create-admin')
    @click.option('--name', prompt=True)
    @click.option('--email', prompt=True)
    @click.option('--station-id', type=int, default=1, show_default=True)
    @click.password_option()
    def create_admin(name, email, station_id, password):
        """Create an administrator account — the first account on a new deployment."""
        from .models import Station, User
        from .services.admin import password_problem
        from .services.common import audit
        problem = password_problem(password)
        if problem:
            raise click.ClickException(problem)
        if db.session.get(Station, station_id) is None:
            raise click.ClickException('No such station. Run "flask init-reference" first.')
        if User.query.filter(db.func.lower(User.email) == email.strip().lower()).first():
            raise click.ClickException('An account with that email already exists.')
        user = User(name=name.strip(), email=email.strip().lower(), role='admin', station_id=station_id,
                    is_active=True, must_change_password=False)
        user.set_password(password)
        db.session.add(user)
        db.session.flush()
        audit('create', f'Account created: {user.name} (Administrator) from the command line',
              entity_type='user', entity_id=user.id)
        db.session.commit()
        click.echo(f'Administrator {user.email} created.')

    @app.cli.command('escalate-overdue')
    def escalate_overdue_cmd():
        """Escalate every report undisposed for more than 24 hours (FR37). Run it
        from a scheduler, e.g. every 15 minutes; it never escalates a report twice."""
        from .services.oversight import escalate_overdue
        raised = escalate_overdue()
        click.echo(f'Escalated {len(raised)} overdue report(s)' + (': ' + ', '.join(raised) if raised else '.'))

    @app.cli.command('sms-check')
    def sms_check():
        """Check the BulkSMS token and show the credit balance. Sends nothing."""
        import urllib.error
        from .services.otp import bulksms_profile
        if not (app.config.get('BULKSMS_USERNAME') and app.config.get('BULKSMS_PASSWORD')):
            raise click.ClickException('Set BULKSMS_USERNAME (Token Id) and BULKSMS_PASSWORD (Token Secret) first.')
        try:
            profile = bulksms_profile()
        except urllib.error.HTTPError as e:
            raise click.ClickException(f'BulkSMS refused the token (HTTP {e.code}). Check the Token Id and Secret.')
        except urllib.error.URLError as e:
            raise click.ClickException(f'BulkSMS could not be reached: {e.reason}')
        credits = (profile.get('credits') or {}).get('balance')
        click.echo(f'BulkSMS token works for {profile.get("username", "the account")}. Credits left: {credits}. '
                   f'SMS_PROVIDER is "{app.config["SMS_PROVIDER"]}".')

    @app.cli.command('verify-audit')
    def verify_audit():
        """Walk the SHA-256 audit chain and report the first broken link, if any."""
        from .models import AuditLog
        res = AuditLog.verify_chain()
        click.echo(f'Audit chain intact across {res["entries"]} entries.' if res['ok']
                   else f'Audit chain broken at entry {res["at"]}.')
