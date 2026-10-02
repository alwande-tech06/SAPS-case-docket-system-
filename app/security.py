"""Request-level protections: rate limits, security headers, JSON-only writes.

The rate limiter keeps its counts in memory, per server process. That is
enough to stop guessing from one address; a deployment with several worker
processes behind a load balancer should move this to Redis or the proxy.
"""
import threading
import time
from collections import defaultdict, deque
from functools import wraps

from flask import current_app, jsonify, request

_hits = defaultdict(deque)
_lock = threading.Lock()


def allow(bucket, limit, per_seconds):
    """Counts one request from this address against `bucket`; False once the
    address has made `limit` of them in the last `per_seconds`."""
    if not current_app.config.get('RATELIMIT_ENABLED', True):
        return True
    key = (bucket, request.remote_addr)
    cutoff = time.monotonic() - per_seconds
    with _lock:
        q = _hits[key]
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(time.monotonic())
        return True


def too_many():
    return jsonify({'ok': False, 'code': 'rate_limited',
                    'error': 'Too many attempts. Wait a few minutes and try again.'}), 429


def rate_limit(bucket, limit, per_seconds):
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if not allow(bucket, limit, per_seconds):
                return too_many()
            return view(*args, **kwargs)
        return wrapped
    return decorator


def reset_rate_limits():
    with _lock:
        _hits.clear()


def init_app(app):
    @app.before_request
    def json_only_writes():
        # A cross-site form can post, but it cannot send application/json
        # without a CORS preflight this server never grants — so requiring JSON
        # on every API write is the CSRF protection.
        if request.path.startswith('/api/') and request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            if not request.is_json:
                return jsonify({'ok': False, 'code': 'unsupported_media_type',
                                'error': 'Send the request as JSON.'}), 415

    @app.after_request
    def headers(resp):
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('X-Frame-Options', 'DENY')
        # To another site, only this site's address is sent — never the page or
        # its query string, so a reset or tracking token cannot leak. (Sending
        # nothing at all gets the map tiles refused: OpenStreetMap requires a
        # Referer.)
        resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
        # Location is for this site's own pages only ("Use my current location"
        # on the report form), never for anything embedded in them.
        resp.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)')
        if app.config.get('SESSION_COOKIE_SECURE'):
            resp.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
        # Pages carry case data in them, so nothing but static files is cached.
        if not request.path.startswith('/static/'):
            resp.headers.setdefault('Cache-Control', 'no-store')
        return resp
