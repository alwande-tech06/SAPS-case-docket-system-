import os
from datetime import timedelta

from dotenv import load_dotenv

load_dotenv()


def flag(name, default=False):
    return os.getenv(name, str(default)).strip().lower() in ('1', 'true', 'yes', 'on')


class Config:
    SECRET_KEY = os.getenv('SECRET_KEY', 'dev-only-change-me')
    SQLALCHEMY_DATABASE_URI = os.getenv('DATABASE_URL')
    SQLALCHEMY_ENGINE_OPTIONS = {'pool_pre_ping': True}
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    PERMANENT_SESSION_LIFETIME = timedelta(hours=int(os.getenv('SESSION_HOURS', '8')))
    # Photographs arrive base64-encoded inside JSON: five 5 MB files plus overhead.
    MAX_CONTENT_LENGTH = 40 * 1024 * 1024
    # Demonstration features: seeded accounts, the "Reset demonstration data"
    # button, one-time codes shown on screen. Never on for a real deployment.
    DEMO_MODE = flag('DEMO_MODE', True)
    SMS_PROVIDER = os.getenv('SMS_PROVIDER', 'demo')
    RATELIMIT_ENABLED = flag('RATELIMIT_ENABLED', True)

    # Password-reset emails: demo (link shown on screen), console (server log) or smtp.
    EMAIL_PROVIDER = os.getenv('EMAIL_PROVIDER', 'demo')
    SMTP_HOST = os.getenv('SMTP_HOST')
    SMTP_PORT = int(os.getenv('SMTP_PORT', '587'))
    SMTP_USERNAME = os.getenv('SMTP_USERNAME')
    SMTP_PASSWORD = os.getenv('SMTP_PASSWORD')
    SMTP_FROM = os.getenv('SMTP_FROM')
    SMTP_STARTTLS = flag('SMTP_STARTTLS', True)
    # The address staff reach the site on, for links in emails. Taken from the
    # request when unset.
    PUBLIC_BASE_URL = os.getenv('PUBLIC_BASE_URL')

    # The in-app timer that escalates reports undisposed for 24 hours.
    SCHEDULER_ENABLED = flag('SCHEDULER_ENABLED', False)
    ESCALATION_INTERVAL_MINUTES = int(os.getenv('ESCALATION_INTERVAL_MINUTES', '15'))


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


class ProductionConfig(Config):
    DEBUG = False
    SESSION_COOKIE_SECURE = True
    DEMO_MODE = flag('DEMO_MODE', False)
    SMS_PROVIDER = os.getenv('SMS_PROVIDER', 'console')
    EMAIL_PROVIDER = os.getenv('EMAIL_PROVIDER', 'console')


config_by_name = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
}
