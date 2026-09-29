from datetime import timedelta

from click.testing import CliRunner

from app.extensions import db
from app.models import AuditLog, Escalation, Intake
from app.services.common import now
from app.services.oversight import REASON, escalate_overdue

from .conftest import act


def system_escalations():
    return Escalation.query.filter_by(raised_by_complainant=False, reason=REASON).all()


def test_seeded_overdue_report_is_not_escalated_twice(app):
    # The seed already escalated INT-...-000005 (54 hours old).
    assert len(system_escalations()) == 1
    assert escalate_overdue() == []
    assert len(system_escalations()) == 1


def test_a_report_crosses_24_hours_and_is_escalated_once(app):
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()      # 3 hours old
    assert escalate_overdue() == []
    raised = escalate_overdue(at=now() + timedelta(hours=22))
    assert raised == [fraud.intake_number]
    e = Escalation.query.filter_by(intake_id=fraud.id, raised_by_complainant=False).one()
    assert e.status == 'open' and e.reason == REASON
    assert AuditLog.query.order_by(AuditLog.id.desc()).first().description.startswith('System raised escalation')
    assert escalate_overdue(at=now() + timedelta(hours=30)) == []
    assert AuditLog.verify_chain()['ok']


def test_disposed_reports_are_left_alone(client, as_role):
    as_role('official')
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    act(client, 'openDocket', intakeId=fraud.id)
    assert escalate_overdue(at=now() + timedelta(days=3)) == []


def test_the_commander_sees_and_answers_it(client, as_role):
    fraud = Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one()
    escalate_overdue(at=now() + timedelta(hours=22))
    as_role('commander')
    snap = client.get('/api/snapshot').json['snapshot']
    esc = [e for e in snap['escalations'] if e['intake_id'] == fraud.id]
    assert len(esc) == 1 and esc[0]['status'] == 'open'
    assert act(client, 'respondEscalation', id=esc[0]['id'], outcome='Instruction issued',
               response='Dispose of it today.')[1]['ok']


def test_command_line(app):
    Intake.query.filter_by(intake_number='INT-2026-DBN-000006').one().created_at = now() - timedelta(hours=30)
    db.session.commit()
    runner = CliRunner()
    from flask.cli import ScriptInfo
    info = ScriptInfo(create_app=lambda: app)
    out = runner.invoke(app.cli.commands['escalate-overdue'], obj=info)
    assert out.exit_code == 0 and 'Escalated 1 overdue report(s): INT-2026-DBN-000006' in out.output
    out = runner.invoke(app.cli.commands['escalate-overdue'], obj=info)
    assert 'Escalated 0 overdue report(s).' in out.output


def test_scheduler_is_off_unless_enabled(app):
    from app import scheduler
    scheduler._started = False
    scheduler.start(app)
    assert scheduler._started is False
