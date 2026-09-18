/* detective.js — caseload, evidence, arrests, handover */

const me = requireRole('detective');
let openId = null;
if (me) { renderChrome('dashboard-detective.html'); render(); }

function render() {
  const mine = Store.dockets({ detective_id: me.id });
  const stale = mine.filter(d => d.current_status !== 'closed' &&
    (Date.now() - new Date(d.last_activity_at).getTime()) > 30 * 864e5);

  document.getElementById('tiles').innerHTML = `
    <div class="stat"><div class="n">${mine.filter(d => d.current_status !== 'closed').length}</div>
      <div class="k">Open cases</div></div>
    <div class="stat${stale.length ? ' alert' : ''}"><div class="n">${stale.length}</div>
      <div class="k">No activity 30+ days</div></div>
    <div class="stat good"><div class="n">${mine.filter(d => d.current_status === 'closed').length}</div>
      <div class="k">Closed</div></div>`;

  document.getElementById('caseBody').innerHTML = mine.length ? mine.map(d => {
    const late = (Date.now() - new Date(d.last_activity_at).getTime()) > 30 * 864e5;
    return `<tr>
      <td class="ref">${esc(d.cas_number)}</td>
      <td>${esc(Store.categoryName(d.category_id))}</td>
      <td>${esc(fmtDate(d.registered_at))}</td>
      <td>${late ? `<span class="badge badge-alert">${esc(ageFrom(d.last_activity_at))} ago</span>`
                 : esc(fmtDate(d.last_activity_at))}</td>
      <td>${statusBadge(d.current_status)}</td>
      <td class="actions"><button class="btn btn-sm" data-work="${d.id}">Work on this case</button></td>
    </tr>`;
  }).join('') : emptyRow(6, 'No cases are assigned to you. Cases are assigned automatically by crime category.');

  document.querySelectorAll('[data-work]').forEach(b => b.onclick = () => detail(Number(b.dataset.work)));
  if (openId) detail(openId);
}

function detail(id) {
  openId = id;
  const d = Store.docket(id);
  const c = Store.complainant(d.complainant_id);
  const notes = Store.notes(id);
  const evidence = Store.evidence(id);
  const arrests = Store.arrests(id);
  const handovers = Store.handovers(id);

  document.getElementById('detail').innerHTML = `
    <div class="folder" data-tab="Working file">
      <div class="card-head">
        <div>
          <h2 class="ref">${esc(d.cas_number)}</h2>
          <p class="small muted" style="margin:0">${esc(Store.categoryName(d.category_id))} ·
            complainant ${esc(c ? c.name : '—')} · opened ${esc(fmtDate(d.registered_at))}</p>
        </div>
        ${statusBadge(d.current_status)}
      </div>

      <div class="btn-row" style="margin-bottom:1.2rem">
        <button class="btn btn-sm" id="addNote">Add progress note</button>
        <button class="btn btn-sm" id="addEvidence">Register exhibit</button>
        <button class="btn btn-sm" id="addArrest">Record arrest</button>
        <button class="btn btn-sm" id="setStatus">Change status</button>
        <button class="btn btn-sm btn-primary" id="handover">Hand to prosecutor</button>
      </div>

      <div class="split">
        <div>
          <h3>Exhibits and chain of custody</h3>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Exhibit</th><th>Description</th><th>Held by</th><th>Transfers</th><th></th></tr></thead>
              <tbody>
                ${evidence.length ? evidence.map(e => `
                  <tr>
                    <td class="ref">${esc(e.exhibit_number)}</td>
                    <td>${esc(e.description)}<div class="small muted">${esc(e.evidence_type)}</div></td>
                    <td>${esc(Store.userName(e.current_holder_id))}</td>
                    <td>${Store.custody(e.id).length}</td>
                    <td class="actions"><button class="btn btn-sm" data-transfer="${e.id}">Transfer</button></td>
                  </tr>`).join('') : emptyRow(5, 'No exhibits registered.')}
              </tbody>
            </table>
          </div>

          <h3 style="margin-top:1.4rem">Arrests</h3>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Accused</th><th>Charge</th><th>When</th><th>By</th></tr></thead>
              <tbody>
                ${arrests.length ? arrests.map(a => `<tr>
                  <td>${esc(a.accused_name)}</td><td>${esc(a.charge_description)}</td>
                  <td>${esc(fmtDateTime(a.arrest_datetime))}</td>
                  <td>${esc(Store.userName(a.arrested_by))}</td></tr>`).join('')
                  : emptyRow(4, 'No arrests recorded.')}
              </tbody>
            </table>
          </div>

          ${handovers.length ? `
          <h3 style="margin-top:1.4rem">Handovers</h3>
          <div class="table-scroll"><table>
            <thead><tr><th>Recipient</th><th>Organisation</th><th>When</th><th>Receipt</th></tr></thead>
            <tbody>${handovers.map(h => `<tr>
              <td>${esc(h.recipient_name)}</td><td>${esc(h.recipient_organisation)}</td>
              <td>${esc(fmtDateTime(h.handover_datetime))}</td>
              <td class="ref">${esc(h.receipt_reference || '—')}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
        </div>

        <div>
          <h3>Progress notes</h3>
          <ul class="timeline">
            ${notes.length ? notes.slice().reverse().map(n => `
              <li><div class="when">${esc(fmtDateTime(n.created_at))} · ${esc(Store.userName(n.author_id))}</div>
                ${esc(n.note_text)}</li>`).join('')
              : '<li class="small muted">No notes yet.</li>'}
          </ul>

          <h3 style="margin-top:1.4rem">Status history</h3>
          <ul class="timeline">
            ${Store.statusHistory(id).slice().reverse().map(h => `
              <li><div class="when">${esc(fmtDateTime(h.changed_at))}</div>
                ${esc(labelStatus(h.new_status))}
                <div class="small muted">${esc(h.notes || '')}</div></li>`).join('')}
          </ul>
        </div>
      </div>
    </div>`;

  document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });

  document.getElementById('addNote').onclick = () => openModal('Add a progress note', `
    <div class="field"><label for="nt">Note <span class="req">*</span></label>
      <textarea id="nt" placeholder="What was done, and what is next."></textarea></div>`, () => {
    const t = document.getElementById('nt').value.trim();
    if (!t) { toast('Write the note before saving.', 'alert'); return false; }
    Store.addNote(id, me, t); toast('Progress note added.'); render();
  });

  document.getElementById('addEvidence').onclick = () => openModal('Register an exhibit', `
    <div class="field"><label for="ed">Description <span class="req">*</span></label>
      <input type="text" id="ed" placeholder="What the item is"></div>
    <div class="field"><label for="et">Type</label>
      <select id="et"><option>Physical</option><option>Document</option><option>Digital</option><option>Photograph</option></select></div>
    <div class="field"><label for="es">Storage location</label>
      <input type="text" id="es" placeholder="e.g. SAP13 store, shelf 4"></div>`, () => {
    const desc = document.getElementById('ed').value.trim();
    if (!desc) { toast('Describe the exhibit before saving.', 'alert'); return false; }
    Store.addEvidence(id, me, { description: desc,
      evidence_type: document.getElementById('et').value,
      storage_location: document.getElementById('es').value.trim() });
    toast('Exhibit registered and custody opened in your name.'); render();
  });

  document.getElementById('addArrest').onclick = () => openModal('Record an arrest', `
    <div class="field"><label for="an">Name of accused <span class="req">*</span></label>
      <input type="text" id="an"></div>
    <div class="field"><label for="ac">Charge <span class="req">*</span></label>
      <input type="text" id="ac"></div>`, () => {
    const n = document.getElementById('an').value.trim();
    const c2 = document.getElementById('ac').value.trim();
    if (!n || !c2) { toast('Both the name and the charge are required.', 'alert'); return false; }
    Store.addArrest(id, me, { accused_name: n, charge_description: c2 });
    toast('Arrest recorded.'); render();
  });

  document.getElementById('setStatus').onclick = () => openModal('Change the case status', `
    <div class="field"><label for="st">New status <span class="req">*</span></label>
      <select id="st">
        <option value="under_investigation">Under investigation</option>
        <option value="closed">Closed</option>
      </select>
      <p class="hint">Statuses must follow the defined sequence. A case cannot jump straight to closed
      from registered without an investigation stage.</p></div>
    <div class="field"><label for="sn">Note <span class="req">*</span></label>
      <textarea id="sn" style="min-height:80px"></textarea></div>`, () => {
    const st = document.getElementById('st').value;
    const nt = document.getElementById('sn').value.trim();
    if (!nt) { toast('Record why the status is changing.', 'alert'); return false; }
    if (st === 'closed' && d.current_status === 'registered') {
      toast('A registered case must be investigated before it can be closed.', 'alert'); return false;
    }
    Store.updateStatus(id, st, me, nt); toast('Status updated.'); render();
  });

  document.getElementById('handover').onclick = () => openModal('Hand the docket to the prosecutor', `
    <p class="small">The handover is recorded with the recipient's name and the time. The receipt
    reference is your proof that the docket left your hands.</p>
    <div class="field"><label for="hn">Prosecutor's name <span class="req">*</span></label>
      <input type="text" id="hn"></div>
    <div class="field"><label for="ho">Organisation</label>
      <select id="ho"><option>National Prosecuting Authority</option><option>Durban Magistrate's Court</option></select></div>
    <div class="field"><label for="hr">Receipt reference <span class="req">*</span></label>
      <input type="text" id="hr" placeholder="Reference given by the recipient"></div>`, () => {
    const n = document.getElementById('hn').value.trim();
    const r = document.getElementById('hr').value.trim();
    if (!n || !r) { toast('The recipient and receipt reference are both required.', 'alert'); return false; }
    Store.handover(id, me, { recipient_name: n,
      recipient_organisation: document.getElementById('ho').value, receipt_reference: r });
    toast('Handover recorded.'); render();
  });

  document.querySelectorAll('[data-transfer]').forEach(b => b.onclick = () => {
    const others = Store.users().filter(u => u.is_active && u.id !== me.id && u.station_id === me.station_id);
    openModal('Transfer custody of an exhibit', `
      <p class="small">The receiving officer must acknowledge the transfer. Until they do, the
      exhibit shows as awaiting acknowledgement.</p>
      <div class="field"><label for="tu">Transfer to <span class="req">*</span></label>
        <select id="tu">${others.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(labelRole(u.role))}</option>`).join('')}</select></div>
      <div class="field"><label for="tp">Purpose <span class="req">*</span></label>
        <input type="text" id="tp" placeholder="e.g. forensic analysis"></div>`, () => {
      const p = document.getElementById('tp').value.trim();
      if (!p) { toast('State the purpose of the transfer.', 'alert'); return false; }
      Store.transferEvidence(Number(b.dataset.transfer), me, document.getElementById('tu').value, p);
      toast('Transfer logged, awaiting acknowledgement.'); render();
    }, 'Transfer');
  });
}
