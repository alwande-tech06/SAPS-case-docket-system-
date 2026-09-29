"""An in-app timer for the jobs that must run without anyone pressing a button.

Off unless SCHEDULER_ENABLED is true. It suits a single server; where the host
offers a scheduler (cron, Windows Task Scheduler, a platform's cron jobs),
prefer running `flask escalate-overdue` from that instead. Running both, or
several server processes each with a timer, is harmless: the job never raises
the same escalation twice.
"""
import os
import threading

_started = False


def start(app):
    global _started
    if _started or not app.config.get('SCHEDULER_ENABLED'):
        return
    # With the development reloader, only the process that serves requests runs it.
    if app.debug and os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        return
    _started = True
    interval = max(60, int(app.config.get('ESCALATION_INTERVAL_MINUTES', 15)) * 60)
    stop = threading.Event()

    def loop():
        from .services.oversight import escalate_overdue
        wait = 30                        # first run soon after start-up, then every interval
        while not stop.wait(wait):
            wait = interval
            with app.app_context():
                try:
                    raised = escalate_overdue()
                    if raised:
                        app.logger.warning('Escalated %d overdue report(s): %s', len(raised), ', '.join(raised))
                except Exception:
                    app.logger.exception('Automatic escalation failed; it will be tried again.')
                    from .extensions import db
                    db.session.rollback()

    threading.Thread(target=loop, name='saps-scheduler', daemon=True).start()
    app.logger.warning('Scheduler on: overdue reports are escalated every %d minutes.', interval // 60)
