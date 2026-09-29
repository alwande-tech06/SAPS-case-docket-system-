/* detective.js — caseload, evidence, arrests, handover */

const me = requireRole('detective');
let openId = null;
if (me) { renderChrome('dashboard-detective.html'); render(); }

function render() {
  const mine = Store.dockets({ detective_id: me.id });
  const dormantIds = new Set(Store.dormantDockets(me.station_id).map(d => d.id));
  const stale = mine.filter(d => dormantIds.has(d.id));

  document.getElementById('tiles').innerHTML = `
    <div class="stat"><div class="n">${mine.filter(d => d.current_status !== 'closed').length}</div>
      <div class="k">Open cases</div></div>
    <div class="stat${stale.length ? ' alert' : ''}"><div class="n">${stale.length}</div>
      <div class="k">No diary entry 30+ days</div></div>
    <div class="stat good"><div class="n">${mine.filter(d => d.current_status === 'closed').length}</div>
      <div class="k">Closed</div></div>`;

  document.getElementById('caseBody').innerHTML = mine.length ? mine.map(d => {
    const late = dormantIds.has(d.id);
    const lastDiary = Store.lastDiaryEntry(d.id);
    return `<tr>
      <td class="ref">${esc(d.cas_number)}</td>
      <td>${esc(Store.categoryName(d.category_id))}</td>
      <td>${esc(fmtDate(d.registered_at))}</td>
      <td>${late ? `<span class="badge badge-alert">${esc(lastDiary ? ageFrom(lastDiary) + ' ago' : 'no diary entry')}</span>`
                 : esc(lastDiary ? fmtDate(lastDiary) : '—')}</td>
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
  const submitted = Store.complainantEvidence(d.intake_id).filter(e => e.review_status === 'pending');

  document.getElementById('detail').innerHTML = `
    <div class="folder" data-tab="Working file">
      <div class="card-head">
        <div>
          <h2 class="ref">${esc(d.cas_number)}</h2>
          <p class="small muted" style="margin:0">${esc(Store.categoryName(d.category_id))} ·
            complainant ${esc(c ? c.name : '—')} · opened ${esc(fmtDate(d.registered_at))}</p>
        </div>
        <div style="text-align:right">
          ${statusBadge(d.current_status)} ${priorityBadge(d.priority)}
          <div class="small muted" style="margin-top:.3rem">Priority set by crime category</div>
        </div>
      </div>

      <div class="btn-row" style="margin-bottom:1.2rem">
        <button class="btn btn-sm" id="addNote">Add progress note</button>
        <button class="btn btn-sm" id="addEvidence">Register exhibit</button>
        <button class="btn btn-sm" id="addArrest">Record arrest</button>
        <button class="btn btn-sm" id="setStatus">Change status</button>
        <button class="btn btn-sm btn-primary" id="handover">Hand to prosecutor</button>
        ${d.current_status === 'closed'
          ? '<button class="btn btn-sm" id="reopenCase">Reopen case</button>'
          : '<button class="btn btn-sm btn-danger" id="requestClosure">Request closure</button>'}
      </div>

      ${(() => {
        const pending = Store.closures({ docket_id: d.id, status: 'pending_approval' })[0];
        return pending ? `<div class="notice notice-alert">
          <strong>Closure awaiting the commander's decision</strong>
          ${esc(pending.category_label)}, requested ${esc(fmtDateTime(pending.requested_at))}.
          You cannot approve your own request.</div>` : '';
      })()}
      ${d.brought_forward_at ? `<div class="notice">
        <strong>Brought forward for review</strong>
        This filed docket comes back for review on ${esc(fmtDate(d.brought_forward_at))}.</div>` : ''}

      ${submitted.length ? `
      <h3>Evidence submitted by the complainant</h3>
      <div class="table-scroll" style="margin-bottom:1.2rem">
        <table>
          <thead><tr><th>File</th><th>Note</th><th>Submitted</th><th></th></tr></thead>
          <tbody>
            ${submitted.map(e => `
              <tr>
                <td>${fileChip(e)}</td>
                <td class="small">${esc(e.description || '—')}</td>
                <td>${esc(fmtDateTime(e.uploaded_at))}</td>
                <td class="actions">
                  <button class="btn btn-sm btn-primary" data-accept-ce="${e.id}">Accept as exhibit</button>
                  <button class="btn btn-sm btn-danger" data-reject-ce="${e.id}">Reject</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

      ${(() => {
        const instr = Store.instructions(d.id);
        if (!instr.length) return '';
        const open = instr.filter(n => n.status === 'open');
        return `
        <h3>Instructions from the station commander${open.length ? ` <span class="badge badge-alert">${open.length} open</span>` : ''}</h3>
        <p class="small muted">An open instruction blocks this docket from being filed. Answer it by
        recording what was done, or by explaining why it could not be.</p>
        <ul class="timeline" style="margin-bottom:1.2rem">
          ${instr.map(n => `<li>
            <div class="when">${esc(fmtDateTime(n.created_at))} · ${esc(Store.userName(n.author_id))}
              ${n.status === 'open' ? '<span class="badge badge-alert">Open</span>'
                : `<span class="badge badge-good">${esc(n.status)}</span>`}</div>
            ${esc(n.note_text)}
            ${n.response ? `<div class="small muted">${esc(n.status === 'executed' ? 'Done: ' : 'Explained: ')}${esc(n.response)}</div>` : ''}
            ${n.status === 'open' ? `<div class="btn-row" style="margin-top:.4rem">
              <button class="btn btn-sm btn-primary" data-instr-done="${n.id}">Record what was done</button>
              <button class="btn btn-sm" data-instr-why="${n.id}">Explain why not</button></div>` : ''}
          </li>`).join('')}
        </ul>`;
      })()}

      <div class="split">
        <div>
          <h3>Exhibits and chain of custody</h3>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Exhibit</th><th>Description</th><th>Held by</th><th>Transfers</th><th></th></tr></thead>
              <tbody>
                ${evidence.length ? evidence.map(e => {
                  const charge = e.linked_arrest_id ? arrests.find(a => a.id === e.linked_arrest_id) : null;
                  return `
                  <tr>
                    <td class="ref">${esc(e.exhibit_number)}</td>
                    <td>${e.image_data_url ? `<img class="exhibit-thumb attachment-preview" src="${e.image_data_url}" alt="${esc(e.description)}" title="Exhibit photograph — click to enlarge">` : ''}
                      ${esc(e.description)}<div class="small muted">${esc(e.evidence_type)}${e.saps13_number ? ' · SAPS 13: ' + esc(e.saps13_number) : ''}${e.storage_location ? ' · ' + esc(e.storage_location) : ''}</div>
                      ${e.suspect_name ? `<div class="suspect-link">
                        ${e.suspect_photo_data_url ? `<img class="exhibit-thumb attachment-preview" src="${e.suspect_photo_data_url}" alt="${esc(e.suspect_name)}" title="Suspect photograph — click to enlarge">` : ''}
                        <div class="small"><strong>${esc(e.suspect_name)}</strong>
                          <div class="ref muted">${esc(e.suspect_id_number)}</div>
                          ${charge ? `<div class="muted">${esc(charge.charge_description)}</div>` : ''}
                        </div></div>` : ''}</td>
                    <td>${esc(Store.userName(e.current_holder_id))}</td>
                    <td>${Store.custody(e.id).length}</td>
                    <td class="actions"><button class="btn btn-sm" data-transfer="${e.id}">Transfer</button></td>
                  </tr>`; }).join('') : emptyRow(5, 'No exhibits registered.')}
              </tbody>
            </table>
          </div>

          <h3 style="margin-top:1.4rem">Witnesses and statements
            <button class="btn btn-sm" id="addWitness" style="float:right">Add witness</button></h3>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Witness</th><th>Statement</th><th></th></tr></thead>
              <tbody>
                ${(() => {
                  const ws = Store.witnesses(d.id);
                  return ws.length ? ws.map(w => `<tr>
                    <td>${esc(w.name)}<div class="small muted">${esc(w.contact || '—')}</div></td>
                    <td>${w.statement_text
                      ? `<span class="badge badge-good">Taken</span><div class="small muted">${esc(w.statement_text.slice(0, 90))}</div>`
                      : w.no_statement_reason
                        ? `<span class="badge badge-neutral">Explained</span><div class="small muted">${esc(w.no_statement_reason)}</div>`
                        : '<span class="badge badge-alert">Outstanding</span>'}</td>
                    <td class="actions">${w.statement_text || w.no_statement_reason ? ''
                      : `<button class="btn btn-sm" data-witness="${w.id}">Record</button>`}</td>
                  </tr>`).join('') : emptyRow(3, 'No witnesses identified.');
                })()}
              </tbody>
            </table>
          </div>

          <h3 style="margin-top:1.4rem">Forensic submissions
            <button class="btn btn-sm" id="addForensic" style="float:right">Submit for analysis</button></h3>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Submitted</th><th>Lab reference</th><th>Result</th><th></th></tr></thead>
              <tbody>
                ${(() => {
                  const fs = Store.forensics(d.id);
                  return fs.length ? fs.map(f => `<tr>
                    <td>${esc(f.description)}<div class="small muted">${esc(fmtDate(f.submitted_at))}</div></td>
                    <td class="ref">${esc(f.lab_reference)}</td>
                    <td>${f.result
                      ? `<span class="badge badge-good">Back</span><div class="small muted">${esc(f.result.slice(0, 80))}</div>`
                      : f.accounted_for_reason
                        ? `<span class="badge badge-neutral">Accounted for</span><div class="small muted">${esc(f.accounted_for_reason)}</div>`
                        : '<span class="badge badge-alert">Outstanding</span>'}</td>
                    <td class="actions">${f.result || f.accounted_for_reason ? ''
                      : `<button class="btn btn-sm" data-forensic="${f.id}">Record</button>`}</td>
                  </tr>`).join('') : emptyRow(4, 'Nothing submitted for analysis.');
                })()}
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
    <div class="field"><label for="es">Storage location <span class="req">*</span></label>
      <input type="text" id="es" placeholder="e.g. SAP 13 store, shelf 4"></div>
    <div class="field"><label for="e13">SAPS 13 register number <span class="req">*</span></label>
      <input type="text" id="e13" placeholder="e.g. SAP13/412/2026">
      <p class="hint">The exhibit cannot be saved without it. The register number and the storage
      location are what make the item findable again months later.</p></div>
    <div class="field"><label for="eimg">Photograph of the exhibit <span class="req">*</span></label>
      <input type="file" id="eimg" accept="image/*,.pdf">
      <p class="hint">For a document exhibit, a scanned copy through this same field satisfies the
      requirement. An exhibit cannot be recorded without one.</p></div>

    <h3 style="font-size:.95rem;margin-top:1.2rem">Link to a suspect</h3>
    <p class="small muted">${arrests.length
      ? 'This case has a recorded suspect, so this exhibit must be linked — either name the suspect here, or pick the charge below.'
      : 'Optional — but if you fill in any of these, all three are required, so an exhibit is never tied to a half-identified person.'}</p>
    <div class="field"><label for="esn">Suspect's full name</label>
      <input type="text" id="esn" placeholder="Name and surname"></div>
    <div class="field"><label for="esid">Suspect's ID number</label>
      <input type="text" id="esid" inputmode="numeric" maxlength="13" placeholder="13 digits"></div>
    <div class="field"><label for="esimg">Photograph of the suspect</label>
      <input type="file" id="esimg" accept="image/*"></div>
    ${arrests.length ? `<div class="field"><label for="ech">Linked charge</label>
      <select id="ech">
        <option value="">Not linked to a recorded charge</option>
        ${arrests.map(a => `<option value="${a.id}">${esc(a.accused_name)} — ${esc(a.charge_description)}</option>`).join('')}
      </select></div>`
      : `<p class="small muted">No arrest has been recorded on this case yet, so there is no charge to
         link to. Record the arrest first if you need that link.</p>`}
    <div id="exErr"></div>`, async () => {
    const desc = document.getElementById('ed').value.trim();
    if (!desc) { toast('Describe the exhibit before saving.', 'alert'); return false; }

    const imgInput = document.getElementById('eimg');
    if (!imgInput.files.length) {
      toast('A photograph of the exhibit is required before it can be recorded.', 'alert'); return false;
    }
    const converted = await filesToAttachments(imgInput.files, { maxFiles: 1 });
    if (!converted.ok) { toast(converted.error, 'alert'); return false; }

    const suspectName = document.getElementById('esn').value.trim();
    const suspectId = document.getElementById('esid').value.trim();
    const suspectImgInput = document.getElementById('esimg');
    let suspectPhoto = null;
    if (suspectImgInput.files.length) {
      const sConverted = await filesToAttachments(suspectImgInput.files, { maxFiles: 1 });
      if (!sConverted.ok) { toast(sConverted.error, 'alert'); return false; }
      suspectPhoto = sConverted.attachments[0].dataUrl;
    }

    const chargeSelect = document.getElementById('ech');
    const res = Store.addEvidence(id, me, {
      description: desc,
      evidence_type: document.getElementById('et').value,
      storage_location: document.getElementById('es').value.trim(),
      saps13_number: document.getElementById('e13').value.trim(),
      image_data_url: converted.attachments[0].dataUrl,
      suspect_name: suspectName,
      suspect_id_number: suspectId,
      suspect_photo_data_url: suspectPhoto,
      linked_arrest_id: chargeSelect ? chargeSelect.value : null
    });
    if (!res.ok) {
      toast(res.error, 'alert');
      const box = document.getElementById('exErr');
      if (box) box.innerHTML = `<div class="notice notice-alert">
        <strong>This exhibit cannot be saved yet</strong>${esc(res.error)}${whyBlocked(res.code)}</div>`;
      return false;
    }
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
      </select>
      <p class="hint">Closing a case is not a status change. Use "Request closure" — a filing
      category must be chosen and the commander must approve it.</p></div>
    <div class="field"><label for="sn">Note <span class="req">*</span></label>
      <textarea id="sn" style="min-height:80px"></textarea></div>`, () => {
    const nt = document.getElementById('sn').value.trim();
    if (!nt) { toast('Record why the status is changing.', 'alert'); return false; }
    Store.updateStatus(id, document.getElementById('st').value, me, nt);
    toast('Status updated.'); render();
  });

  /* Diagram 5 — filing a docket. The category drives what must be supplied,
     and the commander, not the investigating officer, decides. */
  const closeBtn = document.getElementById('requestClosure');
  if (closeBtn) closeBtn.onclick = () => {
    const cats = Store.filingCategories();
    openModal('Request that this docket be filed', `
      <div class="notice">
        <strong>The commander decides</strong>
        You are asking for this case to be filed. The station commander approves or refuses it,
        and it cannot be you.
      </div>
      <div class="field">
        <label for="fc">Filing category <span class="req">*</span></label>
        <select id="fc">
          <option value="">Select a category</option>
          ${cats.map(c => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}
        </select>
      </div>
      <div id="fcReq"></div>
      <div class="field">
        <label for="fm">Motivation <span class="req">*</span></label>
        <textarea id="fm" placeholder="What was done, and why the case cannot go further."></textarea>
      </div>
      <div id="fcBlocker"></div>`, () => {
      const key = document.getElementById('fc').value;
      const res = Store.requestClosure(id, me, {
        category: key,
        motivation: document.getElementById('fm').value,
        warrant_reference: val('fWarrant'),
        circulation_reference: val('fCirc'),
        discrepancy_report: val('fDisc'),
        prosecutor_reference: val('fPros')
      });
      if (!res.ok) {
        toast(res.error, 'alert');
        document.getElementById('fcBlocker').innerHTML =
          `<div class="notice notice-alert"><strong>Cannot be requested yet</strong>
            ${esc(res.error)}${whyBlocked(res.code)}</div>`;
        return false;
      }
      toast('Closure requested. It is now with the station commander.');
      render();
    }, 'Send to commander');

    const extra = {
      pending_arrest: '<div class="field"><label for="fWarrant">Circulated warrant of arrest reference <span class="req">*</span></label><input type="text" id="fWarrant"></div>',
      pending_recovery: '<div class="field"><label for="fCirc">Property circulation reference <span class="req">*</span></label><input type="text" id="fCirc"></div>',
      evidence_compromised: '<div class="field"><label for="fDisc">Discrepancy report <span class="req">*</span></label><textarea id="fDisc" placeholder="What is missing or compromised, and when it was discovered."></textarea></div>',
      sent_to_court: '<div class="field"><label for="fPros">Prosecutor reference <span class="req">*</span></label><input type="text" id="fPros" placeholder="Reference given by the NPA"></div>'
    };
    const sel = document.getElementById('fc');
    sel.onchange = () => {
      document.getElementById('fcReq').innerHTML = extra[sel.value] || '';
      const blocker = sel.value ? Store.closureBlocker(id, sel.value, {
        warrant_reference: 'x', circulation_reference: 'x',
        discrepancy_report: 'x', prosecutor_reference: 'x'
      }) : null;
      document.getElementById('fcBlocker').innerHTML = blocker
        ? `<div class="notice notice-alert"><strong>Not available on this case</strong>
            ${esc(blocker.message)}${whyBlocked(blocker.code)}</div>`
        : '';
    };
  };

  /* answering the commander's diary instructions */
  document.querySelectorAll('[data-instr-done]').forEach(b => b.onclick = () =>
    answerInstruction(Number(b.dataset.instrDone), 'executed'));
  document.querySelectorAll('[data-instr-why]').forEach(b => b.onclick = () =>
    answerInstruction(Number(b.dataset.instrWhy), 'explained'));

  function answerInstruction(noteId, outcome) {
    const done = outcome === 'executed';
    openModal(done ? 'Record what was done' : 'Explain why this was not carried out', `
      <div class="field">
        <label for="instrResp">${done ? 'What you did' : 'Why it could not be done'} <span class="req">*</span></label>
        <textarea id="instrResp" placeholder="${done
          ? 'What was done, when, and what came of it.'
          : 'Why the instruction could not be carried out.'}"></textarea>
      </div>`, () => {
      const res = Store.answerInstruction(noteId, me, outcome, document.getElementById('instrResp').value);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast(done ? 'Recorded against the instruction.' : 'Explanation recorded.');
      render();
    }, done ? 'Record' : 'Record explanation');
  }

  document.getElementById('addWitness').onclick = () => openModal('Identify a witness', `
    <p class="small muted">Every witness you identify needs a statement, or a recorded reason why one
    could not be taken. The commander checks this before a docket can be filed.</p>
    <div class="field"><label for="wn">Name <span class="req">*</span></label>
      <input type="text" id="wn" placeholder="Name and surname"></div>
    <div class="field"><label for="wc">Contact</label>
      <input type="text" id="wc" placeholder="Phone number, if known"></div>`, () => {
    const res = Store.addWitness(id, me, { name: document.getElementById('wn').value,
      contact: document.getElementById('wc').value });
    if (!res.ok) { toast(res.error, 'alert'); return false; }
    toast('Witness recorded.'); render();
  }, 'Add witness');

  document.querySelectorAll('[data-witness]').forEach(b => b.onclick = () => {
    const w = Store.witnesses(id).find(x => x.id === Number(b.dataset.witness));
    openModal(`Statement from ${w.name}`, `
      <div class="field"><label for="wst">Statement</label>
        <textarea id="wst" style="min-height:110px" placeholder="The statement as given."></textarea></div>
      <div class="field"><label for="wnr">Or, why no statement could be taken</label>
        <input type="text" id="wnr" placeholder="e.g. witness has relocated and cannot be traced"></div>
      <p class="small muted">One or the other. A witness left with neither blocks the docket from
      being filed.</p>`, () => {
      const res = Store.recordWitnessStatement(w.id, me,
        document.getElementById('wst').value, document.getElementById('wnr').value);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Recorded on the docket.'); render();
    }, 'Record');
  });

  document.getElementById('addForensic').onclick = () => openModal('Submit for forensic analysis', `
    <div class="field"><label for="fd">What is being submitted <span class="req">*</span></label>
      <input type="text" id="fd" placeholder="e.g. blood sample from the scene"></div>
    <div class="field"><label for="fl">Laboratory reference <span class="req">*</span></label>
      <input type="text" id="fl" placeholder="Reference given by the laboratory"></div>
    ${evidence.length ? `<div class="field"><label for="fe">Exhibit this came from</label>
      <select id="fe"><option value="">Not linked to a registered exhibit</option>
        ${evidence.map(e => `<option value="${e.id}">${esc(e.exhibit_number)} — ${esc(e.description)}</option>`).join('')}
      </select></div>` : ''}
    <p class="small muted">Every submission must come back with a result, or be accounted for, before
    the docket can be filed.</p>`, () => {
    const sel = document.getElementById('fe');
    const res = Store.submitForensic(id, me, {
      description: document.getElementById('fd').value,
      lab_reference: document.getElementById('fl').value,
      evidence_id: sel ? sel.value : null
    });
    if (!res.ok) { toast(res.error, 'alert'); return false; }
    toast('Forensic submission recorded.'); render();
  }, 'Record submission');

  document.querySelectorAll('[data-forensic]').forEach(b => b.onclick = () => {
    const f = Store.forensics(id).find(x => x.id === Number(b.dataset.forensic));
    openModal(`Result for ${f.lab_reference}`, `
      <div class="field"><label for="fr">Result</label>
        <textarea id="fr" placeholder="What the laboratory reported."></textarea></div>
      <div class="field"><label for="fa">Or, account for why it is outstanding</label>
        <input type="text" id="fa" placeholder="e.g. laboratory backlog, result expected in March"></div>`, () => {
      const res = Store.recordForensicResult(f.id, me,
        document.getElementById('fr').value, document.getElementById('fa').value);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Recorded on the docket.'); render();
    }, 'Record');
  });

  /* Diagram 6 — a manual reopening needs something new, not just a change of mind. */
  const reopenBtn = document.getElementById('reopenCase');
  if (reopenBtn) reopenBtn.onclick = () => openModal('Reopen this filed docket', `
    <p class="small">A filed docket reopens by itself when a circulated suspect is arrested,
    circulated property is recovered, or forensics identify a perpetrator. Reopening it by hand
    requires new evidence or new information.</p>
    <div class="field">
      <label for="rv">New evidence or information <span class="req">*</span></label>
      <textarea id="rv" placeholder="What has come to light since the docket was filed."></textarea>
    </div>`, () => {
    const res = Store.reopenDocket(id, me, { trigger: 'manual', new_evidence: document.getElementById('rv').value });
    if (!res.ok) { toast(res.error, 'alert'); return false; }
    toast('Case reopened and the complainant notified.');
    render();
  }, 'Reopen');

  function val(elId) { const el = document.getElementById(elId); return el ? el.value : ''; }

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

  document.querySelectorAll('[data-accept-ce]').forEach(b => b.onclick = () => {
    openModal('Accept as a formal exhibit', `
      <p class="small">Accepting this makes it an exhibit on the docket, so it needs a register
      entry like any other item.</p>
      <div class="field"><label for="ce13">SAPS 13 register number <span class="req">*</span></label>
        <input type="text" id="ce13" placeholder="e.g. SAP13/412/2026"></div>`, () => {
      const res = Store.reviewComplainantEvidence(Number(b.dataset.acceptCe), me, 'accepted', '',
        document.getElementById('ce13').value);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Accepted as a formal exhibit.'); render();
    }, 'Accept as exhibit');
  });

  document.querySelectorAll('[data-reject-ce]').forEach(b => b.onclick = () => {
    openModal('Reject submitted evidence', `
      <div class="field"><label for="rjn">Reason <span class="req">*</span></label>
        <textarea id="rjn" placeholder="Why this cannot be accepted as an exhibit."></textarea></div>`, () => {
      const note = document.getElementById('rjn').value.trim();
      if (!note) { toast('A reason is required to reject submitted evidence.', 'alert'); return false; }
      const res = Store.reviewComplainantEvidence(Number(b.dataset.rejectCe), me, 'rejected', note);
      if (!res.ok) { toast(res.error, 'alert'); return false; }
      toast('Rejected and recorded.'); render();
    }, 'Reject');
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
