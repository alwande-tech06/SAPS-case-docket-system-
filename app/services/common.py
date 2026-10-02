"""Vocabularies, labels and helpers shared by every service.

The lists are the ones in app/static/js/store.js — the pages show them, the
services enforce them, and they must say the same thing.
"""
import base64
import binascii
import re
from datetime import datetime, timezone

from flask import has_request_context, request

from ..extensions import db
from ..models import AuditLog, Notification, StaffNotification, StoredFile, User


class ActionError(Exception):
    """A request the caller had no right to make (as opposed to a rule the
    screen explains, which comes back as {'ok': False, ...})."""

    def __init__(self, message, status=403):
        super().__init__(message)
        self.status = status


# A report may only be turned away at intake for these two reasons.
INTAKE_REFUSAL_REASONS = [
    'No offence disclosed — an element of the definition is missing',
    'Duplicate of an existing report (verified)',
]
NO_OFFENCE_REASON, DUPLICATE_REASON = INTAKE_REFUSAL_REASONS
MISSING_ELEMENTS = ['Legality', 'Conduct']
MIN_REASON_LENGTH = 25

FILING_CATEGORIES = [
    {'key': 'undetected', 'label': 'Undetected / insufficient evidence', 'brought_forward_months': 12},
    {'key': 'pending_arrest', 'label': 'Filed pending arrest'},
    {'key': 'pending_recovery', 'label': 'Filed pending recovery'},
    {'key': 'withdrawn', 'label': 'Withdrawn by complainant'},
    {'key': 'evidence_compromised', 'label': 'Evidence missing or compromised'},
    {'key': 'sent_to_court', 'label': 'Sent to court'},
]

REASSIGNMENT_REASONS = ['Extended sick leave', 'Suspended or under discipline', 'Caseload too high',
                        'Needs more experience', 'Urgency', 'Other']

REOPEN_TRIGGERS = {
    'arrest': 'A circulated suspect was arrested',
    'recovery': 'Circulated property was recovered',
    'forensic': 'A DNA or fingerprint match identified a perpetrator',
    'review': 'Brought-forward review',
}

STATUS_LABELS = {'registered': 'Registered', 'awaiting_assignment': 'Awaiting assignment',
                 'under_investigation': 'Under investigation', 'sent_to_prosecutor': 'Sent to prosecutor',
                 'closed': 'Closed'}
ROLE_LABELS = {'official': 'Police Official', 'detective': 'Detective', 'commander': 'Station Commander',
               'admin': 'Administrator', 'system': 'System'}
CHANNEL_LABELS = {'public_web': 'public web', 'station': 'station terminal',
                  'assisted': 'assisted capture', 'third_party': 'third party'}


def label_status(s):
    return STATUS_LABELS.get(s, s or '—')


def label_role(r):
    return ROLE_LABELS.get(r, r)


def label_channel(c):
    return CHANNEL_LABELS.get(c, c)


def now():
    return datetime.now(timezone.utc)


def text(value):
    return str(value or '').strip()


def user_name(user_id):
    u = db.session.get(User, user_id) if user_id else None
    return u.name if u else 'System'


def audit(action_type, description, actor=None, **kw):
    ip = request.remote_addr if has_request_context() else None
    return AuditLog.record(action_type, description, user=actor, ip_address=ip, **kw)


def notify(intake, message, when=None):
    """Every terminal state ends with the complainant being told; this row is
    the proof that they were."""
    rec = Notification(intake_id=intake.id, docket_id=intake.docket_id, message=message,
                       created_at=when or now())
    db.session.add(rec)
    return rec


# ----- staff notifications (the bell) -----

ROLE_PAGE = {'official': '/dashboard-official', 'detective': '/dashboard-detective',
             'commander': '/dashboard-commander', 'admin': '/dashboard-admin'}


def tell(user_ids, kind, message, link=None, exclude=None):
    """Puts a notification in each of these people's bell."""
    when = now()
    for uid in dict.fromkeys(u for u in user_ids if u and u != exclude):
        db.session.add(StaffNotification(user_id=uid, kind=kind, message=message, link=link, created_at=when))


def tell_role(station_id, role, kind, message, exclude=None):
    """Tells every active person in a role at a station."""
    ids = [u.id for u in User.query.filter_by(station_id=station_id, role=role, is_active=True)]
    tell(ids, kind, message, ROLE_PAGE.get(role), exclude)


def add_months(dt, months):
    month = dt.month - 1 + months
    year, month = dt.year + month // 12, month % 12 + 1
    days = [31, 29 if year % 4 == 0 and (year % 100 or year % 400 == 0) else 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return dt.replace(year=year, month=month, day=min(dt.day, days))


# ----- uploaded files -----

MAX_FILE_BYTES = 5 * 1024 * 1024
DATA_URL = re.compile(r'^data:([\w.+-]+/[\w.+-]+)?(;[\w=.+-]+)*;base64,(.*)$', re.S)


def store_data_url(data_url, file_name, uploaded_by=None, intake_id=None):
    """Turns a data: URL from the browser into a stored file and returns its
    URL. A value that is already one of our file URLs is passed through."""
    value = str(data_url or '')
    if re.fullmatch(r'/api/files/\d+', value):
        return value
    m = DATA_URL.match(value)
    if not m:
        raise ValueError('The file could not be read.')
    try:
        raw = base64.b64decode(m.group(3), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError('The file could not be read.')
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError(f'"{file_name}" is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.')
    f = StoredFile(file_name=text(file_name)[:255] or 'file', content_type=m.group(1) or 'application/octet-stream',
                   size=len(raw), data=raw, intake_id=intake_id,
                   uploaded_by=uploaded_by.id if uploaded_by else None)
    db.session.add(f)
    db.session.flush()
    return f.url
