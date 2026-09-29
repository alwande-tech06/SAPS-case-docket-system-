"""Automatic escalation (FR37).

A report that no official has disposed of within 24 hours goes to the station
commander as a system-raised escalation, the same kind the commander already
answers on the dashboard. Run by `flask escalate-overdue` from a scheduler, or
by the in-app timer (app/scheduler.py).

Safe to run as often as you like and from more than one process: each report
is locked while it is checked, and one that already has a system escalation is
left alone.
"""
from datetime import timedelta

from ..extensions import db
from ..models import Escalation, Intake
from .common import audit, now

OVERDUE_AFTER = timedelta(hours=24)
REASON = 'Report undisposed for more than 24 hours'


def escalate_overdue(at=None):
    """Raises the escalations that are due and returns the report numbers."""
    at = at or now()
    cutoff = at - OVERDUE_AFTER
    candidates = [i.id for i in Intake.query.filter(Intake.disposition == 'pending', Intake.created_at < cutoff)
                  .order_by(Intake.id)]
    raised = []
    for intake_id in candidates:
        intake = db.session.query(Intake).filter_by(id=intake_id).with_for_update().one()
        already = Escalation.query.filter_by(intake_id=intake.id, raised_by_complainant=False).count()
        if intake.disposition != 'pending' or already:
            db.session.commit()          # releases the lock
            continue
        e = Escalation(intake_id=intake.id, reason=REASON, raised_by_complainant=False, raised_at=at,
                       decision_maker_id=None, routed_upward=False, status='open')
        db.session.add(e)
        db.session.flush()
        audit('escalate', f'System raised escalation: {intake.intake_number} undisposed for more than 24 hours',
              entity_type='escalation', entity_id=e.id)
        db.session.commit()
        raised.append(intake.intake_number)
    return raised
