"""One-time codes that prove a person holds the phone number they gave.

Each code is a row in otp_challenges (hashed, with an expiry and an attempt
count) and the session only remembers which row is this visitor's. Keeping
the count on the server means replaying an old session cookie cannot buy more
guesses. How the code reaches the phone is SMS_PROVIDER:

  demo     — returned to the page and shown on screen (the prototype's behaviour)
  console  — written to the server log, for testing without an SMS account
  (other)  — plug a real gateway into send_sms() below

Never run a public deployment on 'demo': anyone could "verify" any number.
"""
import hashlib
import hmac
import secrets
from datetime import timedelta, timezone

from flask import current_app, session

from ..extensions import db
from ..models import OtpChallenge, utcnow

TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5


def _digest(code):
    return hmac.new(current_app.config['SECRET_KEY'].encode(), str(code).encode(), hashlib.sha256).hexdigest()


def send_sms(number, message):
    provider = current_app.config.get('SMS_PROVIDER', 'demo')
    if provider == 'demo':
        return   # the page shows the code instead
    if provider == 'console':
        # Warning level, so it appears in a production log (which hides info).
        current_app.logger.warning('SMS to %s: %s', number, message)
        return
    raise RuntimeError(f'SMS provider "{provider}" is not configured. See app/services/otp.py.')


def issue(purpose, contact, subject=None):
    """Sends a fresh code for `purpose` ('report' or 'track') to `contact`.
    Returns the code itself only in demo mode, for the page to show."""
    code = f'{secrets.randbelow(900000) + 100000}'
    rec = OtpChallenge(purpose=purpose, contact=contact, subject=subject, digest=_digest(code),
                       expires_at=utcnow() + TTL, attempts=0, used=False)
    db.session.add(rec)
    db.session.flush()
    session[f'otp_{purpose}'] = rec.id
    send_sms(contact, f'Your SAPS verification code is {code}. It expires in 10 minutes.')
    return code if current_app.config.get('SMS_PROVIDER', 'demo') == 'demo' else None


def check(purpose, code, contact=None, subject=None):
    """True once, for the right code, for the number (or subject) it was issued
    for. A wrong code counts against the limit; success uses the code up."""
    rec_id = session.get(f'otp_{purpose}')
    rec = db.session.get(OtpChallenge, rec_id) if rec_id else None
    if rec is None or rec.used or rec.attempts >= MAX_ATTEMPTS:
        return False
    expires = rec.expires_at if rec.expires_at.tzinfo else rec.expires_at.replace(tzinfo=timezone.utc)
    if utcnow() > expires:
        return False
    if (contact is not None and rec.contact != contact) or (subject is not None and rec.subject != subject):
        return False
    if not hmac.compare_digest(rec.digest, _digest(str(code or '').strip())):
        rec.attempts += 1
        db.session.commit()
        return False
    rec.used = True
    session.pop(f'otp_{purpose}', None)
    return True
