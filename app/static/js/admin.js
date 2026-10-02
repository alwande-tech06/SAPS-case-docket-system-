/* admin.js — user account administration */

const me = requireRole('admin');
if (me) { renderChrome('/dashboard-admin'); render(); }

function render() {
  const users = Store.users();
  document.getElementById('userBody').innerHTML = users.map(u => {
    const load = Store.dockets({ detective_id: u.id }).filter(d => d.current_status !== 'closed').length;
    const spec = Store.specialisations().find(s => s.id === u.specialisation_id);
    return `<tr>
      <td>${esc(u.name)}<div class="small muted">${esc(u.email)}</div>
        ${u.personnel_number ? `<div class="small muted">Personnel no. <span class="ref">${esc(u.personnel_number)}</span></div>` : ''}</td>
      <td>${esc(labelRole(u.role))}<div class="small muted">${esc(u.rank || '')}</div></td>
      <td>${esc(Store.stationName(u.station_id))}</td>
      <td class="small">${esc(spec ? spec.name : '—')}</td>
      <td>${u.role === 'detective' ? load : '—'}</td>
      <td>${u.is_active ? '<span class="badge badge-good">Active</span>'
          : u.account_status === 'suspended'
            ? `<span class="badge badge-alert">Suspended</span><div class="small muted">${esc(u.status_reason || '')}</div>`
            : '<span class="badge badge-neutral">Deactivated</span>'}</td>
      <td class="actions">
        <button class="btn btn-sm" data-edit="${u.id}">Edit</button>
        ${u.is_active && u.id !== me.id ? `<button class="btn btn-sm" data-reset="${u.id}">Reset password</button>
          <button class="btn btn-sm" data-suspend="${u.id}">Suspend</button>` : ''}
        ${u.is_active ? `<button class="btn btn-sm btn-danger" data-off="${u.id}">Deactivate</button>`
          : `<button class="btn btn-sm btn-primary" data-on="${u.id}">Reactivate</button>`}
      </td></tr>`;
  }).join('');

  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(Number(b.dataset.edit)));
  /* For someone who cannot use "Forgot your password?" — no access to their
     email, or it has changed. */
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => {
    const u = Store.users().find(x => x.id === Number(b.dataset.reset));
    openModal('Reset this password', `
      <p class="small">${esc(u.name)} gets a new one-time password, shown to you once, and is signed
      out everywhere. They must choose their own password when they next sign in. Staff who can
      reach their email can instead use "Forgot your password?" on the sign-in page.</p>
      <div class="notice"><strong>${esc(u.name)}</strong>${esc(u.email)}</div>`, async () => {
      const res = await Store.resetUserPassword(u.id, me);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      setTimeout(() => openModal('Password reset', `
        <p class="small">Give ${esc(res.user.name)} this one-time password in person. It is shown
        only now.</p>
        <div class="notice"><strong>${esc(res.user.email)}</strong>
          <span class="ref">${esc(res.temporary_password)}</span></div>`, () => {}, 'Done'), 0);
    }, 'Reset password');
  });
  /* Suspension is temporary and carries a reason; deactivation is for someone
     who has left. Either can be lifted, and neither removes their record. */
  document.querySelectorAll('[data-suspend]').forEach(b => b.onclick = () => {
    const u = Store.users().find(x => x.id === Number(b.dataset.suspend));
    openModal('Suspend this account', `
      <p class="small">${esc(u.name)} is signed out at once and cannot sign in until the suspension is
      lifted. Their cases and exhibits stay with them, so reassign anything that cannot wait.</p>
      <div class="notice"><strong>${esc(u.name)}</strong>${esc(labelRole(u.role))} ·
        ${esc(Store.stationName(u.station_id))}</div>
      <div class="field"><label for="suspendReason">Reason <span class="req">*</span></label>
        <textarea id="suspendReason" style="min-height:80px" placeholder="e.g. pending the outcome of a disciplinary hearing"></textarea></div>`,
    async () => {
      const res = await Store.suspendUser(u.id, me, document.getElementById('suspendReason').value);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Account suspended.');
      render();
    }, 'Suspend');
  });

  document.querySelectorAll('[data-on]').forEach(b => b.onclick = () => {
    const u = Store.users().find(x => x.id === Number(b.dataset.on));
    openModal('Reactivate this account', `
      <p class="small">${esc(u.name)} will be able to sign in again with the same password and the
      same role. The reactivation is recorded in the audit trail.</p>
      <div class="notice"><strong>${esc(u.name)}</strong>
        ${u.account_status === 'suspended' ? `Suspended: ${esc(u.status_reason || 'no reason recorded')}` : 'Deactivated'}</div>`,
    async () => {
      const res = await Store.reactivateUser(u.id, me);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Account reactivated.');
      render();
    }, 'Reactivate');
  });

  document.querySelectorAll('[data-off]').forEach(b => b.onclick = () => {
    const u = Store.users().find(x => x.id === Number(b.dataset.off));
    openModal('Deactivate this account', `
      <p class="small">Deactivating removes access. It does not remove ${esc(u.name)} from any
      record of what they did — every past audit entry keeps their name.</p>
      <div class="notice"><strong>${esc(u.name)}</strong>${esc(labelRole(u.role))} ·
        ${esc(Store.stationName(u.station_id))}</div>`, async () => {
      const res = await Store.deactivateUser(u.id, me);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Account deactivated. Activity record retained.');
      render();
    }, 'Deactivate');
  });
}

document.getElementById('newUser').onclick = () => form(null);

function form(id) {
  const u = id ? Store.users().find(x => x.id === id) : null;
  const stations = Store.stations();
  const specs = Store.specialisations();

  openModal(u ? 'Edit account' : 'Add an account', `
    <div class="field"><label for="un">Full name <span class="req">*</span></label>
      <input type="text" id="un" value="${esc(u ? u.name : '')}"></div>
    <div class="field"><label for="ue">Email address <span class="req">*</span></label>
      <input type="text" id="ue" value="${esc(u ? u.email : '')}"></div>
    <div class="row row-2">
      <div class="field"><label for="ur">Role <span class="req">*</span></label>
        <select id="ur">
          ${['official', 'detective', 'commander', 'admin'].map(r =>
            `<option value="${r}"${u && u.role === r ? ' selected' : ''}>${labelRole(r)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="uk">Rank</label>
        <input type="text" id="uk" value="${esc(u ? u.rank : '')}"></div>
    </div>
    <div class="row row-2">
      <div class="field"><label for="us">Station <span class="req">*</span></label>
        <select id="us">${stations.map(s =>
          `<option value="${s.id}"${u && u.station_id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="up">Specialisation</label>
        <select id="up"><option value="">Not applicable</option>${specs.map(s =>
          `<option value="${s.id}"${u && u.specialisation_id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <p class="hint">Detectives are assigned cases automatically by matching this to the crime category.</p></div>
    </div>
    <div class="row row-2">
      <div class="field"><label for="upn">Personnel number</label>
        <input type="text" id="upn" value="${esc(u ? u.personnel_number || '' : '')}" placeholder="e.g. 7012345"></div>
      <div class="field"><label for="uph">Phone number</label>
        <input type="tel" id="uph" value="${esc(u ? u.phone || '' : '')}" placeholder="e.g. 031 555 0100"></div>
    </div>
    ${u ? `<div class="field"><label for="ua">Availability</label>
      <select id="ua">
        <option value="available"${u.availability === 'available' ? ' selected' : ''}>Available</option>
        <option value="on_leave"${u.availability === 'on_leave' ? ' selected' : ''}>On leave</option>
      </select></div>` : `<p class="small muted">A one-time password is generated and shown once
        when the account is created. The new user must change it at first sign-in.</p>`}`, async () => {
    const name = document.getElementById('un').value.trim();
    const email = document.getElementById('ue').value.trim();
    if (!name || !email) { toast('Name and email address are both required.', 'alert'); return false; }
    const payload = { id: u ? u.id : null, name, email,
      role: document.getElementById('ur').value,
      rank: document.getElementById('uk').value.trim(),
      station_id: document.getElementById('us').value,
      specialisation_id: document.getElementById('up').value || null,
      personnel_number: document.getElementById('upn').value.trim(),
      phone: document.getElementById('uph').value.trim() };
    if (u) payload.availability = document.getElementById('ua').value;
    const res = await Store.saveUser(payload, me);
    if (!res.ok) { toast(res.error, 'alert'); return false; }
    render();
    if (!res.temporary_password) { toast('Account updated.'); return; }
    /* Shown once and never stored in the clear: hand it over in person. */
    setTimeout(() => openModal('Account created', `
      <p class="small">Give ${esc(res.user.name)} this one-time password in person. It is shown only
      now, and they must choose their own password when they first sign in.</p>
      <div class="notice"><strong>${esc(res.user.email)}</strong>
        <span class="ref">${esc(res.temporary_password)}</span></div>`, () => {}, 'Done'), 0);
  }, u ? 'Save changes' : 'Create account');
}
