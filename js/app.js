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

/* South African mobile numbers: 0 or +27, then 6/7/8, then 8 more digits */
function isValidSaMobile(num) {
  const cleaned = String(num || '').replace(/[\s()-]/g, '');
  return /^(?:\+27|0)[6-8]\d{8}$/.test(cleaned);
}

function hasNameAndSurname(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean).length >= 2;
}

/* A South African ID number carries the date of birth in its first six digits
   (YYMMDD), so age is derived from the number already captured instead of asking
   for a birth date separately and trusting the answer. Returns null when those
   digits are not a real calendar date. */
function dobFromSaId(idNumber) {
  const digits = String(idNumber || '').replace(/\D/g, '');
  if (digits.length !== 13) return null;
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  const currentYY = new Date().getFullYear() % 100;
  const year = yy <= currentYY ? 2000 + yy : 1900 + yy;
  const dob = new Date(year, mm - 1, dd);
  // Rejects impossible dates — new Date(1999, 1, 31) silently rolls into March.
  if (dob.getFullYear() !== year || dob.getMonth() !== mm - 1 || dob.getDate() !== dd) return null;
  return dob;
}

function ageFromSaId(idNumber) {
  const dob = dobFromSaId(idNumber);
  if (!dob) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthday = now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  return beforeBirthday ? age - 1 : age;
}

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
  modal.querySelector('#modalOk').onclick = () => {
    const result = onConfirm();
    if (result && typeof result.then === 'function') result.then(r => { if (r !== false) closeModal(); });
    else if (result !== false) closeModal();
  };
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
    { href: 'dashboard-commander.html',   label: 'Oversight' },
    { href: 'commander-cases.html',       label: 'All station cases' },
    { href: 'commander-refusals.html',    label: 'Refusals', badge: 'refusals' },
    { href: 'commander-withdrawals.html', label: 'Withdrawal requests', badge: 'withdrawals' },
    { href: 'audit.html',                 label: 'Audit trail' }
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
  const withdrawals = Store.withdrawals({ status: 'pending' }).length;

  const tabs = (NAV[s.role] || []).map(t => {
    let badge = '';
    if (t.badge === 'pending' && pending) badge = `<span class="count${pending ? ' alert' : ''}">${pending}</span>`;
    if (t.badge === 'refusals' && refusals) badge = `<span class="count alert">${refusals}</span>`;
    if (t.badge === 'withdrawals' && withdrawals) badge = `<span class="count alert">${withdrawals}</span>`;
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

function priorityBadge(p) {
  const cls = p === 'Critical' ? 'badge-critical'
    : p === 'High' ? 'badge-alert'
    : p === 'Low' ? 'badge-neutral' : 'badge-brass';
  return `<span class="badge ${cls}">${esc(labelPriority(p))}</span>`;
}

/* ---------------- file attachments (images / documents) ----------------
   Reads File objects into data URLs client-side (there is no upload backend
   yet — see store.js header). Kept out of store.js so Store never touches
   the DOM/FileReader; pages convert files first, then hand Store plain
   {name, type, size, dataUrl} objects. */
function filesToAttachments(fileList, opts) {
  const maxFiles = (opts && opts.maxFiles) || 5;
  const maxBytes = (opts && opts.maxBytes) || 2 * 1024 * 1024;
  const files = Array.from(fileList || []);
  if (!files.length) return Promise.resolve({ ok: true, attachments: [] });
  if (files.length > maxFiles) {
    return Promise.resolve({ ok: false, error: `Attach at most ${maxFiles} files at a time.` });
  }
  const tooBig = files.find(f => f.size > maxBytes);
  if (tooBig) {
    return Promise.resolve({ ok: false, error: `"${tooBig.name}" is larger than ${Math.round(maxBytes / (1024 * 1024))} MB. Choose a smaller file.` });
  }
  return Promise.all(files.map(f => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Could not read "${f.name}".`));
    reader.readAsDataURL(f);
  }))).then(attachments => ({ ok: true, attachments }))
      .catch(err => ({ ok: false, error: err.message }));
}

/* Attachments live as data: URLs because there is no upload backend yet.
   Browsers refuse to navigate a top-level tab to a data: URL, so opening one in
   a new tab lands on a blank page. An <img> pointing at the same data URL is a
   subresource and renders normally, so images expand in place instead, and
   documents download rather than navigate. */
function fileChip(att) {
  const isImage = (att.file_type || att.type || '').startsWith('image/');
  const url = att.data_url || att.dataUrl;
  const name = esc(att.file_name || att.name);
  if (isImage) {
    return `<img class="exhibit-thumb attachment-preview" src="${url}" alt="${name}"
      title="${name} — click to enlarge">`;
  }
  return `<a class="file-chip" href="${url}" download="${name}">${name} (download)</a>`;
}

/* Delegated so it also covers thumbnails rendered inside modals and tables. */
document.addEventListener('click', e => {
  const img = e.target.closest ? e.target.closest('.attachment-preview') : null;
  if (img) img.classList.toggle('is-expanded');
});

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
