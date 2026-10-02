"""Page routes — serves the HTML templates in app/templates/.

Each file has one route named after it (dashboard-official.html ->
/dashboard-official, endpoint pages.dashboard_official), so templates link
with url_for('pages.<name>').

Every page is rendered with the data its reader may see (store_snapshot(),
read by store.js), and staff pages are guarded here as well as by the API:
someone signed out goes to the login page, someone in another role to their
own dashboard.
"""
from flask import Blueprint, abort, redirect, render_template, request, session, url_for

bp = Blueprint('pages', __name__)

ROLES = ('official', 'detective', 'commander', 'admin')
ROLE_HOME = {role: f'pages.dashboard_{role}' for role in ROLES}

# Endpoints that had a .html file of their own, for legacy_page below.
LEGACY_PAGES = set()


def _user():
    from .api import current_user
    return current_user()


def _page(rule, endpoint, template, roles=None):
    def view():
        if roles is not None:
            user = _user()
            if user is None or user.must_change_password:
                return redirect(url_for('pages.login'))
            if user.role not in roles:
                return redirect(url_for(ROLE_HOME[user.role]))
        return render_template(template)
    bp.add_url_rule(rule, endpoint, view, methods=['GET'])
    LEGACY_PAGES.add(endpoint)


@bp.app_context_processor
def snapshot_for_templates():
    def store_snapshot():
        from .api import current_snapshot
        return current_snapshot()
    return {'store_snapshot': store_snapshot}


# Public pages
_page('/', 'index', 'index.html')              # the landing page: report, track, or staff sign-in
_page('/report', 'report', 'report.html')
_page('/track', 'track', 'track.html')
_page('/guide', 'guide', 'guide.html')
_page('/what-happens-next', 'what_happens_next', 'what-happens-next.html')
_page('/login', 'login', 'login.html')
_page('/stations', 'stations', 'stations.html')        # station finder, with map


@bp.get('/index')
def index_alias():
    # The landing page used to live here.
    return redirect(url_for('pages.index'), code=301)

# Staff pages
_page('/dashboard-official', 'dashboard_official', 'dashboard-official.html', ('official',))
_page('/official-capture', 'official_capture', 'official-capture.html', ('official',))
_page('/official-cases', 'official_cases', 'official-cases.html', ('official',))
_page('/dashboard-detective', 'dashboard_detective', 'dashboard-detective.html', ('detective',))
_page('/dashboard-commander', 'dashboard_commander', 'dashboard-commander.html', ('commander',))
_page('/commander-cases', 'commander_cases', 'commander-cases.html', ('commander',))
_page('/commander-refusals', 'commander_refusals', 'commander-refusals.html', ('commander',))
_page('/commander-withdrawals', 'commander_withdrawals', 'commander-withdrawals.html', ('commander',))
_page('/dashboard-admin', 'dashboard_admin', 'dashboard-admin.html', ('admin',))
_page('/admin-reference', 'admin_reference', 'admin-reference.html', ('admin',))
_page('/audit', 'audit', 'audit.html', ('commander', 'admin'))
_page('/profile', 'profile', 'profile.html', ROLES)   # every member of staff: their own account


@bp.get('/reset-password')
def reset_password():
    """Where an emailed "forgot your password" link lands."""
    from ..services.admin import reset_token_valid
    return render_template('reset-password.html', link_valid=reset_token_valid(request.args.get('token')) is not None)


@bp.get('/favicon.ico')
def favicon():
    # Browsers ask for this whatever the page's <link rel="icon"> says.
    return redirect(url_for('static', filename='img/favicon.svg'), code=301)


@bp.get('/dashboard')
def dashboard():
    role = session.get('role')
    if role not in ROLES or _user() is None:
        return redirect(url_for('pages.login'))
    return redirect(url_for(ROLE_HOME[role]))


# Before Flask served them the pages were plain files (/track.html?ref=...).
# Those addresses are printed in QR codes complainants keep as proof of their
# report, so they redirect to the page's route with the query string kept.
@bp.get('/<page>.html')
def legacy_page(page):
    endpoint = page.replace('-', '_')
    if endpoint not in LEGACY_PAGES:
        abort(404)
    target = url_for('pages.' + endpoint)
    if request.query_string:
        target += '?' + request.query_string.decode()
    return redirect(target, code=301)
