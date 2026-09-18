/* ==========================================================================
   app.js — shared UI helpers, role guard, page chrome
   ========================================================================== */

/* ---------------- formatting ---------------- */

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ageFrom(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 36e5);
  if (h < 1) return 'under 1 h';
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

function ageHours(iso) { return (Date.now() - new Date(iso).getTime()) / 36e5; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- toast ---------------- */

function toast(message, kind) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = message;
  el.className = 'toast show' + (kind === 'alert' ? ' alert' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3600);
}

/* ---------------- modal ---------------- */

function openModal(title, bodyHtml, onConfirm, confirmLabel) {
  let back = document.querySelector('.modal-back');
  if (!back) {
    back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal"></div>';
    document.body.appendChild(back);
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  }
  const modal = back.querySelector('.modal');
  modal.innerHTML = `
    <h2>${esc(title)}</h2>
    <div id="modalBody">${bodyHtml}</div>
    <div class="btn-row" style="margin-top:1.1rem">
      <button class="btn btn-primary" id="modalOk">${esc(confirmLabel || 'Save')}</button>
      <button class="btn" id="modalCancel">Cancel</button>
    </div>`;
  back.classList.add('open');
  modal.querySelector('#modalCancel').onclick = closeModal;
  modal.querySelector('#modalOk').onclick = () => { if (onConfirm() !== false) closeModal(); };
  const first = modal.querySelector('input, select, textarea');
  if (first) first.focus();
}

function closeModal() {
  const back = document.querySelector('.modal-back');
  if (back) back.classList.remove('open');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------------- role guard ---------------- */

const ROLE_HOME = {
  official:  'dashboard-official.html',
  detective: 'dashboard-detective.html',
  commander: 'dashboard-commander.html',
  admin:     'dashboard-admin.html'
};

function requireRole(role) {
  const s = Store.session();
  if (!s) { location.replace('login.html'); return null; }
  if (s.role !== role) { location.replace(ROLE_HOME[s.role] || 'login.html'); return null; }
  return s;
}

/* ---------------- page chrome ---------------- */

const NAV = {
  official: [
    { href: 'dashboard-official.html', label: 'Pending reports', badge: 'pending' },
    { href: 'official-capture.html',   label: 'Capture a report' },
    { href: 'official-cases.html',     label: 'Station cases' }
  ],
  detective: [
    { href: 'dashboard-detective.html', label: 'My cases' }
  ],
  commander: [
    { href: 'dashboard-commander.html', label: 'Oversight' },
    { href: 'commander-cases.html',     label: 'All station cases' },
    { href: 'commander-refusals.html',  label: 'Refusals', badge: 'refusals' },
    { href: 'audit.html',               label: 'Audit trail' }
  ],
  admin: [
    { href: 'dashboard-admin.html', label: 'User accounts' },
    { href: 'admin-reference.html', label: 'Reference data' },
    { href: 'audit.html',           label: 'Audit trail' }
  ]
};

function renderChrome(activeHref) {
  const s = Store.session();
  const host = document.getElementById('chrome');
  if (!host || !s) return;

  const pending = Store.intakes({ station_id: s.station_id, disposition: 'pending' }).length;
  const refusals = Store.refusals(s.station_id).filter(r => !r.reviewed_by).length;

  const tabs = (NAV[s.role] || []).map(t => {
    let badge = '';
    if (t.badge === 'pending' && pending) badge = `<span class="count${pending ? ' alert' : ''}">${pending}</span>`;
    if (t.badge === 'refusals' && refusals) badge = `<span class="count alert">${refusals}</span>`;
    const active = t.href === activeHref ? ' is-active' : '';
    return `<a class="tab${active}" href="${t.href}">${esc(t.label)}${badge}</a>`;
  }).join('');

  host.innerHTML = `
    <header class="masthead">
      <div class="masthead-inner">
        <div class="crest">SAPS</div>
        <div>
          <div class="masthead-title">Case Docket Accountability System</div>
          <div class="masthead-sub">${esc(Store.stationName(s.station_id))}</div>
        </div>
        <div class="masthead-spacer"></div>
        <div class="masthead-user">
          <div>${esc(s.name)}</div>
          <div class="role">${esc(labelRole(s.role))}</div>
        </div>
        <button class="btn btn-sm" id="signOut">Sign out</button>
      </div>
    </header>
    <nav class="tabs"><div class="tabs-inner">${tabs}</div></nav>`;

  document.getElementById('signOut').onclick = () => {
    Store.logout();
    location.href = 'login.html';
  };
}

/* ---------------- public header ---------------- */

function renderPublicHeader() {
  const host = document.getElementById('chrome');
  if (!host) return;
  host.innerHTML = `
    <header class="masthead">
      <div class="masthead-inner">
        <div class="crest">SAPS</div>
        <div>
          <div class="masthead-title">Report a crime</div>
          <div class="masthead-sub">South African Police Service</div>
        </div>
        <div class="masthead-spacer"></div>
        <a class="btn btn-sm" href="index.html">Home</a>
        <a class="btn btn-sm" href="login.html">Staff sign in</a>
      </div>
    </header>`;
}

/* ---------------- shared renderers ---------------- */

function statusBadge(status) {
  const cls = status === 'closed' ? 'badge-good'
    : status === 'awaiting_assignment' ? 'badge-alert'
    : status === 'sent_to_prosecutor' ? 'badge-brass' : 'badge-neutral';
  return `<span class="badge ${cls}">${esc(labelStatus(status))}</span>`;
}

function dispositionBadge(d) {
  const cls = d === 'pending' ? 'badge-alert'
    : d === 'docket_opened' ? 'badge-good' : 'badge-neutral';
  return `<span class="badge ${cls}">${esc(labelDisposition(d))}</span>`;
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}"><div class="empty">${esc(message)}</div></td></tr>`;
}

/* Reference stamp block — the signature element */
function stampBlock(label, number, mark) {
  return `
    <div class="stamp-block">
      ${mark ? `<div class="stamp-mark">${esc(mark)}</div>` : ''}
      <div class="label">${esc(label)}</div>
      <div class="number">${esc(number)}</div>
    </div>`;
}

/* Proof-of-report QR — encodes a deep link back to the tracking page so it
   can be scanned or kept as evidence the report was made. Rendered with the
   vendored qrcode library (js/vendor-qrcode.js) synchronously as inline SVG
   so it inherits the page's colours and scales with its box. */
function qrBlock(refNumber, caption) {
  const path = location.pathname.replace(/[^/]*$/, '');
  const url = location.origin + path + 'track.html?ref=' + encodeURIComponent(refNumber);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const cell = 4;
  const size = n * cell;
  let cells = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) cells += '<rect x="' + (c * cell) + '" y="' + (r * cell) + '" width="' + cell + '" height="' + cell + '"/>';
    }
  }
  return '' +
    '<div class="qr-block">' +
      '<svg class="qr-code" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QR code linking to this report\'s tracking page">' +
        '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
        '<g fill="#14181F">' + cells + '</g>' +
      '</svg>' +
      '<div class="qr-caption">' + esc(caption || 'Scan to reopen this report') + '</div>' +
    '</div>';
}

/* ---------------- audit ledger renderer ---------------- */

function renderLedger(entries, hostId) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const chain = Store.verifyChain();
  host.innerHTML = `
    <div class="table-scroll">
      <table class="ledger">
        <thead>
          <tr><th>When</th><th>User</th><th>Role</th><th>Action</th><th>Description</th><th>Chain</th></tr>
        </thead>
        <tbody>
          ${entries.length ? entries.map(e => `
            <tr>
              <td>${esc(fmtDateTime(e.performed_at))}</td>
              <td>${esc(e.user_name)}</td>
              <td>${esc(labelRole(e.user_role))}</td>
              <td>${esc(e.action_type)}</td>
              <td style="font-family:var(--sans)">${esc(e.description)}</td>
              <td class="hash">${esc(e.entry_hash)}</td>
            </tr>`).join('') : emptyRow(6, 'No entries recorded yet.')}
        </tbody>
      </table>
    </div>
    <div class="ledger-note">
      This screen has no edit or delete control, by design. Audit entries cannot be
      altered by any role, including the administrator. Each entry stores a hash of
      itself and of the entry before it, so removing one breaks the chain.
      <strong style="display:block;margin-top:.4rem" class="${chain.ok ? 'chain-ok' : ''}">
        Chain verification: ${chain.ok ? `intact across ${chain.entries} entries` : `BROKEN at entry ${chain.at}`}
      </strong>
    </div>`;
}
