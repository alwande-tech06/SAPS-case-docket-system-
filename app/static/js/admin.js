/* admin.js — user account administration */

const me = requireRole('admin');
if (me) { renderChrome('dashboard-admin.html'); render(); }

function render() {
  const users = Store.users();
  document.getElementById('userBody').innerHTML = users.map(u => {
    const load = Store.dockets({ detective_id: u.id }).filter(d => d.current_status !== 'closed').length;
    const spec = Store.specialisations().find(s => s.id === u.specialisation_id);
    return `<tr>
      <td>${esc(u.name)}<div class="small muted">${esc(u.email)}</div></td>
      <td>${esc(labelRole(u.role))}<div class="small muted">${esc(u.rank || '')}</div></td>
      <td>${esc(Store.stationName(u.station_id))}</td>
      <td class="small">${esc(spec ? spec.name : '—')}</td>
      <td>${u.role === 'detective' ? load : '—'}</td>
      <td>${u.is_active ? '<span class="badge badge-good">Active</span>'
                        : '<span class="badge badge-neutral">Deactivated</span>'}</td>
      <td class="actions">
        <button class="btn btn-sm" data-edit="${u.id}">Edit</button>
        ${u.is_active ? `<button class="btn btn-sm btn-danger" data-off="${u.id}">Deactivate</button>` : ''}
      </td></tr>`;
  }).join('');

  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(Number(b.dataset.edit)));
  document.querySelectorAll('[data-off]').forEach(b => b.onclick = () => {
    const u = Store.users().find(x => x.id === Number(b.dataset.off));
    openModal('Deactivate this account', `
      <p class="small">Deactivating removes access. It does not remove ${esc(u.name)} from any
      record of what they did — every past audit entry keeps their name.</p>
      <div class="notice"><strong>${esc(u.name)}</strong>${esc(labelRole(u.role))} ·
        ${esc(Store.stationName(u.station_id))}</div>`, () => {
      const res = Store.deactivateUser(u.id, me);
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
    ${u ? `<div class="field"><label for="ua">Availability</label>
      <select id="ua">
        <option value="available"${u.availability === 'available' ? ' selected' : ''}>Available</option>
        <option value="on_leave"${u.availability === 'on_leave' ? ' selected' : ''}>On leave</option>
      </select></div>` : `<p class="small muted">The starting password is
        <span class="ref">demo1234</span> and must be changed at first sign-in.</p>`}`, () => {
    const name = document.getElementById('un').value.trim();
    const email = document.getElementById('ue').value.trim();
    if (!name || !email) { toast('Name and email address are both required.', 'alert'); return false; }
    const payload = { id: u ? u.id : null, name, email,
      role: document.getElementById('ur').value,
      rank: document.getElementById('uk').value.trim(),
      station_id: document.getElementById('us').value,
      specialisation_id: document.getElementById('up').value || null };
    if (u) payload.availability = document.getElementById('ua').value;
    Store.saveUser(payload, me);
    toast(u ? 'Account updated.' : 'Account created.');
    render();
  }, u ? 'Save changes' : 'Create account');
}
