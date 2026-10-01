"""Database models — one table per entity in the ERD.

Column names are the field names the pages use (the records in
app/static/js/store.js), and to_dict() produces exactly that shape, so the
pages read server data without knowing where it came from.
"""
import hashlib
from datetime import datetime, timezone

from flask import current_app, has_app_context
from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db

ROLES = ('official', 'detective', 'commander', 'admin')
DISPOSITIONS = ('pending', 'docket_opened', 'refused', 'referred', 'withdrawn')
DOCKET_STATUSES = ('registered', 'awaiting_assignment', 'under_investigation', 'sent_to_prosecutor', 'closed')


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    """The format JavaScript's toISOString() produces."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class Record:
    """to_dict() for every model: each column, datetimes as ISO strings."""
    HIDDEN = ()

    def to_dict(self):
        out = {}
        for col in self.__table__.columns:
            if col.key in self.HIDDEN:
                continue
            value = getattr(self, col.key)
            out[col.key] = iso(value) if isinstance(value, datetime) else value
        return out


def ts(**kw):
    return db.Column(db.DateTime(timezone=True), **kw)


def fk(target, **kw):
    return db.Column(db.Integer, db.ForeignKey(target), **kw)


# ----- reference data -----

class Station(Record, db.Model):
    __tablename__ = 'stations'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False, unique=True)
    code = db.Column(db.String(10), nullable=False, unique=True)
    province = db.Column(db.String(60), nullable=False)
    service_areas = db.Column(db.JSON, nullable=False, default=list)


class Specialisation(Record, db.Model):
    __tablename__ = 'specialisations'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False, unique=True)


class Category(Record, db.Model):
    """Crime categories. Priority and specialisation come from here, never from
    whoever is capturing the case."""
    __tablename__ = 'categories'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False, unique=True)
    required_specialisation_id = fk('specialisations.id')
    sla_days = db.Column(db.Integer, nullable=False, default=30)
    default_priority = db.Column(db.String(10), nullable=False, default='Medium')
    protected_from_withdrawal = db.Column(db.Boolean, nullable=False, default=False)
    requires_classification = db.Column(db.Boolean, nullable=False, default=False)


class User(Record, db.Model):
    __tablename__ = 'users'
    HIDDEN = ('password_hash',)
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(254), nullable=False, unique=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.Enum(*ROLES, name='user_role'), nullable=False)
    rank = db.Column(db.String(60))
    station_id = fk('stations.id', nullable=False)
    specialisation_id = fk('specialisations.id')
    availability = db.Column(db.String(20), nullable=False, default='available')
    max_caseload = db.Column(db.Integer, nullable=False, default=0)
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    must_change_password = db.Column(db.Boolean, nullable=False, default=False)
    # Goes up with every new password; a sign-in made before that stops working,
    # so changing or resetting a password signs the account out everywhere else.
    session_version = db.Column(db.Integer, nullable=False, default=0, server_default='0')
    last_login = ts()
    deactivated_at = ts()

    def set_password(self, password):
        # The tests use a cheap method so they run in seconds; everything else
        # uses Werkzeug's default (scrypt).
        method = current_app.config.get('PASSWORD_HASH_METHOD') if has_app_context() else None
        self.password_hash = generate_password_hash(password, method=method) if method else generate_password_hash(password)
        self.session_version = (self.session_version or 0) + 1

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_session(self):
        return {'id': self.id, 'name': self.name, 'role': self.role,
                'station_id': self.station_id, 'rank': self.rank}


# ----- numbering -----

class Counter(db.Model):
    """Sequential reference numbers (INT-, CAS-, CMP-)."""
    __tablename__ = 'counters'
    name = db.Column(db.String(40), primary_key=True)
    value = db.Column(db.Integer, nullable=False)

    @classmethod
    def next(cls, name):
        row = db.session.query(cls).filter_by(name=name).with_for_update().first()
        if row is None:
            row = cls(name=name, value=0)
            db.session.add(row)
        row.value += 1
        db.session.flush()
        return row.value


# ----- reporting -----

class Complainant(Record, db.Model):
    __tablename__ = 'complainants'
    id = db.Column(db.Integer, primary_key=True)
    complainant_number = db.Column(db.String(20), nullable=False, unique=True)
    name = db.Column(db.String(120), nullable=False)
    contact = db.Column(db.String(20), nullable=False)
    # Optional. When given, one-time codes go here instead of by SMS.
    email = db.Column(db.String(254))
    id_number = db.Column(db.String(13), index=True)
    gender = db.Column(db.String(20))
    verified_at = ts()


class Intake(Record, db.Model):
    """A report, before and after an official decides what to do with it."""
    __tablename__ = 'intakes'
    id = db.Column(db.Integer, primary_key=True)
    intake_number = db.Column(db.String(30), nullable=False, unique=True)
    track_token = db.Column(db.String(64), nullable=False)
    complainant_id = fk('complainants.id', nullable=False, index=True)
    category_id = fk('categories.id', nullable=False)
    station_id = fk('stations.id', nullable=False, index=True)
    channel = db.Column(db.String(20), nullable=False)
    incident_description = db.Column(db.Text, nullable=False, default='')
    incident_location = db.Column(db.String(255), nullable=False)
    incident_datetime = ts(nullable=False)
    created_by = fk('users.id')
    created_at = ts(nullable=False, default=utcnow)
    details = db.Column(db.JSON, nullable=False, default=dict)
    suspect = db.Column(db.JSON, nullable=False, default=dict)
    witnesses_reported = db.Column(db.JSON, nullable=False, default=list)
    disposition = db.Column(db.String(20), nullable=False, default='pending')
    disposed_at = ts()
    disposed_by = fk('users.id')
    docket_id = db.Column(db.Integer)   # set once a docket exists; dockets point back with a real FK

    complainant = db.relationship(Complainant)


class Refusal(Record, db.Model):
    """A proposal not to open a docket, and the second signature on it."""
    __tablename__ = 'refusals'
    id = db.Column(db.Integer, primary_key=True)
    intake_id = fk('intakes.id', nullable=False, index=True)
    station_id = fk('stations.id', nullable=False)
    officer_id = fk('users.id', nullable=False)
    reason_category = db.Column(db.String(120), nullable=False)
    reason_detail = db.Column(db.Text, nullable=False)
    duplicate_of = db.Column(db.String(40))
    missing_element = db.Column(db.String(20))
    definition_reference = db.Column(db.String(255))
    status = db.Column(db.String(20), nullable=False)
    raised_at = ts()
    refused_at = ts()
    complainant_notified_at = ts()
    cosigned_by = fk('users.id')
    cosigned_at = ts()
    cosign_note = db.Column(db.Text, nullable=False, default='')
    definition_checked = db.Column(db.Boolean, nullable=False, default=False)
    reversed_official_id = fk('users.id')


# ----- dockets -----

class Docket(Record, db.Model):
    __tablename__ = 'dockets'
    id = db.Column(db.Integer, primary_key=True)
    cas_number = db.Column(db.String(30), nullable=False, unique=True)
    intake_id = fk('intakes.id', nullable=False, index=True)
    complainant_id = fk('complainants.id', nullable=False)
    category_id = fk('categories.id', nullable=False)
    station_id = fk('stations.id', nullable=False, index=True)
    registered_by = fk('users.id')
    current_status = db.Column(db.String(30), nullable=False)
    registered_at = ts(nullable=False)
    last_activity_at = ts(nullable=False)
    detective_id = fk('users.id', index=True)
    closure_type = db.Column(db.String(120))
    brought_forward_at = ts()
    priority = db.Column(db.String(10), nullable=False, default='Medium')


class Transfer(Record, db.Model):
    __tablename__ = 'transfers'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    from_station_id = fk('stations.id', nullable=False)
    to_station_id = fk('stations.id', nullable=False)
    transferred_by = fk('users.id')
    transferred_at = ts(nullable=False)
    reason = db.Column(db.Text, nullable=False)


class Assignment(Record, db.Model):
    __tablename__ = 'assignments'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    detective_id = fk('users.id', nullable=False)
    previous_detective_id = fk('users.id')
    assigned_by = fk('users.id')
    assigned_at = ts(nullable=False)
    assignment_method = db.Column(db.String(30), nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    unassigned_at = ts()
    reason_category = db.Column(db.String(60))
    override_reason = db.Column(db.Text)


class StatusHistory(Record, db.Model):
    __tablename__ = 'status_history'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    previous_status = db.Column(db.String(30))
    new_status = db.Column(db.String(30), nullable=False)
    changed_by = fk('users.id')
    changed_at = ts(nullable=False)
    notes = db.Column(db.Text, nullable=False, default='')


class Note(Record, db.Model):
    """The investigation diary. note_type 'instruction' is a commander's
    instruction with a state; anything else is a progress entry."""
    __tablename__ = 'notes'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    author_id = fk('users.id')
    note_text = db.Column(db.Text, nullable=False)
    note_type = db.Column(db.String(20))
    status = db.Column(db.String(20))
    response = db.Column(db.Text)
    responded_by = fk('users.id')
    responded_at = ts()
    created_at = ts(nullable=False)


class Witness(Record, db.Model):
    __tablename__ = 'witnesses'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    contact = db.Column(db.String(60), nullable=False, default='')
    identified_by = fk('users.id')
    identified_at = ts(nullable=False)
    statement_text = db.Column(db.Text, nullable=False, default='')
    statement_taken_at = ts()
    no_statement_reason = db.Column(db.Text, nullable=False, default='')
    reported_by_complainant = db.Column(db.Boolean, nullable=False, default=False)


class Forensic(Record, db.Model):
    __tablename__ = 'forensics'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    evidence_id = fk('evidence.id')
    description = db.Column(db.Text, nullable=False)
    lab_reference = db.Column(db.String(60), nullable=False)
    submitted_by = fk('users.id')
    submitted_at = ts(nullable=False)
    result = db.Column(db.Text, nullable=False, default='')
    result_at = ts()
    accounted_for_reason = db.Column(db.Text, nullable=False, default='')


class StoredFile(db.Model):
    """Uploaded photographs and documents, served at /api/files/<id>. Records
    hold that URL where the prototype held a data: URL."""
    __tablename__ = 'files'
    id = db.Column(db.Integer, primary_key=True)
    file_name = db.Column(db.String(255), nullable=False)
    content_type = db.Column(db.String(120), nullable=False)
    size = db.Column(db.Integer, nullable=False)
    data = db.Column(db.LargeBinary, nullable=False)
    intake_id = fk('intakes.id', index=True)   # set when a complainant may see it
    uploaded_by = fk('users.id')
    uploaded_at = ts(nullable=False, default=utcnow)

    @property
    def url(self):
        return f'/api/files/{self.id}'


class Evidence(Record, db.Model):
    """Exhibits. image_data_url / suspect_photo_data_url hold file URLs."""
    __tablename__ = 'evidence'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    exhibit_number = db.Column(db.String(30), nullable=False)
    description = db.Column(db.Text, nullable=False)
    evidence_type = db.Column(db.String(60))
    collected_by = fk('users.id')
    collected_at = ts(nullable=False)
    current_holder_id = fk('users.id')
    storage_location = db.Column(db.String(255), nullable=False, default='')
    saps13_number = db.Column(db.String(60))
    image_data_url = db.Column(db.String(255))
    suspect_name = db.Column(db.String(120))
    suspect_id_number = db.Column(db.String(13))
    suspect_photo_data_url = db.Column(db.String(255))
    linked_arrest_id = fk('arrests.id')


class Custody(Record, db.Model):
    __tablename__ = 'custody'
    id = db.Column(db.Integer, primary_key=True)
    evidence_id = fk('evidence.id', nullable=False, index=True)
    from_user_id = fk('users.id')
    to_user_id = fk('users.id', nullable=False)
    transferred_at = ts(nullable=False)
    purpose = db.Column(db.Text, nullable=False, default='')
    acknowledged = db.Column(db.Boolean, nullable=False, default=False)


class Arrest(Record, db.Model):
    __tablename__ = 'arrests'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    accused_name = db.Column(db.String(120), nullable=False)
    arrested_by = fk('users.id')
    arrest_datetime = ts(nullable=False)
    charge_description = db.Column(db.Text, nullable=False, default='')


class Handover(Record, db.Model):
    __tablename__ = 'handovers'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    handed_by = fk('users.id')
    recipient_name = db.Column(db.String(120), nullable=False)
    recipient_organisation = db.Column(db.String(120), nullable=False)
    handover_datetime = ts(nullable=False)
    acknowledged = db.Column(db.Boolean, nullable=False, default=False)
    receipt_reference = db.Column(db.String(60))


class Closure(Record, db.Model):
    """A request to file a docket and the commander's decision on it."""
    __tablename__ = 'closures'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', nullable=False, index=True)
    category = db.Column(db.String(30), nullable=False)
    category_label = db.Column(db.String(120), nullable=False)
    requested_by = fk('users.id', nullable=False)
    requested_at = ts(nullable=False)
    warrant_reference = db.Column(db.String(60))
    circulation_reference = db.Column(db.String(60))
    discrepancy_report = db.Column(db.Text)
    prosecutor_reference = db.Column(db.String(60))
    motivation = db.Column(db.Text, nullable=False, default='')
    status = db.Column(db.String(20), nullable=False)
    decision = db.Column(db.String(20))
    decided_by = fk('users.id')
    decided_at = ts()
    decision_reason = db.Column(db.Text)
    approved_by = fk('users.id')
    approved_at = ts()
    checklist_confirmed = db.Column(db.JSON)


# ----- the complainant's side -----

class Escalation(Record, db.Model):
    __tablename__ = 'escalations'
    id = db.Column(db.Integer, primary_key=True)
    docket_id = fk('dockets.id', index=True)
    intake_id = fk('intakes.id', index=True)
    reason = db.Column(db.Text, nullable=False)
    raised_by_complainant = db.Column(db.Boolean, nullable=False, default=True)
    raised_at = ts(nullable=False)
    commander_id = fk('users.id')
    decision_maker_id = fk('users.id')
    routed_upward = db.Column(db.Boolean, nullable=False, default=False)
    response = db.Column(db.Text)
    responded_at = ts()
    status = db.Column(db.String(20), nullable=False, default='open')


class Notification(Record, db.Model):
    """What the complainant was told. If it is not in this table, it was not sent."""
    __tablename__ = 'notifications'
    id = db.Column(db.Integer, primary_key=True)
    intake_id = fk('intakes.id', nullable=False, index=True)
    docket_id = fk('dockets.id')
    message = db.Column(db.Text, nullable=False)
    created_at = ts(nullable=False)


class Withdrawal(Record, db.Model):
    __tablename__ = 'withdrawals'
    id = db.Column(db.Integer, primary_key=True)
    intake_id = fk('intakes.id', nullable=False, index=True)
    docket_id = fk('dockets.id')
    reason_category = db.Column(db.String(120), nullable=False)
    reason_detail = db.Column(db.Text, nullable=False, default='')
    requested_at = ts(nullable=False)
    protected_category = db.Column(db.Boolean, nullable=False, default=False)
    status = db.Column(db.String(20), nullable=False, default='pending')
    decision = db.Column(db.String(20))
    decided_by = fk('users.id')
    decided_at = ts()
    decision_reason = db.Column(db.Text)


class ComplainantEvidence(Record, db.Model):
    """Files a complainant sent in. data_url holds the file URL."""
    __tablename__ = 'complainant_evidence'
    id = db.Column(db.Integer, primary_key=True)
    intake_id = fk('intakes.id', nullable=False, index=True)
    file_name = db.Column(db.String(255), nullable=False)
    file_type = db.Column(db.String(120), nullable=False)
    file_size = db.Column(db.Integer, nullable=False)
    data_url = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, nullable=False, default='')
    uploaded_at = ts(nullable=False)
    review_status = db.Column(db.String(20), nullable=False, default='pending')
    reviewed_by = fk('users.id')
    reviewed_at = ts()
    review_note = db.Column(db.Text, nullable=False, default='')
    linked_exhibit_id = fk('evidence.id')


# ----- verification -----

class OtpChallenge(db.Model):
    """A one-time code sent to a phone. Only its hash is kept."""
    __tablename__ = 'otp_challenges'
    id = db.Column(db.Integer, primary_key=True)
    purpose = db.Column(db.String(20), nullable=False)
    contact = db.Column(db.String(254), nullable=False)   # a phone number or an email address
    subject = db.Column(db.String(60))
    digest = db.Column(db.String(64), nullable=False)
    expires_at = ts(nullable=False)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    used = db.Column(db.Boolean, nullable=False, default=False)


class PasswordReset(db.Model):
    """A "forgot your password" link. Only a hash of its token is kept, it
    expires, and it works once."""
    __tablename__ = 'password_resets'
    id = db.Column(db.Integer, primary_key=True)
    user_id = fk('users.id', nullable=False, index=True)
    token_hash = db.Column(db.String(64), nullable=False, unique=True)
    expires_at = ts(nullable=False)
    used_at = ts()
    created_at = ts(nullable=False, default=utcnow)


# ----- audit -----

class AuditLog(Record, db.Model):
    """Append-only. Each entry's hash covers the previous entry's hash, so
    changing or removing any row breaks the chain from that point on."""
    __tablename__ = 'audit_log'
    id = db.Column(db.Integer, primary_key=True)
    user_id = fk('users.id')
    user_name = db.Column(db.String(120))
    user_role = db.Column(db.String(20))
    action_type = db.Column(db.String(40), nullable=False)
    entity_type = db.Column(db.String(40))
    entity_id = db.Column(db.Integer)
    case_id = db.Column(db.Integer, index=True)
    description = db.Column(db.Text, nullable=False)
    access_reason = db.Column(db.Text)
    ip_address = db.Column(db.String(45))
    performed_at = ts(nullable=False, default=utcnow)
    prev_hash = db.Column(db.String(64), nullable=False)
    entry_hash = db.Column(db.String(64), nullable=False, unique=True)

    GENESIS = '0' * 64
    HIDDEN = ('ip_address',)

    def to_dict(self):
        out = super().to_dict()
        out['user_name'] = out['user_name'] or 'System'
        out['user_role'] = out['user_role'] or 'system'
        out['entity_type'] = out['entity_type'] or ''
        out['access_reason'] = out['access_reason'] or ''
        return out

    @staticmethod
    def compute_hash(prev_hash, action_type, description, performed_at):
        # PostgreSQL hands timestamps back in the server's zone; hash the UTC form
        # so the same instant always gives the same hash.
        if performed_at.tzinfo is None:
            performed_at = performed_at.replace(tzinfo=timezone.utc)
        performed_at = performed_at.astimezone(timezone.utc)
        payload = '|'.join((prev_hash, action_type, description, performed_at.isoformat()))
        return hashlib.sha256(payload.encode('utf-8')).hexdigest()

    @classmethod
    def record(cls, action_type, description, user=None, entity_type=None, entity_id=None,
               case_id=None, ip_address=None, performed_at=None):
        last = cls.query.order_by(cls.id.desc()).with_for_update().first()
        prev = last.entry_hash if last else cls.GENESIS
        when = performed_at or utcnow()
        entry = cls(user_id=user.id if user else None,
                    user_name=user.name if user else None,
                    user_role=user.role if user else None,
                    action_type=action_type, entity_type=entity_type, entity_id=entity_id,
                    case_id=case_id, description=description, ip_address=ip_address,
                    performed_at=when, prev_hash=prev,
                    entry_hash=cls.compute_hash(prev, action_type, description, when))
        db.session.add(entry)
        db.session.flush()
        return entry

    @classmethod
    def verify_chain(cls):
        """{'ok': True, 'entries': n} when intact, else {'ok': False, 'at': id}."""
        prev, n = cls.GENESIS, 0
        for e in cls.query.order_by(cls.id):
            if e.prev_hash != prev or e.entry_hash != cls.compute_hash(prev, e.action_type, e.description, e.performed_at):
                return {'ok': False, 'at': e.id}
            prev, n = e.entry_hash, n + 1
        return {'ok': True, 'entries': n}
