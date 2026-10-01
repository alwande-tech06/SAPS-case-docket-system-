"""One-time codes that prove a person holds the phone number they gave.

Each code is a row in otp_challenges (hashed, with an expiry and an attempt
count) and the session only remembers which row is this visitor's. Keeping
the count on the server means replaying an old session cookie cannot buy more
guesses. How the code reaches the phone is SMS_PROVIDER:

  demo     — returned to the page and shown on screen (the prototype's behaviour)
  console  — written to the server log, for testing without an SMS account
  bulksms  — sent by SMS through BulkSMS (bulksms.com), with the API token in
             BULKSMS_USERNAME (Token Id) and BULKSMS_PASSWORD (Token Secret)
  email    — demonstrations: emailed to the one inbox in OTP_EMAIL_TO, standing
             in for the phone (uses the same mail settings as password resets)

Never run a public deployment on 'demo': anyone could "verify" any number.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import urllib.error
import urllib.request
from datetime import timedelta, timezone

from flask import current_app, session

from ..extensions import db
from ..models import OtpChallenge, utcnow

TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
BULKSMS_URL = 'https://api.bulksms.com/v1/messages'


class SmsError(Exception):
    """The code could not be sent; the person is asked to try again."""


def _digest(code):
    return hmac.new(current_app.config['SECRET_KEY'].encode(), str(code).encode(), hashlib.sha256).hexdigest()


def international(number):
    """A South African number as an SMS gateway wants it: 082 555 0141 → +27825550141."""
    digits = re.sub(r'[^\d+]', '', str(number or ''))
    if digits.startswith('+'):
        return digits
    if digits.startswith('27') and len(digits) == 11:
        return '+' + digits
    if digits.startswith('0') and len(digits) == 10:
        return '+27' + digits[1:]
    return digits


def _bulksms(number, message):
    cfg = current_app.config
    token_id, secret = cfg.get('BULKSMS_USERNAME'), cfg.get('BULKSMS_PASSWORD')
    if not token_id or not secret:
        raise SmsError('BULKSMS_USERNAME and BULKSMS_PASSWORD are not set.')
    payload = {'to': international(number), 'body': message}
    if cfg.get('BULKSMS_SENDER'):
        payload['from'] = cfg['BULKSMS_SENDER']     # only a sender ID registered with BulkSMS
    auth = base64.b64encode(f'{token_id}:{secret}'.encode()).decode()
    req = urllib.request.Request(BULKSMS_URL, data=json.dumps(payload).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Basic {auth}'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status not in (200, 201):
                raise SmsError(f'BulkSMS answered HTTP {resp.status}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')[:300]
        raise SmsError(f'BulkSMS refused the message (HTTP {e.code}): {detail}') from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise SmsError(f'BulkSMS could not be reached: {e}') from e


def bulksms_profile():
    """The BulkSMS account behind the token, without sending anything — for
    checking the token and the credit balance."""
    cfg = current_app.config
    auth = base64.b64encode(f'{cfg.get("BULKSMS_USERNAME")}:{cfg.get("BULKSMS_PASSWORD")}'.encode()).decode()
    req = urllib.request.Request('https://api.bulksms.com/v1/profile', headers={'Authorization': f'Basic {auth}'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def send_sms(number, message):
    provider = current_app.config.get('SMS_PROVIDER', 'demo')
    if provider == 'demo':
        return   # the page shows the code instead
    if provider == 'console':
        # Warning level, so it appears in a production log (which hides info).
        current_app.logger.warning('SMS to %s: %s', number, message)
        return
    if provider == 'bulksms':
        return _bulksms(number, message)
    if provider == 'email':
        return _by_email(number, message)
    raise SmsError(f'SMS provider "{provider}" is not supported. Use bulksms, email, console or demo.')


def _by_email(number, message):
    """For a demonstration without SMS credits: the text goes by email to one
    inbox (OTP_EMAIL_TO) standing in for the complainant's phone. It still
    reaches a device the official cannot see; production uses bulksms."""
    from .mail import send_email
    to = current_app.config.get('OTP_EMAIL_TO')
    if not to:
        raise SmsError('SMS_PROVIDER=email needs OTP_EMAIL_TO, the inbox standing in for the phone.')
    try:
        send_email(to, f'SAPS verification code for {number}',
                   f'{message}\n\n(This system is in demonstration mode: text messages to {number} are '
                   'delivered to this inbox instead. In production they go by SMS.)')
    except Exception as e:
        raise SmsError(f'The code could not be emailed: {e}') from e


def issue(purpose, contact, subject=None):
    """Sends a fresh code for `purpose` ('report' or 'track') to `contact`.
    Returns the code itself only in demo mode, for the page to show. Raises
    SmsError when the message could not be sent."""
    code = f'{secrets.randbelow(900000) + 100000}'
    rec = OtpChallenge(purpose=purpose, contact=contact, subject=subject, digest=_digest(code),
                       expires_at=utcnow() + TTL, attempts=0, used=False)
    db.session.add(rec)
    db.session.flush()
    try:
        send_sms(contact, f'Your SAPS verification code is {code}. It expires in 10 minutes.')
    except SmsError:
        current_app.logger.exception('One-time code to %s could not be sent', contact)
        raise
    session[f'otp_{purpose}'] = rec.id
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
