"""Staff accounts. Deactivate, never delete: every past audit entry keeps the
person's name, and a person holding open work cannot be switched off."""
import hashlib
import re
import secrets
from datetime import timedelta, timezone

from flask import current_app

from ..extensions import db
from ..models import ROLES, Docket, Evidence, PasswordReset, Specialisation, Station, User
from .common import ActionError, audit, label_role, now, text
from .mail import send_email

MIN_PASSWORD_LENGTH = 10
RESET_TTL = timedelta(minutes=30)


def password_problem(password):
    if len(password or '') < MIN_PASSWORD_LENGTH:
        return f'Use at least {MIN_PASSWORD_LENGTH} characters.'
    if not (re.search(r'[A-Za-z]', password) and re.search(r'\d', password)):
        return 'Use both letters and numbers.'
    return None


def save_user(payload, actor):
    """Create or edit an account. A new account gets a one-time password,
    returned once for the administrator to hand over, and must change it at
    first sign-in."""
    name, email = text(payload.get('name')), text(payload.get('email')).lower()
    if not name or not email:
        return {'ok': False, 'error': 'Name and email address are both required.'}
    if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email):
        return {'ok': False, 'error': 'That is not a valid email address.'}
    role = payload.get('role')
    if role not in ROLES:
        return {'ok': False, 'error': 'Choose a role.'}
    station = db.session.get(Station, int(payload['station_id'])) if str(payload.get('station_id') or '').isdigit() else None
    if station is None:
        return {'ok': False, 'error': 'Choose a station.'}
    spec_id = payload.get('specialisation_id')
    spec = db.session.get(Specialisation, int(spec_id)) if str(spec_id or '').isdigit() else None

    u = db.session.get(User, int(payload['id'])) if str(payload.get('id') or '').isdigit() else None
    clash = User.query.filter(db.func.lower(User.email) == email).first()
    if clash is not None and (u is None or clash.id != u.id):
        return {'ok': False, 'error': 'Another account already uses that email address.'}

    temporary = None
    if u is not None:
        if u.id == actor.id and role != 'admin':
            return {'ok': False, 'error': 'You cannot remove your own administrator role.'}
        u.name, u.email, u.role, u.rank, u.station_id = name, email, role, text(payload.get('rank')), station.id
        u.specialisation_id = spec.id if spec else None
        if payload.get('availability') in ('available', 'on_leave'):
            u.availability = payload['availability']
        audit('update', f'Account updated: {u.name}', actor, entity_type='user', entity_id=u.id)
    else:
        temporary = secrets.token_urlsafe(9)
        u = User(name=name, email=email, role=role, rank=text(payload.get('rank')), station_id=station.id,
                 specialisation_id=spec.id if spec else None, availability='available',
                 max_caseload=12 if role == 'detective' else 0, is_active=True, must_change_password=True)
        u.set_password(temporary)
        db.session.add(u)
        db.session.flush()
        audit('create', f'Account created: {u.name} ({label_role(u.role)})', actor, entity_type='user', entity_id=u.id)
    return {'ok': True, 'user': u.to_dict(), 'temporary_password': temporary}


def deactivate_user(user_id, actor):
    u = db.session.get(User, int(user_id)) if str(user_id).isdigit() else None
    if u is None:
        return {'ok': False, 'error': 'Account not found.'}
    if u.id == actor.id:
        return {'ok': False, 'error': 'You cannot deactivate your own account.'}
    open_ = Docket.query.filter(Docket.detective_id == u.id, Docket.current_status != 'closed').count()
    if open_:
        return {'ok': False, 'error': f'{u.name} still holds {open_} open docket(s). Reassign them before deactivating this account.'}
    held = Evidence.query.filter_by(current_holder_id=u.id).count()
    if held:
        return {'ok': False, 'error': f'{u.name} still holds {held} exhibit(s). Transfer them before deactivating this account.'}
    u.is_active, u.deactivated_at = False, now()
    audit('deactivate', f'Account deactivated: {u.name}. Activity record retained.', actor, entity_type='user', entity_id=u.id)
    return {'ok': True}


def reset_user_password(user_id, actor):
    """An administrator's reset, for someone who cannot reach their email: a
    new one-time password, shown once, to be changed at the next sign-in."""
    u = db.session.get(User, int(user_id)) if str(user_id).isdigit() else None
    if u is None:
        return {'ok': False, 'error': 'Account not found.'}
    if not u.is_active:
        return {'ok': False, 'error': 'That account is deactivated.'}
    if u.id == actor.id:
        return {'ok': False, 'error': 'Change your own password from the sign-in page instead.'}
    temporary = secrets.token_urlsafe(9)
    u.set_password(temporary)
    u.must_change_password = True
    audit('password_reset', f'Password of {u.name} reset by {actor.name}; a one-time password was issued', actor,
          entity_type='user', entity_id=u.id)
    return {'ok': True, 'user': u.to_dict(), 'temporary_password': temporary}


# ----- "forgot your password" -----

def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def request_password_reset(email, base_url):
    """Emails a reset link if the address belongs to an active account. The
    answer is the same either way, so the form cannot be used to find out who
    has an account. Returns the link only in demonstration mode."""
    u = User.query.filter(db.func.lower(User.email) == text(email).lower()).first()
    if u is None or not u.is_active:
        return None
    # One live link at a time: asking again cancels the earlier one.
    for old in PasswordReset.query.filter_by(user_id=u.id, used_at=None):
        old.used_at = now()
    token = secrets.token_urlsafe(32)
    db.session.add(PasswordReset(user_id=u.id, token_hash=_hash(token), expires_at=now() + RESET_TTL))
    link = f'{base_url.rstrip("/")}/reset-password?token={token}'
    send_email(u.email, 'Reset your SAPS docket system password',
               f'Hello {u.name},\n\nSomeone asked to reset the password for this account. To choose a new '
               f'password, open this link within 30 minutes:\n\n{link}\n\nIf it was not you, ignore this email; '
               'your password has not changed.\n')
    audit('password_reset_requested', f'Password reset link sent to {u.name}', entity_type='user', entity_id=u.id)
    return link if current_app.config.get('EMAIL_PROVIDER', 'demo') == 'demo' else None


def reset_token_valid(token):
    rec = PasswordReset.query.filter_by(token_hash=_hash(text(token))).first() if token else None
    if rec is None or rec.used_at is not None:
        return None
    expires = rec.expires_at if rec.expires_at.tzinfo else rec.expires_at.replace(tzinfo=timezone.utc)
    return rec if now() <= expires else None


def complete_password_reset(token, new):
    rec = reset_token_valid(token)
    if rec is None:
        return {'ok': False, 'error': 'This link has expired or has already been used. Ask for a new one.'}
    problem = password_problem(new)
    if problem:
        return {'ok': False, 'error': problem}
    u = db.session.get(User, rec.user_id)
    if not u.is_active:
        raise ActionError('This account has been deactivated.')
    u.set_password(new)
    u.must_change_password = False
    rec.used_at = now()
    audit('password_reset', f'{u.name} reset their password from an emailed link', u, entity_type='user', entity_id=u.id)
    return {'ok': True}


def change_password(user, current, new):
    if not user.check_password(current or ''):
        return {'ok': False, 'error': 'Your current password is not correct.'}
    problem = password_problem(new)
    if problem:
        return {'ok': False, 'error': problem}
    if current == new:
        return {'ok': False, 'error': 'Choose a password different from the current one.'}
    user.set_password(new)
    user.must_change_password = False
    audit('password_change', f'{user.name} changed their password', user, entity_type='user', entity_id=user.id)
    return {'ok': True}
