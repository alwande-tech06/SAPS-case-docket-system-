import os
from datetime import timedelta

from dotenv import load_dotenv

load_dotenv()


def flag(name, default=False):
    value = (os.getenv(name) or '').strip()
    return value.lower() in ('1', 'true', 'yes', 'on') if value else default


def env(*names, default=None):
    """The first of several names that is set and not blank — so the MAIL_*
    names some hosts and guides use work as well as this project's SMTP_* ones,
    and a setting left empty in a hosting dashboard counts as not set."""
    for name in names:
        if os.getenv(name):
            return os.getenv(name)
    return default


def database_url():
    """Hosts such as Render and Heroku hand out postgres://…, which SQLAlchemy
    no longer accepts. Name the dialect and the psycopg (3) driver explicitly."""
    url = os.getenv('DATABASE_URL')
    if url:
        for prefix in ('postgres://', 'postgresql://'):
            if url.startswith(prefix):
                url = 'postgresql+psycopg://' + url[len(prefix):]
    return url


MAIL_HOST = env('SMTP_HOST', 'MAIL_SERVER')
# A BulkSMS API token (Token Id / Token Secret) switches one-time codes to real SMS.
BULKSMS_TOKEN = env('BULKSMS_USERNAME', 'BULKSMS_TOKEN_ID')


class Config:
    SECRET_KEY = env('SECRET_KEY', default='dev-only-change-me')
    SQLALCHEMY_DATABASE_URI = database_url()
    SQLALCHEMY_ENGINE_OPTIONS = {'pool_pre_ping': True}
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    PERMANENT_SESSION_LIFETIME = timedelta(hours=int(env('SESSION_HOURS', default='8')))
    # Photographs arrive base64-encoded inside JSON: five 5 MB files plus overhead.
    MAX_CONTENT_LENGTH = 40 * 1024 * 1024
    # The "Reset demonstration data" button on the sign-in page. Off unless
    # asked for; never on for a real deployment.
    DEMO_MODE = flag('DEMO_MODE', False)
    SMS_PROVIDER = env('SMS_PROVIDER', default='bulksms' if BULKSMS_TOKEN else 'demo')
    BULKSMS_USERNAME = BULKSMS_TOKEN
    BULKSMS_PASSWORD = env('BULKSMS_PASSWORD', 'BULKSMS_TOKEN_SECRET')
    BULKSMS_SENDER = env('BULKSMS_SENDER')      # optional; only a sender ID registered with BulkSMS
    # SMS_PROVIDER=email (demonstrations): the inbox that stands in for every phone.
    OTP_EMAIL_TO = env('OTP_EMAIL_TO')
    RATELIMIT_ENABLED = flag('RATELIMIT_ENABLED', True)

    # Password-reset emails: demo (link shown on screen), console (server log) or
    # smtp — chosen automatically once a mail server is configured.
    EMAIL_PROVIDER = env('EMAIL_PROVIDER', default='smtp' if MAIL_HOST else 'demo')
    SMTP_HOST = MAIL_HOST
    SMTP_PORT = int(env('SMTP_PORT', 'MAIL_PORT', default='587'))
    SMTP_USERNAME = env('SMTP_USERNAME', 'MAIL_USERNAME')
    SMTP_PASSWORD = env('SMTP_PASSWORD', 'MAIL_PASSWORD')
    SMTP_FROM = env('SMTP_FROM', 'MAIL_DEFAULT_SENDER', 'SMTP_USERNAME', 'MAIL_USERNAME')
    SMTP_STARTTLS = flag('SMTP_STARTTLS', True) and flag('MAIL_USE_TLS', True)
    # The address staff reach the site on, for links in emails. Render provides
    # RENDER_EXTERNAL_URL itself; otherwise taken from the request.
    PUBLIC_BASE_URL = env('PUBLIC_BASE_URL', 'RENDER_EXTERNAL_URL')

    # The in-app timer that escalates reports undisposed for 24 hours.
    SCHEDULER_ENABLED = flag('SCHEDULER_ENABLED', False)
    ESCALATION_INTERVAL_MINUTES = int(env('ESCALATION_INTERVAL_MINUTES', default='15'))


class DevelopmentConfig(Config):
    DEBUG = True


class TestingConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = os.getenv('TEST_DATABASE_URL', 'sqlite://')
    SQLALCHEMY_ENGINE_OPTIONS = {}
    DEMO_MODE = True
    SMS_PROVIDER = 'demo'
    RATELIMIT_ENABLED = False
    PASSWORD_HASH_METHOD = 'pbkdf2:sha256:1000'   # fast, for tests only
    EMAIL_PROVIDER = 'demo'
    SCHEDULER_ENABLED = False
    # Never the developer's real mail settings from .env.
    PUBLIC_BASE_URL = SMTP_HOST = SMTP_USERNAME = SMTP_PASSWORD = SMTP_FROM = None
    BULKSMS_USERNAME = BULKSMS_PASSWORD = BULKSMS_SENDER = OTP_EMAIL_TO = None


class ProductionConfig(Config):
    DEBUG = False
    SESSION_COOKIE_SECURE = True
    SMS_PROVIDER = env('SMS_PROVIDER', default='bulksms' if BULKSMS_TOKEN else 'console')
    EMAIL_PROVIDER = env('EMAIL_PROVIDER', default='smtp' if MAIL_HOST else 'console')


config_by_name = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
}
