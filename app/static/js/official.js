/* official.js — pending report queue and disposition */

const me = requireRole('official');
let selectedId = null;
if (me) { renderChrome('dashboard-official.html'); render(); }

function render() {
  const all = Store.intakes({ station_id: me.station_id });
  const pending = all.filter(i => i.disposition === 'pending')
    .sort((a, b) => priorityRank(Store.priorityFor(b.category_id)) - priorityRank(Store.priorityFor(a.category_id))
      || new Date(a.created_at) - new Date(b.created_at));
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
    /* One badge, not a checklist: the queue is for seeing what can be acted
       on. The full list is a click away in the panel. */
    const ready = Rules.readiness(i.id);
    return `<tr data-row="${i.id}"${i.id === selectedId ? ' class="is-selected"' : ''}>
      <td class="ref">${esc(i.intake_number)}</td>
      <td>${Rules.badgeHtml(ready)}</td>
      <td>${esc(fmtDateTime(i.created_at))}</td>
      <td>${esc(Store.categoryName(i.category_id))}</td>
      <td>${priorityBadge(Store.priorityFor(i.category_id))}</td>
      <td>${esc(c ? c.name : '—')}<div class="small muted">${esc(c ? c.contact : '')}</div></td>
      <td>${late ? `<span class="badge badge-alert">${esc(ageFrom(i.created_at))} overdue</span>`
                 : esc(ageFrom(i.created_at))}</td>
      <td class="actions">
        <button class="btn btn-sm btn-primary open-docket" data-open="${i.id}">Open docket</button>
        <button class="btn btn-sm btn-danger" data-refuse="${i.id}">Record refusal</button>
        <button class="btn btn-sm" data-refer="${i.id}">Refer</button>
        <button class="btn btn-sm" data-view="${i.id}">Details</button>
      </td></tr>`;
  }).join('') : emptyRow(8, 'No reports are waiting. New reports appear here as soon as they are submitted.');

  /* The button is disabled before it is pressed, not after the modal opens. */
  pending.forEach(i => {
    const btn = document.querySelector(`[data-open="${i.id}"]`);
    Rules.gate(btn, Rules.readiness(i.id).res, { linkHost: btn.closest('.actions') });
  });

  renderQueuePanel();

  renderCosignQueue();

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

/* Refusals this station has proposed, waiting with the station commander.
   Read-only here: Diagram 1 routes the second signature to the commander, so
   no official — not even a different one — can sign it off. */
function renderCosignQueue() {
  const queue = Store.pendingRefusals(me.station_id);
  const host = document.getElementById('cosign');
  if (!queue.length) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>With the station commander for a second signature</h3>
        <span class="badge badge-alert">${queue.length}</span>
      </div>
      <p class="small muted">These reports are not refused. They stay open, and keep counting
      towards the 24-hour reconciliation, until the commander signs. If the commander does not
      sign, a docket is opened.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Report</th><th>Type</th><th>Proposed by</th><th>Reason</th><th>Waiting</th></tr></thead>
        <tbody>
          ${queue.map(r => {
            const i = Store.intakes().find(x => x.id === r.intake_id);
            return `<tr>
              <td class="ref">${esc(i ? i.intake_number : '—')}</td>
              <td>${esc(i ? Store.categoryName(i.category_id) : '—')}</td>
              <td>${esc(Store.userName(r.officer_id))}${r.officer_id === me.id ? ' <span class="small muted">(you)</span>' : ''}</td>
              <td class="small">${esc(r.reason_category)}</td>
              <td>${esc(ageFrom(r.raised_at))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>`;
}

/* The selected report's full checklist, beside the queue rather than instead
   of it — so an official can see what is outstanding and still work the list. */
function renderQueuePanel() {
  const host = document.getElementById('queuePanel');
  if (!host) return;

  const intake = selectedId ? Store.intakes().find(i => i.id === selectedId) : null;
  if (!intake || intake.disposition !== 'pending') {
    selectedId = intake ? selectedId : null;
    host.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Readiness</h3></div>
        <p class="small muted">Select a report in the queue to see everything it still needs
        before a docket can be opened on it.</p>
      </div>`;
    return;
  }

  const c = Store.complainant(intake.complainant_id);
  const ready = Rules.readiness(intake.id);

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3 class="ref">${esc(intake.intake_number)}</h3>
        ${Rules.badgeHtml(ready)}
      </div>
      <p class="small muted">${esc(Store.categoryName(intake.category_id))} ·
        ${esc(c ? c.name : '—')} · ${esc(ageFrom(intake.created_at))} old</p>

      ${ready.state === 'cosign' ? `<div class="notice">
        <strong>With the station commander</strong>
        A decision not to open a docket is waiting for a signature. Until it is signed, this
        report is still open and still counting towards the 24-hour reconciliation.</div>` : ''}

      <h4 style="font-size:.9rem;margin:.9rem 0 .3rem">Before a docket can be opened</h4>
      <div id="panelChecklist"></div>

      <div class="btn-row" id="panelActions">
        <button class="btn btn-sm btn-primary" data-open="${intake.id}">Open docket</button>
        <button class="btn btn-sm btn-danger" data-refuse="${intake.id}">Record refusal</button>
        <button class="btn btn-sm" data-refer="${intake.id}">Refer</button>
      </div>
      <button class="btn btn-sm" data-view="${intake.id}" style="margin-top:.5rem">Open full details</button>
    </div>`;

  const res = Rules.render(document.getElementById('panelChecklist'), { intakeId: intake.id }, 'open_docket');
  Rules.gate(host.querySelector('#panelActions [data-open]'), res,
    { linkHost: host.querySelector('#panelActions') });
  /* render() wires every control, panel included, once the whole page is drawn */
}

function wire() {
  /* selecting a row fills the panel; clicking a button in the row does not
     also select, because the button already says what it does */
  document.querySelectorAll('[data-row]').forEach(tr => tr.onclick = e => {
    if (e.target.closest('button')) return;
    selectedId = Number(tr.dataset.row);
    render();
  });

  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.open));
    const needsClass = Store.classificationNeeded(i.id);
    const classifiable = Store.categories().filter(c => !c.requires_classification);

    openModal('Open a docket', `
      <p class="small">A case number will be generated automatically and cannot be edited.
      The system will assign a detective based on the crime category and current caseloads.</p>
      <div class="notice"><strong>${esc(i.intake_number)}</strong>
        ${esc(Store.categoryName(i.category_id))} · ${esc(i.incident_location)}</div>

      ${needsClass ? `
      <div class="notice notice-alert">
        <strong>This report has no category yet</strong>
        The complainant reported it under "Other", so nothing has been assumed about it. Read what
        they wrote and classify it — this sets the priority and which detective it routes to, and
        it is recorded against your name.
      </div>
      <div class="notice"><strong>What they reported</strong>${esc(i.incident_description)}</div>
      <div class="field">
        <label for="classCat">Crime category <span class="req">*</span></label>
        <select id="classCat">
          <option value="">Select the crime this is</option>
          ${classifiable.map(c => `<option value="${c.id}">${esc(c.name)} — ${esc(c.default_priority)} priority</option>`).join('')}
        </select>
      </div>` : ''}

      <div class="field">
        <label for="stmt">Statement taken from the complainant <span class="req">*</span></label>
        <textarea id="stmt" placeholder="Record the statement as given.">${esc(i.incident_description)}</textarea>
      </div>`, () => {
      if (!document.getElementById('stmt').value.trim()) {
        toast('A statement is required before a docket can be opened.', 'alert'); return false;
      }
      const chosen = needsClass ? document.getElementById('classCat').value : null;
      if (needsClass && !chosen) {
        toast('Classify the report before opening a docket on it.', 'alert'); return false;
      }
      const res = Store.openDocket(i.id, me, { category_id: chosen });
      if (!res) { toast('That report has already been dealt with.', 'alert'); return; }
      toast(res.assigned
        ? `${res.docket.cas_number} opened and assigned to ${res.assigned.name}.`
        : `${res.docket.cas_number} opened. No eligible detective — flagged to the commander.`);
      render();
    }, 'Open docket');
  });

  document.querySelectorAll('[data-refuse]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.refuse));
    const reasons = Store.refusalReasonsFor(i.id);
    const cat = Store.categories().find(c => c.id === i.category_id);
    const restricted = cat && cat.protected_from_withdrawal;

    openModal('Propose that no docket be opened', `
      <div class="notice notice-alert">
        <strong>You cannot take this decision alone</strong>
        A second official must sign this off before it takes effect. Until then the report stays
        open and keeps counting towards the 24-hour reconciliation. If the second signature is
        refused, a docket must be opened.
      </div>
      <div class="notice"><strong>${esc(i.intake_number)}</strong>
        ${esc(Store.categoryName(i.category_id))} · ${esc(i.incident_location)}</div>
      ${restricted ? `<div class="notice notice-alert">
        <strong>${esc(cat.name)} — protected category</strong>
        A verified duplicate is the only ground on which a docket may be withheld for this
        crime type.${whyBlocked('protected_categories', 'What this rule requires')}</div>` : ''}
      <div class="field">
        <label for="rcat">Reason <span class="req">*</span></label>
        <select id="rcat">
          <option value="">Select a reason</option>
          ${reasons.map(r => `<option>${esc(r)}</option>`).join('')}
        </select>
        <p class="hint">Insufficient evidence is a filing category, not an intake decision — it can
        only be judged after an investigation. A withdrawal must come from the complainant.
        ${whyBlocked('insufficient_at_intake', 'Why is "insufficient evidence" not here?')}</p>
      </div>
      <div class="field" id="dupWrap" hidden>
        <label for="dupOf">Which case does it duplicate? <span class="req">*</span></label>
        <input type="text" id="dupOf" placeholder="CAS-2026-DBN-000001 or INT-2026-DBN-000001">
      </div>
      <div id="offenceWrap" hidden>
        <div class="field">
          <label for="missEl">Which element is missing? <span class="req">*</span></label>
          <select id="missEl">
            <option value="">Select the element</option>
            ${Store.missingElements().map(e => `<option>${esc(e)}</option>`).join('')}
          </select>
          <p class="hint">Only legality and conduct are testable here. Unlawfulness and culpability
          are defences for an accused to raise and the state to disprove.</p>
        </div>
        <div class="field">
          <label for="defRef">Crime definition consulted <span class="req">*</span></label>
          <input type="text" id="defRef" placeholder="e.g. Theft — Crime Definitions Manual">
        </div>
      </div>
      <div class="field">
        <label for="rdetail">Full reason <span class="req">*</span></label>
        <textarea id="rdetail" placeholder="Name the element of the definition that is missing, or how the duplicate was verified."></textarea>
      </div>

      <h4 style="font-size:.9rem;margin:1rem 0 .3rem">What this ground requires</h4>
      <div id="refuseChecklist"></div>
      <div id="refusalErr"></div>`, () => {
      const res = Store.recordRefusal(i.id, me, refusalDraft());
      if (!res.ok) {
        toast(res.error, 'alert');
        document.getElementById('refusalErr').innerHTML = `<div class="notice notice-alert">
          <strong>Not recorded</strong>${esc(res.error)}${whyBlocked(res.code)}</div>`;
        return false;
      }
      toast('Sent for a second signature. The report stays open until it is signed off.', 'alert');
      render();
    }, 'Send for second signature');

    /* The requirements change with the ground, so the fields and the checklist
       are redrawn whenever the choice does — and the submit button follows. */
    const sel = document.getElementById('rcat');
    const submit = document.getElementById('modalOk');

    /* Declared below the modal call on purpose: it is hoisted, so the confirm
       handler above can read the same draft the checklist is drawn from. */
    function refusalDraft() {
      const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
      return {
        reason_category: val('rcat'),
        reason_detail: val('rdetail'),
        duplicate_of: val('dupOf'),
        missing_element: val('missEl'),
        definition_reference: val('defRef')
      };
    }

    function refreshRefusal() {
      const ground = sel.value;
      document.getElementById('dupWrap').hidden = !/duplicate/i.test(ground);
      document.getElementById('offenceWrap').hidden = !/^No offence disclosed/.test(ground);
      const res = Rules.render(document.getElementById('refuseChecklist'),
        { intakeId: i.id }, 'refuse', refusalDraft());
      Rules.gate(submit, res, { linkHost: submit.parentNode, linkLabel: 'Why can I not submit?' });
    }

    sel.onchange = refreshRefusal;
    ['rdetail', 'dupOf', 'missEl', 'defRef'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = el.onchange = refreshRefusal;
    });
    refreshRefusal();
  });

  document.querySelectorAll('[data-refer]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.refer));
    const others = Store.stations().filter(s => s.id !== i.station_id);
    openModal('Wrong station — register here, then transfer', `
      <div class="notice">
        <strong>The complainant is not sent anywhere</strong>
        A case number is issued here first, so they leave holding it, and the docket is then
        transferred to the station that covers the area. They do not report it again.
      </div>
      <div class="notice"><strong>${esc(i.intake_number)}</strong>
        ${esc(Store.categoryName(i.category_id))} · ${esc(i.incident_location)}</div>
      <div class="field">
        <label for="dest">Receiving station <span class="req">*</span></label>
        <select id="dest">
          <option value="">Select the station that covers this area</option>
          ${others.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="rr">Why this station is not the correct one <span class="req">*</span></label>
        <textarea id="rr" placeholder="e.g. the incident occurred within the Pinetown precinct."></textarea>
      </div>
      <h4 style="font-size:.9rem;margin:1rem 0 .3rem">What this needs</h4>
      <div id="transferChecklist"></div>
      <div id="transferErr"></div>`, () => {
      const res = Store.registerAndTransfer(i.id, me, transferDraft());
      if (!res.ok) {
        toast(res.error, 'alert');
        document.getElementById('transferErr').innerHTML = `<div class="notice notice-alert">
          <strong>Not transferred</strong>${esc(res.error)}${whyBlocked(res.code)}</div>`;
        return false;
      }
      toast(`${res.docket.cas_number} registered and transferred to ${res.to.name}.`);
      render();
    }, 'Register and transfer');

    const submitT = document.getElementById('modalOk');
    function transferDraft() {
      const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
      return { to_station_id: val('dest'), reason: val('rr') };
    }
    function refreshTransfer() {
      const res = Rules.render(document.getElementById('transferChecklist'),
        { intakeId: i.id }, 'transfer', transferDraft());
      Rules.gate(submitT, res, { linkHost: submitT.parentNode, linkLabel: 'Why can I not submit?' });
    }
    ['dest', 'rr'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = el.onchange = refreshTransfer;
    });
    refreshTransfer();
  });

  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    const i = Store.intakes().find(x => x.id === Number(b.dataset.view));
    const c = Store.complainant(i.complainant_id);
    const attachments = Store.complainantEvidence(i.id);
    openModal('Report details', `
      ${stampBlock('Report reference', i.intake_number, 'Pending')}
      <table style="margin-top:1rem">
        <tr><th>Complainant</th><td>${esc(c ? c.name : '—')} <span class="small muted">${esc(c ? c.complainant_number : '')}</span></td></tr>
        <tr><th>ID number</th><td class="ref">${esc(c && c.id_number ? c.id_number : '—')}</td></tr>
        <tr><th>Age</th><td>${(() => {
          const yrs = c && c.id_number ? ageFromSaId(c.id_number) : null;
          if (yrs === null) return '—';
          return yrs < 18
            ? `<span class="badge badge-alert">${yrs} — minor</span>`
            : esc(String(yrs));
        })()}</td></tr>
        <tr><th>Gender</th><td>${esc(c && c.gender ? c.gender : '—')}</td></tr>
        <tr><th>Contact</th><td>${esc(c ? c.contact : '—')}</td></tr>
        <tr><th>Category</th><td>${esc(Store.categoryName(i.category_id))} · ${priorityBadge(Store.priorityFor(i.category_id))}</td></tr>
        <tr><th>Incident date</th><td>${esc(fmtDateTime(i.incident_datetime))}</td></tr>
        <tr><th>Location</th><td>${esc(i.incident_location)}</td></tr>
        <tr><th>Channel</th><td>${esc(labelChannel(i.channel))}</td></tr>
        <tr><th>Description</th><td>${esc(i.incident_description) || '<span class="muted">Not described online — statement to be taken in person</span>'}</td></tr>
      </table>

      ${(() => {
        const fields = Store.categoryFields(i.category_id);
        const details = i.details || {};
        const answered = fields.filter(f => details[f.key]);
        if (!answered.length) return '';
        return `<h3 style="margin-top:1.1rem">What they told us about this ${esc(Store.categoryName(i.category_id).toLowerCase())}</h3>
          <p class="small muted">Asked so the elements of the offence can be tested against what was
          reported, rather than assumed.</p>
          <table>${answered.map(f =>
            `<tr><th>${esc(f.label)}</th><td>${esc(details[f.key])}</td></tr>`).join('')}</table>`;
      })()}

      <h3 style="margin-top:1.1rem">Suspect</h3>
      ${i.suspect && i.suspect.can_identify ? `<table>
          ${i.suspect.name ? `<tr><th>Name given</th><td>${esc(i.suspect.name)}</td></tr>` : ''}
          ${i.suspect.description ? `<tr><th>Description</th><td>${esc(i.suspect.description)}</td></tr>` : ''}
          ${i.suspect.contact ? `<tr><th>Contact</th><td>${esc(i.suspect.contact)}</td></tr>` : ''}
        </table>`
        : `<p class="small muted">The complainant cannot identify anyone. This is not a ground to
           refuse a docket — an unknown suspect is what an investigation is for.</p>`}

      <h3 style="margin-top:1.1rem">Witnesses named by the complainant</h3>
      ${(i.witnesses_reported || []).length ? `<table>
          ${i.witnesses_reported.map(w =>
            `<tr><th>${esc(w.name)}</th><td>${esc(w.contact || 'No contact details given')}</td></tr>`).join('')}
        </table>
        <p class="small muted">These are carried onto the docket automatically when it is opened.
        A statement must be taken from each, or a reason recorded why it could not be.</p>`
        : '<p class="small muted">None named.</p>'}
      <h3 style="margin-top:1.1rem">Evidence submitted by the complainant</h3>
      ${attachments.length ? `<div class="attachment-row">${attachments.map(a => fileChip(a)).join('')}</div>`
        : '<p class="small muted">Nothing submitted yet.</p>'}`, () => {}, 'Close');
  });
}
