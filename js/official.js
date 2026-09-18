/* official.js — pending report queue and disposition */

const me = requireRole('official');
if (me) { renderChrome('dashboard-official.html'); render(); }

function render() {
  const all = Store.intakes({ station_id: me.station_id });
  const pending = all.filter(i => i.disposition === 'pending')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const overdue = pending.filter(i => ageHours(i.created_at) > 24);

  document.getElementById('tiles').innerHTML = `
    <div class="stat${pending.length ? ' alert' : ''}">
      <div class="n">${pending.length}</div><div class="k">Awaiting a decision</div></div>
    <div class="stat${overdue.length ? ' alert' : ''}">
      <div class="n">${overdue.length}</div><div class="k">Past 24 hours</div></div>
    <div class="stat good">
      <div class="n">${all.filter(i => i.disposition === 'docket_opened').length}</div>
      <div class="k">Dockets opened</div></div>`;

  document.getElementById('pendingBody').innerHTML = pending.length ? pending.map(i => {
    const c = Store.complainant(i.complainant_id);
    const late = ageHours(i.created_at) > 24;
    return `<tr>
      <td class="ref">${esc(i.intake_number)}</td>
      <td>${esc(fmtDateTime(i.created_at))}</td>
      <td>${esc(Store.categoryName(i.category_id))}</td>
      <td>${esc(c ? c.name : '—')}<div class="small muted">${esc(c ? c.contact : '')}</div></td>
      <td>${late ? `<span class="badge badge-alert">${esc(ageFrom(i.created_at))} overdue</span>`
                 : esc(ageFrom(i.created_at))}</td>
      <td class="small muted">${esc(labelChannel(i.channel))}</td>
      <td class="actions">
        <button class="btn btn-sm btn-primary" data-open="${i.id}">Open docket</button>
        <button class="btn btn-sm btn-danger" data-refuse="${i.id}">Record refusal</button>
        <button class="btn btn-sm" data-refer="${i.id}">Refer</button>
        <button class="btn btn-sm" data-view="${i.id}">Details</button>
      </td></tr>`;
  }).join('') : emptyRow(7, 'No reports are waiting. New reports appear here as soon as they are submitted.');

  const disposed = all.filter(i => i.disposition !== 'pending')
    .sort((a, b) => new Date(b.disposed_at) - new Date(a.disposed_at)).slice(0, 8);

  document.getElementById('disposedBody').innerHTML = disposed.length ? disposed.map(i => {
    const d = i.docket_id ? Store.docket(i.docket_id) : null;
    return `<tr>
      <td class="ref">${esc(i.intake_number)}</td>
      <td>${esc(Store.categoryName(i.category_id))}</td>
      <td>${dispositionBadge(i.disposition)}</td>
      <td class="ref">${d ? esc(d.cas_number) : '—'}</td>
      <td>${esc(fmtDateTime(i.disposed_at))}</td></tr>`;
  }).join('') : emptyRow(5, 'Nothing disposed of yet.');

  wire();
}

function wire() {
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.open));
    openModal('Open a docket', `
      <p class="small">A case number will be generated automatically and cannot be edited.
      The system will assign a detective based on the crime category and current caseloads.</p>
      <div class="notice"><strong>${esc(i.intake_number)}</strong>
        ${esc(Store.categoryName(i.category_id))} · ${esc(i.incident_location)}</div>
      <div class="field">
        <label for="stmt">Statement taken from the complainant <span class="req">*</span></label>
        <textarea id="stmt" placeholder="Record the statement as given.">${esc(i.incident_description)}</textarea>
      </div>`, () => {
      if (!document.getElementById('stmt').value.trim()) {
        toast('A statement is required before a docket can be opened.', 'alert'); return false;
      }
      const res = Store.openDocket(i.id, me);
      if (!res) { toast('That report has already been dealt with.', 'alert'); return; }
      toast(res.assigned
        ? `${res.docket.cas_number} opened and assigned to ${res.assigned.name}.`
        : `${res.docket.cas_number} opened. No eligible detective — flagged to the commander.`);
      render();
    }, 'Open docket');
  });

  document.querySelectorAll('[data-refuse]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.refuse));
    openModal('Record a refusal to open a docket', `
      <div class="notice notice-alert">
        <strong>This decision is permanent</strong>
        The refusal cannot be deleted, it is attributed to you, and it appears on the station
        commander's dashboard immediately.
      </div>
      <div class="notice"><strong>${esc(i.intake_number)}</strong>
        ${esc(Store.categoryName(i.category_id))} · ${esc(i.incident_location)}</div>
      <div class="field">
        <label for="rcat">Reason category <span class="req">*</span></label>
        <select id="rcat">
          <option value="">Select a reason</option>
          <option>Insufficient evidence</option>
          <option>Complaint withdrawn by complainant</option>
          <option>No offence disclosed</option>
          <option>Duplicate of an existing report</option>
          <option>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="rdetail">Full reason <span class="req">*</span></label>
        <textarea id="rdetail" placeholder="Explain fully why a docket is not being opened."></textarea>
      </div>`, () => {
      const cat = document.getElementById('rcat').value;
      const detail = document.getElementById('rdetail').value.trim();
      if (!cat || !detail) { toast('Both the reason category and the full reason are required.', 'alert'); return false; }
      Store.recordRefusal(i.id, me, { reason_category: cat, reason_detail: detail });
      toast('Refusal recorded and sent to the station commander.', 'alert');
      render();
    }, 'Record refusal');
  });

  document.querySelectorAll('[data-refer]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.refer));
    openModal('Refer to another station', `
      <p class="small">Referral is recorded against your name and the complainant is notified
      automatically. It does not close the report without a trace.</p>
      <div class="field">
        <label for="dest">Receiving station <span class="req">*</span></label>
        <input type="text" id="dest" placeholder="e.g. Chatsworth SAPS">
      </div>
      <div class="field">
        <label for="rr">Reason for referral <span class="req">*</span></label>
        <textarea id="rr" placeholder="Why this station is not the correct one."></textarea>
      </div>`, () => {
      const dest = document.getElementById('dest').value.trim();
      const reason = document.getElementById('rr').value.trim();
      if (!dest || !reason) { toast('Both the destination and the reason are required.', 'alert'); return false; }
      Store.recordReferral(i.id, me, { referred_to_station: dest, reason_detail: reason });
      toast('Referral recorded and the complainant notified.');
      render();
    }, 'Record referral');
  });

  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.view));
    const c = Store.complainant(i.complainant_id);
    openModal('Report details', `
      ${stampBlock('Report reference', i.intake_number, 'Pending')}
      <table style="margin-top:1rem">
        <tr><th>Complainant</th><td>${esc(c ? c.name : '—')}</td></tr>
        <tr><th>Contact</th><td>${esc(c ? c.contact : '—')}</td></tr>
        <tr><th>Category</th><td>${esc(Store.categoryName(i.category_id))}</td></tr>
        <tr><th>Incident date</th><td>${esc(fmtDateTime(i.incident_datetime))}</td></tr>
        <tr><th>Location</th><td>${esc(i.incident_location)}</td></tr>
        <tr><th>Channel</th><td>${esc(labelChannel(i.channel))}</td></tr>
        <tr><th>Description</th><td>${esc(i.incident_description)}</td></tr>
      </table>`, () => {}, 'Close');
  });
}
