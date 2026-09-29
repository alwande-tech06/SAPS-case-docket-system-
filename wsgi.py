"""Entry point for a production WSGI server.

    Windows or Linux:  waitress-serve --listen=0.0.0.0:8000 wsgi:app
    Linux:             gunicorn --workers 3 --bind 0.0.0.0:8000 wsgi:app

Put it behind a reverse proxy (nginx, IIS, or a cloud load balancer) that
serves HTTPS, and set FLASK_CONFIG=production.
"""
import os

from app import create_app, scheduler

app = create_app(os.getenv('FLASK_CONFIG', 'production'))
scheduler.start(app)   # only if SCHEDULER_ENABLED; see app/scheduler.py
