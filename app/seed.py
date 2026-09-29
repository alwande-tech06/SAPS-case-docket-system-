"""Demonstration data — the seed() from app/static/js/store.js, on the server.

Enough to show every accountability feature, including a report deliberately
left undisposed past the 24-hour reconciliation line. Every account's
password is demo1234. Only for demonstration databases: `flask seed` wipes
everything first.
"""
import secrets
from datetime import timedelta, timezone

from .extensions import db
from .models import (Category, Complainant, Counter, Docket, Escalation, Intake, Refusal, Specialisation, Station,
                     StatusHistory, Transfer, User)
from .services.common import DUPLICATE_REASON, audit, label_channel, notify, now
from .services.dockets import auto_assign, open_docket_internal
from .services.intakes import TOKEN_ALPHABET

DEMO_PASSWORD = 'demo1234'

STATIONS = [
    dict(id=1, name='Durban Central SAPS', code='DBN', province='KwaZulu-Natal',
         service_areas=['durban central', 'smith street', 'glenwood', 'berea', 'overport', 'morningside', 'umbilo',
                        'point', 'city centre', 'anton lembede']),
    dict(id=2, name='Umlazi SAPS', code='UML', province='KwaZulu-Natal', service_areas=['umlazi']),
    dict(id=3, name='Pinetown SAPS', code='PTN', province='KwaZulu-Natal',
         service_areas=['pinetown', 'westville', 'kloof', 'new germany']),
]

SPECIALISATIONS = [
    dict(id=1, name='General Detective'),
    dict(id=2, name='FCS (Family Violence, Child Protection and Sexual Offences)'),
    dict(id=3, name='Commercial Crime'),
    dict(id=4, name='Vehicle Crime'),
]

CATEGORIES = [
    dict(id=1, name='Theft', required_specialisation_id=1, sla_days=30, default_priority='Medium'),
    dict(id=2, name='Common assault', required_specialisation_id=1, sla_days=30, default_priority='Medium'),
    dict(id=3, name='Sexual offence', required_specialisation_id=2, sla_days=14, default_priority='Critical',
         protected_from_withdrawal=True),
    dict(id=4, name='Domestic violence', required_specialisation_id=2, sla_days=14, default_priority='High',
         protected_from_withdrawal=True),
    dict(id=5, name='Fraud', required_specialisation_id=3, sla_days=45, default_priority='Medium'),
    dict(id=6, name='Vehicle theft', required_specialisation_id=4, sla_days=30, default_priority='Medium'),
    dict(id=7, name='Burglary', required_specialisation_id=1, sla_days=30, default_priority='Medium'),
    dict(id=8, name='Malicious damage to property', required_specialisation_id=1, sla_days=30, default_priority='Low'),
    dict(id=9, name='Robbery', required_specialisation_id=1, sla_days=30, default_priority='High'),
    dict(id=10, name='Crimen injuria or intimidation', required_specialisation_id=1, sla_days=30,
         default_priority='Medium'),
    dict(id=11, name='Other — to be classified by an official', required_specialisation_id=1, sla_days=30,
         default_priority='Medium', requires_classification=True),
]

USERS = [
    dict(id=1, name='Sgt. M. Dlamini', email='official@saps.demo', role='official', rank='Sergeant',
         station_id=1, specialisation_id=None, availability='available', max_caseload=0),
    dict(id=2, name='Cst. T. Khumalo', email='official2@saps.demo', role='official', rank='Constable',
         station_id=1, specialisation_id=None, availability='available', max_caseload=0),
    dict(id=3, name='Det. S. Pillay', email='detective@saps.demo', role='detective', rank='Detective Sergeant',
         station_id=1, specialisation_id=1, availability='available', max_caseload=12),
    dict(id=4, name='Det. N. Mthembu', email='detective2@saps.demo', role='detective', rank='Detective Constable',
         station_id=1, specialisation_id=2, availability='on_leave', max_caseload=10),
    dict(id=5, name='Det. R. Naidoo', email='detective3@saps.demo', role='detective', rank='Detective Sergeant',
         station_id=1, specialisation_id=4, availability='available', max_caseload=12),
    dict(id=6, name='Col. N. Zulu', email='commander@saps.demo', role='commander', rank='Colonel',
         station_id=1, specialisation_id=None, availability='available', max_caseload=0),
    dict(id=7, name='A. Sithole', email='admin@saps.demo', role='admin', rank='System Administrator',
         station_id=1, specialisation_id=None, availability='available', max_caseload=0),
]

# age = hours since the report was made
REPORTS = [
    dict(name='Thandeka Ngcobo', contact='+27 82 555 0141', gender='Female', id_number='8804120832087', cat=1,
         channel='public_web', loc='14 Smith Street, Durban Central',
         desc='Handbag taken from a parked vehicle overnight.', age=6, action='docket'),
    dict(name='Sipho Mabaso', contact='+27 83 555 0192', gender='Male', id_number='7905235190876', cat=7,
         channel='public_web', loc='8 Broad Street, Glenwood',
         desc='Forced entry through a back window, television removed.', age=40, action='docket_stale'),
    dict(name='Lerato Khoza', contact='+27 71 555 0163', gender='Female', id_number='9207140481083', cat=6,
         channel='station', loc='Parking garage, Anton Lembede Street',
         desc='Vehicle removed from a secured parking bay.', age=12, action='docket'),
    dict(name='Bongani Zwane', contact='+27 84 555 0128', gender='Male', id_number='8511095732081', cat=2,
         channel='assisted', loc='Berea Road taxi rank',
         desc='Assaulted by two men following a dispute over a fare.', age=30, action='refused'),
    dict(name='Nomsa Cele', contact='+27 72 555 0175', gender='Female', id_number='9001010923086', cat=3,
         channel='public_web', loc='Residential address, Overport', desc='Reported for assessment by FCS unit.',
         age=54, action='pending'),
    dict(name='Ayanda Mkhize', contact='+27 76 555 0119', gender='Female', id_number='9503220614087', cat=5,
         channel='public_web', loc='Online transaction, Durban', desc='Funds transferred to a fraudulent account.',
         age=3, action='pending'),
    dict(name='Precious Dube', contact='+27 79 555 0187', gender='Female', id_number='8207300257086', cat=8,
         channel='third_party', loc='School premises, Chatsworth',
         desc='Reported by school principal on behalf of the school.', age=20, action='referred'),
]


def load_reference():
    """Stations, specialisations and crime categories — needed by every deployment."""
    for rows, model in ((STATIONS, Station), (SPECIALISATIONS, Specialisation), (CATEGORIES, Category)):
        for row in rows:
            if db.session.get(model, row['id']) is None:
                db.session.add(model(**row))
    db.session.flush()


def wipe():
    for table in reversed(db.metadata.sorted_tables):
        db.session.execute(table.delete())
    db.session.flush()


def reset_sequences():
    """Explicit ids leave PostgreSQL's sequences behind; move them past the data."""
    if db.engine.dialect.name != 'postgresql':
        return
    for table in db.metadata.sorted_tables:
        if 'id' in table.c and table.c.id.autoincrement is not False and table.name != 'counters':
            db.session.execute(db.text(
                f"SELECT setval(pg_get_serial_sequence('{table.name}', 'id'), "
                f"COALESCE((SELECT MAX(id) FROM {table.name}), 0) + 1, false)"))


def reset_and_seed():
    wipe()
    load_reference()
    for u in USERS:
        user = User(**u, is_active=True, must_change_password=False)
        user.set_password(DEMO_PASSWORD)
        db.session.add(user)
    db.session.flush()
    reset_sequences()
    users = {u.id: u for u in User.query}

    t0 = now()
    hours = lambda h: t0 - timedelta(hours=h)
    days = lambda d: t0 - timedelta(days=d)

    for s in REPORTS:
        station = db.session.get(Station, 1)
        n = Counter.next('complainant')
        comp = Complainant(complainant_number=f'CMP-{n:06d}', name=s['name'], contact=s['contact'],
                           gender=s['gender'], id_number=s['id_number'], verified_at=hours(s['age']))
        db.session.add(comp)
        db.session.flush()
        n = Counter.next('intake')
        created = hours(s['age'])
        intake = Intake(intake_number=f'INT-{t0.year}-{station.code}-{n:06d}',
                        track_token=''.join(secrets.choice(TOKEN_ALPHABET) for _ in range(32)),
                        complainant_id=comp.id, category_id=s['cat'], station_id=station.id, channel=s['channel'],
                        incident_description=s['desc'], incident_location=s['loc'],
                        incident_datetime=hours(s['age'] + 4), created_by=1 if s['channel'] == 'assisted' else None,
                        created_at=created, details={}, suspect={'can_identify': False}, witnesses_reported=[],
                        disposition='pending')
        db.session.add(intake)
        db.session.flush()
        audit('create', f'Report {intake.intake_number} received via {label_channel(s["channel"])}',
              entity_type='intake', entity_id=intake.id, performed_at=created)
        audit('route', f'Routed to {station.name} on incident location', entity_type='intake', entity_id=intake.id,
              performed_at=created)

        if s['action'] in ('docket', 'docket_stale'):
            opened = hours(s['age'] - 2)
            stale = s['action'] == 'docket_stale'
            n = Counter.next('cas')
            cat = db.session.get(Category, s['cat'])
            d = Docket(cas_number=f'CAS-{t0.year}-{station.code}-{n:06d}', intake_id=intake.id,
                       complainant_id=comp.id, category_id=s['cat'], station_id=station.id, registered_by=1,
                       current_status='under_investigation' if stale else 'registered', registered_at=opened,
                       last_activity_at=days(38) if stale else opened, priority=cat.default_priority)
            db.session.add(d)
            db.session.flush()
            intake.disposition, intake.disposed_at, intake.disposed_by, intake.docket_id = \
                'docket_opened', opened, 1, d.id
            db.session.add(StatusHistory(docket_id=d.id, previous_status=None, new_status='registered', changed_by=1,
                                         changed_at=opened, notes='Docket opened from report'))
            audit('create', f'Docket opened from {intake.intake_number}, {d.cas_number} issued', users[1],
                  entity_type='docket', entity_id=d.id, case_id=d.id, performed_at=opened)
            auto_assign(d, opened)
            if stale:
                db.session.add(StatusHistory(docket_id=d.id, previous_status='registered',
                                             new_status='under_investigation', changed_by=3, changed_at=days(38),
                                             notes='Statements being obtained from neighbours'))

        if s['action'] == 'refused':
            at = hours(s['age'] - 1)
            db.session.add(Refusal(intake_id=intake.id, station_id=station.id, officer_id=2,
                                   reason_category=DUPLICATE_REASON,
                                   reason_detail='The same assault was already reported by the complainant three days '
                                                 'earlier under CAS-2026-DBN-000001.',
                                   duplicate_of='CAS-2026-DBN-000001', status='confirmed', raised_at=at, refused_at=at,
                                   complainant_notified_at=at, cosigned_by=1, cosigned_at=at,
                                   cosign_note='Duplicate verified against the original docket.'))
            intake.disposition, intake.disposed_at, intake.disposed_by = 'refused', at, 2
            notify(intake, f'No docket was opened. Reason: {DUPLICATE_REASON}.', at)
            audit('refusal', f'Refusal on {intake.intake_number} signed off — {DUPLICATE_REASON}', users[1],
                  entity_type='intake', entity_id=intake.id, performed_at=at)

        if s['action'] == 'referred':
            # Wrong jurisdiction: registered here first, then transferred.
            at = hours(s['age'] - 1)
            to = Station.query.filter_by(code='PTN').one()
            d, _ = open_docket_internal(intake, users[2], at)
            d.station_id, d.detective_id, d.registered_at, d.last_activity_at = to.id, None, at, at
            from .models import Assignment
            for a in Assignment.query.filter_by(docket_id=d.id, is_active=True):
                a.is_active, a.unassigned_at = False, at
            db.session.add(Transfer(docket_id=d.id, from_station_id=station.id, to_station_id=to.id, transferred_by=2,
                                    transferred_at=at, reason='Incident occurred within the Pinetown policing precinct.'))
            notify(intake, f'Your case number is {d.cas_number}. It was registered at {station.name} and transferred '
                           f'to {to.name}.', at)
            audit('transfer', f'{d.cas_number} registered at {station.name} and transferred to {to.name}', users[2],
                  entity_type='docket', entity_id=d.id, case_id=d.id, performed_at=at)

    db.session.flush()
    stale = Docket.query.filter_by(current_status='under_investigation').order_by(Docket.id).first()
    if stale:
        e = Escalation(docket_id=stale.id, reason='No contact from the investigating officer since the case was opened.',
                       raised_by_complainant=True, raised_at=days(5), status='open')
        db.session.add(e)
        db.session.flush()
        audit('escalate', 'Complainant raised escalation: no contact since the case was opened',
              entity_type='escalation', entity_id=e.id, case_id=stale.id, performed_at=days(5))

    def aware(dt):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

    overdue = next((i for i in Intake.query.filter_by(disposition='pending').order_by(Intake.id)
                    if t0 - aware(i.created_at) > timedelta(hours=24)), None)
    if overdue:
        e = Escalation(intake_id=overdue.id, reason='Report undisposed for more than 24 hours',
                       raised_by_complainant=False, raised_at=hours(30), status='open')
        db.session.add(e)
        db.session.flush()
        audit('escalate', f'System raised escalation: {overdue.intake_number} undisposed for more than 24 hours',
              entity_type='escalation', entity_id=e.id, performed_at=hours(30))

    audit('seed', 'Demonstration data loaded')
    db.session.commit()
