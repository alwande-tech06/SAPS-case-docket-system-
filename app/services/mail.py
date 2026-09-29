"""Email to staff (password-reset links). EMAIL_PROVIDER decides how it goes:

  demo     — not sent; the page shows the link instead (demonstration only)
  console  — written to the server log, for testing a production build
  smtp     — sent through the mail server in SMTP_HOST / SMTP_PORT /
             SMTP_USERNAME / SMTP_PASSWORD, from SMTP_FROM
"""
import smtplib
from email.message import EmailMessage

from flask import current_app


def send_email(to, subject, body):
    cfg = current_app.config
    provider = cfg.get('EMAIL_PROVIDER', 'demo')
    if provider == 'demo':
        return
    if provider == 'console':
        # Warning level, so it appears in a production log (which hides info).
        current_app.logger.warning('Email to %s — %s\n%s', to, subject, body)
        return
    if provider != 'smtp':
        raise RuntimeError(f'EMAIL_PROVIDER "{provider}" is not supported. Use smtp, console or demo.')

    msg = EmailMessage()
    msg['From'] = cfg['SMTP_FROM']
    msg['To'] = to
    msg['Subject'] = subject
    msg.set_content(body)
    port = int(cfg.get('SMTP_PORT') or 587)
    if port == 465:
        server = smtplib.SMTP_SSL(cfg['SMTP_HOST'], port, timeout=20)
    else:
        server = smtplib.SMTP(cfg['SMTP_HOST'], port, timeout=20)
    with server:
        if port != 465 and cfg.get('SMTP_STARTTLS', True):
            server.starttls()
        if cfg.get('SMTP_USERNAME'):
            server.login(cfg['SMTP_USERNAME'], cfg['SMTP_PASSWORD'])
        server.send_message(msg)
