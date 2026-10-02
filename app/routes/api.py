"""REST API — /api.

Every change to the data goes through here, so every rule is enforced on the
server whatever the browser does. The pages read from a snapshot of the data
they are entitled to (app/services/snapshot.py); each change returns a fresh
one, which the Store in the browser swaps in.

  /api/auth/...         sign in, sign out, change password
  /api/otp/report       one-time code to the phone of someone reporting
  /api/intakes          file a report (public, or assisted capture by an official)
  /api/track...         a complainant proving a report is theirs
  /api/actions/<name>   every other change, named after the Store function it replaces
  /api/files/<id>       uploaded photographs and documents
  /api/snapshot         the current snapshot, for a page that wants to refresh
"""
import secrets
from datetime import datetime, timezone
from io import BytesIO

from flask import Blueprint, current_app, jsonify, request, send_file, session

from ..extensions import db
from ..models import Docket, Evidence, Intake, StoredFile, User
from ..security import allow, rate_limit, too_many
from ..services import admin as admin_svc
from ..services import dockets as docket_svc
from ..services import intakes as intake_svc
from ..services import otp
from ..services import snapshot
from ..services.common import ActionError, audit

bp = Blueprint('api', __name__, url_prefix='/api')

MAX_TRACKED = 50


def current_user():
    user_id = session.get('user_id')
    if user_id is None:
        return None
    user = db.session.get(User, user_id)
    # A sign-in from before the password last changed no longer counts.
    if user is None or not user.is_active or session.get('sv') != user.session_version:
        # Switched off while signed in: they are told why, once, as they are signed out.
        if user is not None and session.get('sv') is not None and user.account_status in ('suspended', 'deactivated'):
            request.environ['saps.account_off'] = user.account_status
        session.pop('user_id', None)
        session.pop('role', None)
        session.pop('sv', None)
        return None
    return user


def signed_out(message='Sign in to continue.'):
    """The answer to someone with no valid sign-in. If their account was just
    switched off, it says so instead of only sending them to the sign-in form."""
    off = request.environ.get('saps.account_off')
    if off:
        return error(f'This account has been {off}. Speak to your system administrator.', 'inactive', 401)
    return error(message, 'unauthenticated', 401)


def tracked_ids():
    return session.get('tracked', [])


def track(intakes):
    ids = list(dict.fromkeys(tracked_ids() + [i.id for i in intakes]))
    session['tracked'] = ids[-MAX_TRACKED:]


def current_snapshot():
    return snapshot.build(current_user(), tracked_ids(), current_app.config.get('DEMO_MODE', False))


def error(message, code, status):
    return jsonify({'ok': False, 'error': message, 'code': code}), status


def body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@bp.get('/health')
def health():
    return jsonify({'ok': True})


@bp.get('/snapshot')
def get_snapshot():
    return jsonify({'ok': True, 'snapshot': current_snapshot()})


# ----- auth -----

BAD_CREDENTIALS = 'That email address and password do not match an account.'
_dummy_hash = None


def _spend_a_password_check(password):
    """Checks against a throwaway hash, so an unknown email takes as long to
    refuse as a wrong password does."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = User()
        _dummy_hash.set_password(secrets.token_urlsafe(16))
    _dummy_hash.check_password(password)

@bp.post('/auth/login')
@rate_limit('login', 10, 300)
def login():
    data = body()
    email = str(data.get('email', '')).strip().lower()
    password = str(data.get('password', ''))
    if not email or not password:
        return error('Enter your email address and password.', 'missing_credentials', 400)
    user = User.query.filter(db.func.lower(User.email) == email).first()
    # One answer, and the same amount of work, whether the email has an account
    # or the password is wrong — so the form cannot be used to find staff emails.
    if user is None:
        _spend_a_password_check(password)
        return error(BAD_CREDENTIALS, 'invalid_credentials', 401)
    if not user.check_password(password):
        audit('login_failed', f'Failed sign-in for {user.name}', entity_type='user', entity_id=user.id)
        db.session.commit()
        return error(BAD_CREDENTIALS, 'invalid_credentials', 401)
    # Only someone who knows the password learns the account is switched off.
    if not user.is_active:
        state = 'suspended' if user.account_status == 'suspended' else 'deactivated'
        return error(f'This account has been {state}. Speak to your system administrator.', 'inactive', 403)
    user.last_login = datetime.now(timezone.utc)
    audit('login', f'{user.name} signed in', user, entity_type='user', entity_id=user.id)
    db.session.commit()
    session.clear()
    session.permanent = True
    session['user_id'] = user.id
    session['role'] = user.role
    session['sv'] = user.session_version
    return jsonify({'ok': True, 'user': user.to_session(), 'must_change_password': user.must_change_password})


@bp.post('/auth/logout')
def logout():
    user = current_user()
    if user is not None:
        audit('logout', f'{user.name} signed out', user)
        db.session.commit()
    session.clear()
    return jsonify({'ok': True})


@bp.get('/auth/me')
def me():
    user = current_user()
    if user is None:
        return signed_out('Not signed in.')
    return jsonify({'ok': True, 'user': user.to_session(), 'must_change_password': user.must_change_password})


@bp.post('/auth/password')
@rate_limit('password', 10, 300)
def change_password():
    user = current_user()
    if user is None:
        return signed_out()
    data = body()
    res = admin_svc.change_password(user, data.get('current'), data.get('new'))
    db.session.commit()
    if res['ok']:
        session['sv'] = user.session_version     # this sign-in carries on; any other ends
    return jsonify(res), 200 if res['ok'] else 400


@bp.post('/auth/reset-request')
@rate_limit('reset', 5, 900)
def reset_request():
    """"Forgot your password?" — the same answer whether or not the address has
    an account."""
    base = current_app.config.get('PUBLIC_BASE_URL') or request.host_url
    link = admin_svc.request_password_reset(body().get('email'), base)
    db.session.commit()
    return jsonify({'ok': True, 'demo_link': link})


@bp.post('/auth/reset')
@rate_limit('reset', 10, 900)
def reset_password():
    data = body()
    try:
        res = admin_svc.complete_password_reset(data.get('token'), data.get('new'))
    except ActionError as e:
        db.session.rollback()
        return error(str(e), 'forbidden', e.status)
    db.session.commit()
    return jsonify(res), 200 if res['ok'] else 400


# ----- reporting -----

SMS_FAILED = ('We could not send the code to your phone just now. Check the number and try again in a few '
              'minutes, or report at your nearest police station.')
EMAIL_FAILED = ('We could not send the code to your email just now. Check the address and try again in a few '
                'minutes, or leave the email empty to receive it by SMS.')


def phone_digits(value):
    return ''.join(ch for ch in str(value or '') if ch.isdigit() or ch == '+')


def sent_to(email, phone):
    """Where the code went, masked: enough for the person to know where to look."""
    if email:
        return {'channel': 'email', 'to': otp.mask_email(email)}
    digits = ''.join(ch for ch in str(phone or '') if ch.isdigit())
    return {'channel': 'sms', 'to': f'the number ending {digits[-4:]}'}


@bp.post('/otp/report')
@rate_limit('otp', 5, 600)
def otp_for_report():
    """Step one of reporting online: prove the contact — by email when the
    complainant gives an address, otherwise by SMS to their phone."""
    data = body()
    try:
        intake_svc.validate_contact(data.get('name'), data.get('contact'), data.get('id_number'))
        email = intake_svc.clean_email(data.get('email'))
    except intake_svc.ValidationError as e:
        return error(str(e), 'invalid', 400)
    if not email and current_app.config['OTP_CHANNEL'] == 'email':
        return error('Enter your email address. We send the code there.', 'email_required', 400)
    phone = phone_digits(data['contact'])
    try:
        code = otp.issue('report', phone, email=email)
    except otp.SmsError:
        db.session.rollback()
        return error(EMAIL_FAILED if email else SMS_FAILED, 'sms_failed', 503)
    db.session.commit()
    return jsonify({'ok': True, 'demo_code': code, 'sent_to': sent_to(email, phone)})


@bp.post('/intakes')
@rate_limit('report', 20, 3600)
def create_intake():
    """The public reporting form (phone verified by /otp/report), or an
    official capturing a report for someone at the station."""
    data = body()
    user = current_user()
    if user is not None and user.role not in ('official', 'commander'):
        user = None
    if user is None:
        try:
            email = intake_svc.clean_email(data.get('email'))
        except intake_svc.ValidationError as e:
            return error(str(e), 'invalid', 400)
        # The code must have gone to this same email, or this same phone.
        if not otp.check('report', data.get('otp'), contact=email or phone_digits(data.get('contact'))):
            db.session.commit()
            return error('That code does not match the one we sent, or it has expired. Ask for a new one.',
                         'otp_invalid', 400)
    try:
        intake, comp = intake_svc.create_intake(data, actor=user)
    except intake_svc.ValidationError as e:
        db.session.rollback()
        return error(str(e), 'invalid', 400)
    db.session.commit()
    if user is None:
        track([intake])
    return jsonify({'ok': True, 'intake': intake.to_dict(), 'complainant': comp.to_dict(),
                    'snapshot': current_snapshot()}), 201


# ----- complainant tracking -----
# One message for every miss, so the API cannot be used to learn whether a
# reference number or ID number exists.

NOT_FOUND = ('No report found.', 'not_found', 404)


@bp.post('/track')
@rate_limit('track', 20, 600)
def track_lookup():
    data = body()
    name = data.get('name')
    if data.get('reference'):
        found = intake_svc.track_by_reference(data['reference'], name)
    else:
        found = intake_svc.track_by_person(name, data.get('complainant_number'), data.get('id_number'))
    if not found:
        return error(*NOT_FOUND)
    for i in found:
        audit('view', f'Complainant viewed status of {i.intake_number}', entity_type='intake', entity_id=i.id,
              case_id=i.docket_id)
    db.session.commit()
    track(found)
    return jsonify({'ok': True, 'snapshot': current_snapshot()})


@bp.post('/track/link')
@rate_limit('track', 20, 600)
def track_link():
    """A scanned QR code, in three steps: which ID to ask for; the ID number,
    which sends a code to the phone on the report; the code, which opens it."""
    data = body()
    intake = intake_svc.track_link(data.get('reference'), data.get('token'))
    if intake is None:
        return error(*NOT_FOUND)
    comp = intake.complainant
    if 'otp' in data:
        if not otp.check('track', data['otp'], subject=str(intake.id)):
            audit('view', f'Tracking link for {intake.intake_number}: one-time code did not match',
                  entity_type='intake', entity_id=intake.id, case_id=intake.docket_id)
            db.session.commit()
            return error('That code did not match. Check it and try again.', 'otp_invalid', 403)
        audit('view', f'Tracking link for {intake.intake_number}: verified, report shown', entity_type='intake',
              entity_id=intake.id, case_id=intake.docket_id)
        db.session.commit()
        track([intake])
        return jsonify({'ok': True, 'snapshot': current_snapshot()})
    if 'id_number' in data:
        given = ''.join(ch for ch in str(data['id_number']) if ch.isdigit())
        if not comp.id_number or given != comp.id_number:
            audit('view', f'Tracking link for {intake.intake_number}: ID number did not match', entity_type='intake',
                  entity_id=intake.id, case_id=intake.docket_id)
            db.session.commit()
            return error('That is not the ID number recorded on this report.', 'id_mismatch', 403)
        # To the email on the report when there is one, otherwise by SMS —
        # unless codes go only by email and this report has none.
        if not comp.email and current_app.config['OTP_CHANNEL'] == 'email':
            db.session.commit()
            return error('This report has no email address to send a code to. Look it up with the reference '
                         'number and your full name instead, or visit the station.', 'no_email', 409)
        try:
            code = otp.issue('track', comp.contact, subject=str(intake.id), email=comp.email)
        except otp.SmsError:
            db.session.rollback()
            return error(EMAIL_FAILED if comp.email else SMS_FAILED, 'sms_failed', 503)
        db.session.commit()
        return jsonify({'ok': True, 'name': comp.name, 'demo_code': code, 'sent_to': sent_to(comp.email, comp.contact)})
    audit('view', f'Tracking link for {intake.intake_number}: opened, verification started', entity_type='intake',
          entity_id=intake.id, case_id=intake.docket_id)
    db.session.commit()
    return jsonify({'ok': True, 'has_id': bool(comp.id_number), 'id_hint': comp.id_number[-4:] if comp.id_number else None})


# ----- every other change -----

def arg(a, key):
    if key not in a:
        raise ActionError(f'Missing "{key}".', 400)
    return a[key]


ALL_STAFF = ('official', 'detective', 'commander', 'admin')

STAFF_ACTIONS = {
    # intake
    'openDocket': (('official', 'commander'),
                   lambda u, a: intake_svc.open_docket(arg(a, 'intakeId'), u, a.get('options') or {})),
    'recordRefusal': (('official',), lambda u, a: intake_svc.record_refusal(arg(a, 'intakeId'), u, a.get('payload') or {})),
    'requestInfo': (('official',), lambda u, a: intake_svc.request_info(arg(a, 'intakeId'), u, a.get('message'))),
    'cosignRefusal': (('commander',), lambda u, a: intake_svc.cosign_refusal(
        arg(a, 'refusalId'), u, bool(a.get('agree')), a.get('note'), a.get('options') or {})),
    'registerAndTransfer': (('official',), lambda u, a: intake_svc.register_and_transfer(
        arg(a, 'intakeId'), u, a.get('payload') or {})),
    'reviewComplainantEvidence': (('detective',), lambda u, a: intake_svc.review_complainant_evidence(
        arg(a, 'id'), u, a.get('decision'), a.get('note'), a.get('saps13'))),
    'decideWithdrawal': (('commander',), lambda u, a: intake_svc.decide_withdrawal(
        arg(a, 'id'), u, a.get('decision'), a.get('reason'))),
    'respondEscalation': (('commander',), lambda u, a: intake_svc.respond_escalation(
        arg(a, 'id'), u, a.get('outcome'), a.get('response'))),
    # dockets
    'updateStatus': (('detective', 'commander'), lambda u, a: docket_svc.update_status(
        arg(a, 'docketId'), u, a.get('newStatus'), a.get('notes'))),
    'requestClosure': (('detective',), lambda u, a: docket_svc.request_closure(arg(a, 'docketId'), u, a.get('payload') or {})),
    'decideClosure': (('commander',), lambda u, a: docket_svc.decide_closure(
        arg(a, 'closureId'), u, a.get('decision'), a.get('reason'))),
    'reopenDocket': (('detective', 'commander'), lambda u, a: docket_svc.reopen_by_staff(
        arg(a, 'docketId'), u, a.get('payload') or {})),
    'noteBroughtForwardReview': (('commander',), lambda u, a: docket_svc.note_brought_forward_review(arg(a, 'docketId'), u)),
    'addNote': (('detective',), lambda u, a: docket_svc.add_note(arg(a, 'docketId'), u, a.get('text'), a.get('entry'))),
    'acknowledgeDocket': (('detective', 'commander'),
                          lambda u, a: docket_svc.acknowledge_docket(arg(a, 'docketId'), u, a.get('note'))),
    'transferDocket': (('detective', 'commander'),
                       lambda u, a: docket_svc.transfer_docket(arg(a, 'docketId'), u, arg(a, 'toUserId'), a.get('reason'))),
    'recordReview': (('commander',), lambda u, a: docket_svc.record_review(arg(a, 'docketId'), u, a.get('payload') or {})),
    'addInstruction': (('commander',), lambda u, a: docket_svc.add_instruction(arg(a, 'docketId'), u, a.get('text'))),
    'answerInstruction': (('detective',), lambda u, a: docket_svc.answer_instruction(
        arg(a, 'noteId'), u, a.get('outcome'), a.get('response'))),
    'addWitness': (('detective',), lambda u, a: docket_svc.add_witness(arg(a, 'docketId'), u, a.get('payload') or {})),
    'recordWitnessStatement': (('detective',), lambda u, a: docket_svc.record_witness_statement(
        arg(a, 'witnessId'), u, a.get('statementText'), a.get('noStatementReason'))),
    'submitForensic': (('detective',), lambda u, a: docket_svc.submit_forensic(arg(a, 'docketId'), u, a.get('payload') or {})),
    'recordForensicResult': (('detective',), lambda u, a: docket_svc.record_forensic_result(
        arg(a, 'forensicId'), u, a.get('result'), a.get('accountedForReason'))),
    'addEvidence': (('detective',), lambda u, a: docket_svc.add_evidence(arg(a, 'docketId'), u, a.get('payload') or {})),
    'transferEvidence': (('detective',), lambda u, a: docket_svc.transfer_evidence(
        arg(a, 'evidenceId'), u, a.get('toUserId'), a.get('purpose'))),
    'addArrest': (('detective',), lambda u, a: docket_svc.add_arrest(arg(a, 'docketId'), u, a.get('payload') or {})),
    'handover': (('detective',), lambda u, a: docket_svc.handover(arg(a, 'docketId'), u, a.get('payload') or {})),
    'reassign': (('commander',), lambda u, a: docket_svc.reassign(
        arg(a, 'docketId'), u, a.get('detectiveId'), a.get('reason'), a.get('detail'))),
    # administration
    'saveUser': (('admin',), lambda u, a: admin_svc.save_user(a.get('payload') or {}, u)),
    'deactivateUser': (('admin',), lambda u, a: admin_svc.deactivate_user(arg(a, 'id'), u)),
    'resetUserPassword': (('admin',), lambda u, a: admin_svc.reset_user_password(arg(a, 'id'), u)),
    'suspendUser': (('admin',), lambda u, a: admin_svc.suspend_user(arg(a, 'id'), u, a.get('reason'))),
    'reactivateUser': (('admin',), lambda u, a: admin_svc.reactivate_user(arg(a, 'id'), u)),
    # every signed-in member of staff, about their own account
    'updateProfile': (ALL_STAFF, lambda u, a: admin_svc.update_profile(u, a.get('payload') or {})),
    'markNotificationsRead': (ALL_STAFF, lambda u, a: admin_svc.mark_notifications_read(u)),
}


def tracked_intake(intake_id):
    """A report the visitor has proved is theirs this session."""
    if not str(intake_id).isdigit() or int(intake_id) not in tracked_ids():
        raise ActionError('Look the report up again to continue.', 403)
    return db.session.get(Intake, int(intake_id))


def tracked_docket_intake(docket_id):
    d = db.session.get(Docket, int(docket_id)) if str(docket_id).isdigit() else None
    if d is None:
        raise ActionError('Case not found.', 404)
    return tracked_intake(d.intake_id)


COMPLAINANT_ACTIONS = {
    'raiseEscalation': lambda a: intake_svc.raise_escalation(tracked_intake(arg(a, 'intakeId')), a.get('payload') or {}),
    'requestReopenByComplainant': lambda a: intake_svc.reopen_by_complainant(
        tracked_docket_intake(arg(a, 'docketId')), a.get('newEvidence')),
    'requestWithdrawal': lambda a: intake_svc.request_withdrawal(
        tracked_intake(arg(a, 'intakeId')).id, a.get('payload') or {}),
    'respondInfo': lambda a: intake_svc.respond_info(tracked_intake(arg(a, 'intakeId')), a.get('response')),
    'addComplainantEvidence': lambda a: intake_svc.add_complainant_evidence(
        tracked_intake(arg(a, 'intakeId')).id, a.get('files') or [], a.get('description')),
}


@bp.post('/actions/<name>')
def action(name):
    args = body()
    try:
        if name in COMPLAINANT_ACTIONS:
            if not allow('complainant', 30, 600):
                return too_many()
            result = COMPLAINANT_ACTIONS[name](args)
        elif name in STAFF_ACTIONS:
            roles, fn = STAFF_ACTIONS[name]
            user = current_user()
            if user is None:
                return signed_out()
            if user.must_change_password:
                return error('Change your password before continuing.', 'password_change_required', 403)
            if user.role not in roles:
                return error('Your role cannot do that.', 'forbidden', 403)
            result = fn(user, args)
        else:
            return error('Unknown action.', 'not_found', 404)
    except ActionError as e:
        db.session.rollback()
        return error(str(e), 'forbidden' if e.status == 403 else 'invalid', e.status)
    db.session.commit()
    return jsonify({'ok': True, 'result': result, 'snapshot': current_snapshot()})


# ----- files -----

INLINE_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'}


def may_see_file(f, user):
    if user is None:
        return f.intake_id is not None and f.intake_id in tracked_ids()
    if user.role == 'admin':
        return True
    if f.intake_id is not None:
        intake = db.session.get(Intake, f.intake_id)
        if intake and intake.station_id == user.station_id:
            return True
        d = db.session.get(Docket, intake.docket_id) if intake and intake.docket_id else None
        return bool(d and d.station_id == user.station_id)
    ev = Evidence.query.filter((Evidence.image_data_url == f.url) | (Evidence.suspect_photo_data_url == f.url)).first()
    d = db.session.get(Docket, ev.docket_id) if ev else None
    return bool(d and d.station_id == user.station_id)


@bp.get('/files/<int:file_id>')
def get_file(file_id):
    f = db.session.get(StoredFile, file_id)
    if f is None or not may_see_file(f, current_user()):
        return error('File not found.', 'not_found', 404)
    inline = f.content_type in INLINE_TYPES
    resp = send_file(BytesIO(f.data), mimetype=f.content_type if inline else 'application/octet-stream',
                     as_attachment=not inline, download_name=f.file_name)
    # An uploaded file is never allowed to run anything on this origin.
    resp.headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    return resp


# ----- demonstration -----

@bp.post('/demo/reset')
def demo_reset():
    if not current_app.config.get('DEMO_MODE'):
        return error('Not available.', 'not_found', 404)
    from ..seed import reset_and_seed
    reset_and_seed()
    session.clear()
    return jsonify({'ok': True})
