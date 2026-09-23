/* commander.js — oversight dashboard */

const me = requireRole('commander');
if (me) { renderChrome('dashboard-commander.html'); render(); }

function render() {
  const st = me.station_id;
  const rec = Store.reconciliation(st);
  const stale = Store.dormantDockets(st);
  const escOpen = Store.escalations({ status: 'open' });
  const unassigned = Store.dockets({ station_id: st })
    .filter(d => d.current_status === 'awaiting_assignment');
  const refusalCount = Store.refusals(st).length;
  const withdrawalsPending = Store.withdrawals({ status: 'pending' }).length;

  document.getElementById('tiles').innerHTML = `
    <div class="stat${rec.undisposed.length ? ' alert' : ''}">
      <div class="n">${rec.undisposed.length}</div><div class="k">Undisposed reports</div></div>
    <div class="stat${escOpen.length ? ' alert' : ''}">
      <div class="n">${escOpen.length}</div><div class="k">Open escalations</div></div>
    <div class="stat${stale.length ? ' alert' : ''}">
      <div class="n">${stale.length}</div><div class="k">No diary entry 30+ days</div></div>
    <div class="stat"><div class="n">${refusalCount}</div><div class="k">Refusals recorded</div></div>
    <div class="stat${unassigned.length ? ' alert' : ''}">
      <div class="n">${unassigned.length}</div><div class="k">Awaiting assignment</div></div>
    <div class="stat${withdrawalsPending ? ' alert' : ''}">
      <div class="n">${withdrawalsPending}</div><div class="k">Withdrawal requests pending</div></div>`;

  /* attention list */
  const rows = [];
  rec.undisposed.forEach(i => rows.push({
    ref: i.intake_number, at: i.created_at,
    sla: ageHours(i.created_at) > 24 ? `Overdue ${ageFrom(i.created_at)}` : ageFrom(i.created_at),
    late: ageHours(i.created_at) > 24, type: 'Undisposed report', action: '' }));
  escOpen.forEach(e => {
    const d = e.docket_id ? Store.docket(e.docket_id) : null;
    const i = e.intake_id ? Store.intakes().find(x => x.id === e.intake_id) : null;
    const hrs = ageHours(e.raised_at);
    rows.push({ ref: d ? d.cas_number : (i ? i.intake_number : '—'), at: e.raised_at,
      sla: hrs > 72 ? `Overdue ${Math.floor(hrs / 24)} d` : `Due in ${Math.max(0, Math.round(72 - hrs))} h`,
      late: hrs > 72,
      type: e.raised_by_complainant ? 'Complainant escalation' : 'System escalation',
      action: `<button class="btn btn-sm btn-primary" data-esc="${e.id}">Respond</button>` });
  });
  stale.forEach(d => rows.push({ ref: d.cas_number, at: Store.lastDiaryEntry(d.id) || d.registered_at,
    sla: '—', late: false,
    type: Store.lastDiaryEntry(d.id)
      ? `Dormant — no diary entry for ${ageFrom(Store.lastDiaryEntry(d.id))}`
      : `Dormant — no diary entry since registration`,
    action: `<button class="btn btn-sm" data-reassign="${d.id}">Reassign</button>` }));
  unassigned.forEach(d => rows.push({ ref: d.cas_number, at: d.registered_at, sla: '—', late: true,
    type: 'Awaiting assignment',
    action: `<button class="btn btn-sm btn-primary" data-reassign="${d.id}">Assign</button>` }));

  /* Diagram 5 — a docket is only filed once the commander approves it. */
  Store.closures({ status: 'pending_approval' }).forEach(c => {
    const d = Store.docket(c.docket_id);
    if (!d || d.station_id !== st) return;
    rows.push({ ref: d.cas_number, at: c.requested_at, sla: ageFrom(c.requested_at), late: false,
      type: `Closure requested — ${c.category_label}`,
      action: `<button class="btn btn-sm btn-primary" data-closure="${c.id}">Decide</button>` });
  });

  /* Diagram 6 — filed dockets whose 12-month review date has arrived. */
  Store.broughtForwardDue(st).forEach(d => rows.push({
    ref: d.cas_number, at: d.brought_forward_at, sla: '—', late: false,
    type: 'Brought-forward review due',
    action: `<button class="btn btn-sm" data-bf="${d.id}">Review</button>` }));

  /* Diagram 2 — NI 3/2011 s1.4.10: registered but not yet with a detective. */
  Store.overdueDetectiveHandover(st).forEach(d => rows.push({
    ref: d.cas_number, at: d.registered_at, sla: `Overdue ${ageFrom(d.registered_at)}`, late: true,
    type: 'Not handed to a detective within 24 hours',
    action: `<button class="btn btn-sm btn-primary" data-reassign="${d.id}">Allocate</button>` }));

  document.getElementById('attentionBody').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td class="ref">${esc(r.ref)}</td>
      <td>${esc(fmtDateTime(r.at))}</td>
      <td>${r.late ? `<span class="badge badge-alert">${esc(r.sla)}</span>` : esc(r.sla)}</td>
      <td>${esc(r.type)}</td>
      <td class="actions">${r.action}</td>
    </tr>`).join('') : emptyRow(5, 'Nothing outstanding. Every report has an outcome and no case is overdue.');

  /* reconciliation */
  const gap = rec.received - (rec.docket_opened + rec.refused + rec.referred);
  document.getElementById('reconcile').innerHTML = `
    <div class="grid grid-3">
      <div class="stat"><div class="n">${rec.received}</div><div class="k">Reports received</div></div>
      <div class="stat good"><div class="n">${rec.docket_opened}</div><div class="k">Dockets opened</div></div>
      <div class="stat"><div class="n">${rec.refused + rec.referred}</div><div class="k">Refused or referred</div></div>
    </div>
    <div class="notice ${gap ? 'notice-alert' : 'notice-good'}" style="margin-top:1rem">
      <strong>${gap ? `${gap} report(s) with no outcome recorded` : 'All reports accounted for'}</strong>
      ${gap ? 'These people reported a crime and no official has recorded a decision. Each one is listed above.'
            : 'Every report received has been closed with a recorded outcome.'}
    </div>`;

  /* refusals by official */
  const byOfficer = Store.refusalsByOfficer(st);
  const max = Math.max(1, ...byOfficer.map(r => r[1]));
  document.getElementById('refusalChart').innerHTML = byOfficer.length ? byOfficer.map(([name, n]) => `
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem">
      <div class="small" style="min-width:130px">${esc(name)}</div>
      <div style="flex:1;background:var(--paper-lift);border:1px solid var(--rule-soft);height:16px">
        <div style="width:${(n / max) * 100}%;height:100%;background:${n === max && n > 1 ? 'var(--stamp)' : 'var(--slate)'}"></div>
      </div>
      <div class="ref small">${n}</div>
    </div>`).join('') : '<div class="empty">No refusals recorded at this station.</div>';

  /* Decisions you declined to sign, by official. One is a disagreement; a run
     of them by one person is what this report exists to show. */
  const reversals = Store.reversalsByOfficer(st);
  if (reversals.length) {
    document.getElementById('refusalChart').innerHTML += `
      <div style="margin-top:1rem">
        <p class="small muted" style="margin:0 0 .4rem">Decisions not signed off, by official</p>
        ${reversals.map(r => `
          <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.35rem">
            <div class="small" style="min-width:130px">${esc(r.name)}</div>
            <div class="ref small">${r.count}</div>
            ${r.flagged ? '<span class="badge badge-alert">Pattern — review</span>' : ''}
          </div>`).join('')}
      </div>`;
  }

  /* Diagram 3 — reassignment patterns worth a second look. */
  const patterns = Store.reassignmentPatterns(st);
  if (patterns.length) {
    document.getElementById('refusalChart').innerHTML += `
      <div class="notice notice-alert" style="margin-top:.9rem">
        <strong>Reassignment pattern flagged for the oversight report</strong>
        ${patterns.map(p => esc(p.text)).join('<br>')}
      </div>`;
  }

  renderCosignQueue();

  /* detective availability */
  const dets = Store.users().filter(u => u.role === 'detective' && u.station_id === st);
  document.getElementById('detAvail').innerHTML = dets.map(u => {
    const load = Store.dockets({ detective_id: u.id }).filter(d => d.current_status !== 'closed').length;
    const avail = u.availability === 'available';
    return `<div style="display:flex;justify-content:space-between;gap:.6rem;padding:.45rem 0;border-bottom:1px solid var(--rule-soft)">
      <div><div class="small">${esc(u.name)}</div>
        <div class="small muted">${esc(Store.specialisations().find(s => s.id === u.specialisation_id)?.name || 'General')}</div></div>
      <div style="text-align:right">
        <span class="badge ${avail ? 'badge-good' : 'badge-alert'}">${avail ? 'Available' : 'On leave'}</span>
        <div class="small muted">${load} open</div>
      </div></div>`;
  }).join('');

  wire();
}

function wire() {
  document.querySelectorAll('[data-esc]').forEach(b => b.onclick = () => {
    const e = Store.escalations().find(x => x.id === Number(b.dataset.esc));
    const d = e.docket_id ? Store.docket(e.docket_id) : null;
    const trail = d ? Store.audit({ case_id: d.id }).slice(0, 6) : [];
    openModal('Respond to an escalation', `
      <div class="notice"><strong>${esc(e.raised_by_complainant ? 'Raised by the complainant' : 'Raised by the system')}</strong>
        ${esc(e.reason)}<br><span class="small muted">${esc(fmtDateTime(e.raised_at))}</span></div>
      ${trail.length ? `<h3 style="font-size:.9rem">Recent activity on this case</h3>
        <ul class="timeline">${trail.map(t => `<li><div class="when">${esc(fmtDateTime(t.performed_at))} · ${esc(t.user_name)}</div>${esc(t.description)}</li>`).join('')}</ul>` : ''}
      <div class="field"><label for="oc">Outcome <span class="req">*</span></label>
        <select id="oc">
          <option value="">Select an outcome</option>
          <option>Docket reassigned to another detective</option>
          <option>Instruction issued to the investigating officer</option>
          <option>Docket opened after review of a refusal</option>
          <option>Escalation closed as unfounded</option>
          <option>Referred to provincial oversight / IPID</option>
        </select></div>
      <div class="field"><label for="or">Reason for this outcome <span class="req">*</span></label>
        <textarea id="or" placeholder="What you found and what you have directed."></textarea></div>`, () => {
      const oc = document.getElementById('oc').value;
      const or = document.getElementById('or').value.trim();
      if (!oc || !or) { toast('Both the outcome and the reason are required.', 'alert'); return false; }
      const res = Store.respondEscalation(e.id, me, oc, or);
      if (res && res.ok === false) { toast(res.error, 'alert'); render(); return; }
      toast('Response recorded and the complainant updated.');
      render();
    }, 'Record response');
  });

  /* Diagram 5 — approving or refusing a closure. The system will not let the
     investigating officer who asked for it sign it off. */
  document.querySelectorAll('[data-closure]').forEach(b => b.onclick = () => {
    const c = Store.closures({ status: 'pending_approval' }).find(x => x.id === Number(b.dataset.closure));
    const check = Store.closureChecklist(c.id, me.id);
    const d = check.docket;

    openModal(`Inspect ${d.cas_number} before filing`, `
      <div class="notice"><strong>${esc(c.category_label)}</strong>
        Requested by ${esc(Store.userName(c.requested_by))} on ${esc(fmtDateTime(c.requested_at))}.<br>
        <span class="small muted">Motivation: ${esc(c.motivation || '—')}</span></div>

      ${c.warrant_reference || c.circulation_reference || c.prosecutor_reference || c.discrepancy_report ? `
      <table style="margin-bottom:1rem">
        ${c.warrant_reference ? `<tr><th>Warrant</th><td class="ref">${esc(c.warrant_reference)}</td></tr>` : ''}
        ${c.circulation_reference ? `<tr><th>Circulation</th><td class="ref">${esc(c.circulation_reference)}</td></tr>` : ''}
        ${c.prosecutor_reference ? `<tr><th>Prosecutor ref</th><td class="ref">${esc(c.prosecutor_reference)}</td></tr>` : ''}
        ${c.discrepancy_report ? `<tr><th>Discrepancy</th><td>${esc(c.discrepancy_report)}</td></tr>` : ''}
      </table>` : ''}

      <h3 style="font-size:.95rem">Closure checklist</h3>
      <p class="small muted">Each item is checked against the docket, not against an assurance.
      The docket cannot be filed while any item is outstanding.</p>
      <ul class="timeline" style="margin-bottom:1rem">
        ${check.items.map(i => `
          <li>
            <div class="when">${i.informational
              ? '<span class="badge badge-neutral">On approval</span>'
              : (i.ok ? '<span class="badge badge-good">Satisfied</span>'
                      : '<span class="badge badge-alert">Outstanding</span>')}</div>
            <strong>${esc(i.label)}</strong>
            <div class="small muted">${esc(i.detail)}</div>
            ${(i.missing || []).length ? `<ul class="small" style="margin:.35rem 0 0 1rem">
              ${i.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
            ${!i.ok && !i.informational ? whyBlocked(i.code, 'What this rule requires') : ''}
            ${(i.evidence || []).length ? `<div class="small muted" style="margin-top:.35rem">
              ${i.evidence.map(e => `<div>· ${esc(e.text)} — <em>${esc(e.state)}</em>${
                e.answer ? `: ${esc(e.answer)}` : ''}${e.by ? ` (${esc(e.by)})` : ''}</div>`).join('')}
            </div>` : ''}
          </li>`).join('')}
      </ul>

      ${check.canApprove ? '' : `<div class="notice notice-alert">
        <strong>This docket cannot be filed yet</strong>
        ${check.blocking.length} item(s) outstanding. You can still refuse the closure and send the
        case back — that is usually what an outstanding item calls for.
        ${whyBlocked(check.blocking[0].code, 'Why is approving blocked?')}</div>`}

      <div class="field">
        <label for="cdr">Your reason <span class="req">*</span></label>
        <textarea id="cdr" placeholder="What you checked, and why you are approving or refusing."></textarea>
      </div>
      <div id="closureErr"></div>
      <div class="btn-row">
        <button class="btn btn-danger" id="approveClosure"${check.canApprove ? '' : ' disabled'}>
          ${check.canApprove ? 'Approve — file the docket' : 'Approve — blocked by the checklist'}</button>
        <button class="btn btn-primary" id="rejectClosure">Refuse — send it back</button>
      </div>`, () => {}, 'Close without deciding');

    const decide = decision => {
      const res = Store.decideClosure(c.id, me, decision, document.getElementById('cdr').value);
      if (!res.ok) {
        toast(res.error, 'alert');
        const host = document.getElementById('closureErr');
        if (host) host.innerHTML = `<div class="notice notice-alert">
          <strong>Not recorded</strong>${esc(res.error)}${whyBlocked(res.code)}</div>`;
        return;
      }
      closeModal();
      toast(decision === 'approved'
        ? 'Docket filed, the complainant notified and the decision recorded.'
        : 'Closure refused. The case stays open with the investigating officer.');
      render();
    };
    const approveBtn = document.getElementById('approveClosure');
    if (!approveBtn.disabled) approveBtn.onclick = () => decide('approved');
    document.getElementById('rejectClosure').onclick = () => decide('refused');
  });

  /* Diagram 6 — the brought-forward review on a filed docket. */
  document.querySelectorAll('[data-bf]').forEach(b => b.onclick = () => {
    const d = Store.docket(Number(b.dataset.bf));
    openModal('Brought-forward review', `
      <div class="notice"><strong>${esc(d.cas_number)}</strong>
        Filed as ${esc(d.closure_type || '—')}. Twelve months have passed, so it comes back for review.</div>
      <div class="field">
        <label for="bfr">New evidence or information, if any</label>
        <textarea id="bfr" placeholder="Leave empty to note the review and keep the docket filed."></textarea>
      </div>`, () => {
      const text = document.getElementById('bfr').value.trim();
      if (!text) {
        Store.noteBroughtForwardReview(d.id, me);
        toast('Review recorded. The docket stays filed.');
      } else {
        const res = Store.reopenDocket(d.id, me, { trigger: 'manual', new_evidence: text });
        if (!res.ok) { toast(res.error, 'alert'); return false; }
        toast('Case reopened and the complainant notified.');
      }
      render();
    }, 'Record review');
  });

  document.querySelectorAll('[data-reassign]').forEach(b => b.onclick = () => {
    const d = Store.docket(Number(b.dataset.reassign));
    const cat = Store.categories().find(c => c.id === d.category_id);
    const dets = Store.users().filter(u => u.role === 'detective' && u.is_active &&
      u.station_id === me.station_id);
    openModal('Reassign this docket', `
      <div class="notice"><strong class="ref">${esc(d.cas_number)}</strong>
        ${esc(Store.categoryName(d.category_id))} — requires
        ${esc(Store.specialisations().find(s => s.id === cat.required_specialisation_id)?.name || 'general')} specialisation</div>
      <p class="small">An override is recorded as its own event with your name against it.
      Override frequency appears in station reports.</p>
      <div class="field"><label for="rd">Assign to <span class="req">*</span></label>
        <select id="rd">${dets.map(u => {
          const load = Store.dockets({ detective_id: u.id }).filter(x => x.current_status !== 'closed').length;
          const match = u.specialisation_id === cat.required_specialisation_id;
          return `<option value="${u.id}">${esc(u.name)} — ${load} open${match ? '' : ' (specialisation does not match)'}${u.availability === 'available' ? '' : ' (on leave)'}</option>`;
        }).join('')}</select></div>
      <div class="field"><label for="rcat2">Reason <span class="req">*</span></label>
        <select id="rcat2">
          <option value="">Select a reason</option>
          ${Store.reassignmentReasons().map(r => `<option>${esc(r)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="rr2">Detail <span class="req">*</span> <span class="small muted">(required for "Other")</span></label>
        <textarea id="rr2" style="min-height:80px"></textarea></div>
      <div id="reassignErr"></div>`, () => {
      const res = Store.reassign(d.id, document.getElementById('rd').value, me,
        document.getElementById('rcat2').value, document.getElementById('rr2').value);
      if (!res.ok) {
        toast(res.error, 'alert');
        const host = document.getElementById('reassignErr');
        if (host) host.innerHTML = `<div class="notice notice-alert">
          <strong>${res.routedToCluster ? 'Routed to the cluster commander' : 'Not reassigned'}</strong>
          ${esc(res.error)}${whyBlocked(res.code)}</div>`;
        render();
        return res.routedToCluster ? undefined : false;
      }
      if (d.current_status === 'awaiting_assignment') {
        Store.updateStatus(d.id, 'registered', me, 'Allocated by commander');
      }
      toast(`Docket allocated to ${res.detective.name} and the complainant notified.`);
      render();
    }, 'Reassign');
  });
}

/* Refusals a police official has proposed. Diagram 1 routes these to the
   station commander, who is the only person who can sign one off. */
function renderCosignQueue() {
  const queue = Store.pendingRefusals(me.station_id);
  const host = document.getElementById('cosign');
  if (!host) return;
  if (!queue.length) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Decisions not to open a docket — awaiting your signature</h3>
        <span class="badge badge-alert">${queue.length}</span>
      </div>
      <p class="small muted">Each of these reports is still open and still counting towards the
      24-hour reconciliation. If you do not sign, a docket must be opened.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Report</th><th>Type</th><th>Proposed by</th><th>Reason</th><th>Waiting</th><th></th></tr></thead>
        <tbody>
          ${queue.map(r => {
            const i = Store.intakes().find(x => x.id === r.intake_id);
            return `<tr>
              <td class="ref">${esc(i ? i.intake_number : '—')}</td>
              <td>${esc(i ? Store.categoryName(i.category_id) : '—')}</td>
              <td>${esc(Store.userName(r.officer_id))}</td>
              <td class="small">${esc(r.reason_category)}</td>
              <td>${esc(ageFrom(r.raised_at))}</td>
              <td class="actions"><button class="btn btn-sm btn-primary" data-cosign="${r.id}">Review</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>`;

  document.querySelectorAll('[data-cosign]').forEach(b => b.onclick = () => {
    const r = Store.pendingRefusals().find(x => x.id === Number(b.dataset.cosign));
    const i = Store.intakes().find(x => x.id === r.intake_id);
    const category = Store.categoryName(i.category_id);

    openModal('Second signature on a decision not to open a docket', `
      <div class="notice notice-alert">
        <strong>Signing ends this report</strong>
        No docket is opened, and the complainant is told why. If the facts disclose a crime —
        any element of the definition being present is enough — do not sign. The report returns
        to the queue and a docket is opened.
      </div>

      <table>
        <tr><th>Report</th><td class="ref">${esc(i.intake_number)}</td></tr>
        <tr><th>Reported as</th><td>${esc(category)}</td></tr>
        <tr><th>Proposed by</th><td>${esc(Store.userName(r.officer_id))}</td></tr>
        <tr><th>Ground</th><td>${esc(r.reason_category)}</td></tr>
        ${r.missing_element ? `<tr><th>Element said to be missing</th><td>${esc(r.missing_element)}</td></tr>` : ''}
        ${r.definition_reference ? `<tr><th>Definition consulted</th><td>${esc(r.definition_reference)}</td></tr>` : ''}
        ${r.duplicate_of ? `<tr><th>Duplicate of</th><td class="ref">${esc(r.duplicate_of)}</td></tr>` : ''}
        <tr><th>Their reasons</th><td>${esc(r.reason_detail)}</td></tr>
        <tr><th>What was reported</th><td>${esc(i.incident_description) || '<span class="muted">Not described online</span>'}</td></tr>
      </table>

      <h4 style="font-size:.9rem;margin:1.1rem 0 .3rem">Your decision</h4>
      <div class="decision">
        <label>
          <input type="radio" name="cosignChoice" value="reject">
          <span><strong>Do not sign — open a docket</strong>
            <span class="small muted">The facts disclose a crime, or the reasons do not hold up.
            This is recorded as a reversal of the proposing official's decision.</span></span>
        </label>
        <label>
          <input type="radio" name="cosignChoice" value="agree">
          <span><strong>Sign off — no docket is opened</strong>
            <span class="small muted">You are satisfied that no element of the definition of
            ${esc(category.toLowerCase())} is present.</span></span>
        </label>
      </div>

      <div id="defWrap" hidden>
        <label class="choice" style="margin-bottom:.7rem">
          <input type="checkbox" id="defChecked">
          I compared these facts against the definition of ${esc(category.toLowerCase())},
          and no element of it is present.
        </label>
      </div>

      <div class="field">
        <label for="cnote" id="cnoteLabel">Your reasons <span class="req">*</span></label>
        <textarea id="cnote" placeholder="Choose above, then record your reasons."></textarea>
      </div>

      <div id="cosignChecklist"></div>
      <div id="cosignErr"></div>
      <div class="btn-row" id="cosignActions">
        <button class="btn btn-primary" id="submitCosign" disabled>Record decision</button>
      </div>`, () => {}, null);

    const submit = document.getElementById('submitCosign');
    const noteBox = document.getElementById('cnote');
    const noteLabel = document.getElementById('cnoteLabel');

    function draft() {
      const chosen = document.querySelector('input[name="cosignChoice"]:checked');
      return {
        decision: chosen ? chosen.value : '',
        note: noteBox.value,
        definition_checked: document.getElementById('defChecked').checked
      };
    }

    function refresh() {
      const dr = draft();
      const signing = dr.decision === 'agree';
      /* The label follows the choice, because the two decisions call for
         different reasons — and signing is the one that ends the report. */
      noteLabel.innerHTML = dr.decision
        ? (signing ? 'Why the facts disclose no offence <span class="req">*</span>'
                   : 'Why a docket must be opened <span class="req">*</span>')
        : 'Your reasons <span class="req">*</span>';
      noteBox.placeholder = dr.decision
        ? (signing ? 'Which element of the definition is absent, and why the facts do not meet it.'
                   : 'What the facts disclose, and which element of the definition is present.')
        : 'Choose above, then record your reasons.';
      document.getElementById('defWrap').hidden = !signing;

      const res = Rules.render(document.getElementById('cosignChecklist'),
        { refusalId: r.id, actorId: me.id }, 'cosign', dr);
      Rules.gate(submit, res, { linkHost: document.getElementById('cosignActions'),
        linkLabel: 'What is required?' });
      submit.className = 'btn ' + (signing ? 'btn-danger' : 'btn-primary');
      submit.textContent = dr.decision
        ? (signing ? 'Sign off — no docket' : 'Do not sign — open a docket')
        : 'Record decision';
    }

    document.querySelectorAll('input[name="cosignChoice"]').forEach(el => el.onchange = refresh);
    document.getElementById('defChecked').onchange = refresh;
    noteBox.oninput = refresh;
    refresh();

    submit.onclick = () => {
      const dr = draft();
      const res = Store.cosignRefusal(r.id, me, dr.decision === 'agree', dr.note,
        { definition_checked: dr.definition_checked });
      if (!res.ok) {
        toast(res.error, 'alert');
        document.getElementById('cosignErr').innerHTML = `<div class="notice notice-alert">
          <strong>Not recorded</strong>${esc(res.error)}${whyBlocked(res.code)}</div>`;
        return;
      }
      if (res.mustOpenDocket) {
        const opened = Store.openDocket(i.id, me);
        closeModal();
        toast(opened
          ? `Decision reversed. ${opened.docket.cas_number} opened and the complainant notified.`
          : 'Decision reversed.', 'alert');
      } else {
        closeModal();
        toast('Signed off. The complainant has been notified of the reason.', 'alert');
      }
      render();
    };
  });

  /* Diagram 5 — approving or refusing a closure. The system will not let the
     investigating officer who asked for it sign it off. */
  document.querySelectorAll('[data-closure]').forEach(b => b.onclick = () => {
    const c = Store.closures({ status: 'pending_approval' }).find(x => x.id === Number(b.dataset.closure));
    const check = Store.closureChecklist(c.id, me.id);
    const d = check.docket;

    openModal(`Inspect ${d.cas_number} before filing`, `
      <div class="notice"><strong>${esc(c.category_label)}</strong>
        Requested by ${esc(Store.userName(c.requested_by))} on ${esc(fmtDateTime(c.requested_at))}.<br>
        <span class="small muted">Motivation: ${esc(c.motivation || '—')}</span></div>

      ${c.warrant_reference || c.circulation_reference || c.prosecutor_reference || c.discrepancy_report ? `
      <table style="margin-bottom:1rem">
        ${c.warrant_reference ? `<tr><th>Warrant</th><td class="ref">${esc(c.warrant_reference)}</td></tr>` : ''}
        ${c.circulation_reference ? `<tr><th>Circulation</th><td class="ref">${esc(c.circulation_reference)}</td></tr>` : ''}
        ${c.prosecutor_reference ? `<tr><th>Prosecutor ref</th><td class="ref">${esc(c.prosecutor_reference)}</td></tr>` : ''}
        ${c.discrepancy_report ? `<tr><th>Discrepancy</th><td>${esc(c.discrepancy_report)}</td></tr>` : ''}
      </table>` : ''}

      <h3 style="font-size:.95rem">Closure checklist</h3>
      <p class="small muted">Each item is checked against the docket, not against an assurance.
      The docket cannot be filed while any item is outstanding.</p>
      <ul class="timeline" style="margin-bottom:1rem">
        ${check.items.map(i => `
          <li>
            <div class="when">${i.informational
              ? '<span class="badge badge-neutral">On approval</span>'
              : (i.ok ? '<span class="badge badge-good">Satisfied</span>'
                      : '<span class="badge badge-alert">Outstanding</span>')}</div>
            <strong>${esc(i.label)}</strong>
            <div class="small muted">${esc(i.detail)}</div>
            ${(i.missing || []).length ? `<ul class="small" style="margin:.35rem 0 0 1rem">
              ${i.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
            ${!i.ok && !i.informational ? whyBlocked(i.code, 'What this rule requires') : ''}
            ${(i.evidence || []).length ? `<div class="small muted" style="margin-top:.35rem">
              ${i.evidence.map(e => `<div>· ${esc(e.text)} — <em>${esc(e.state)}</em>${
                e.answer ? `: ${esc(e.answer)}` : ''}${e.by ? ` (${esc(e.by)})` : ''}</div>`).join('')}
            </div>` : ''}
          </li>`).join('')}
      </ul>

      ${check.canApprove ? '' : `<div class="notice notice-alert">
        <strong>This docket cannot be filed yet</strong>
        ${check.blocking.length} item(s) outstanding. You can still refuse the closure and send the
        case back — that is usually what an outstanding item calls for.
        ${whyBlocked(check.blocking[0].code, 'Why is approving blocked?')}</div>`}

      <div class="field">
        <label for="cdr">Your reason <span class="req">*</span></label>
        <textarea id="cdr" placeholder="What you checked, and why you are approving or refusing."></textarea>
      </div>
      <div id="closureErr"></div>
      <div class="btn-row">
        <button class="btn btn-danger" id="approveClosure"${check.canApprove ? '' : ' disabled'}>
          ${check.canApprove ? 'Approve — file the docket' : 'Approve — blocked by the checklist'}</button>
        <button class="btn btn-primary" id="rejectClosure">Refuse — send it back</button>
      </div>`, () => {}, 'Close without deciding');

    const decide = decision => {
      const res = Store.decideClosure(c.id, me, decision, document.getElementById('cdr').value);
      if (!res.ok) {
        toast(res.error, 'alert');
        const host = document.getElementById('closureErr');
        if (host) host.innerHTML = `<div class="notice notice-alert">
          <strong>Not recorded</strong>${esc(res.error)}${whyBlocked(res.code)}</div>`;
        return;
      }
      closeModal();
      toast(decision === 'approved'
        ? 'Docket filed, the complainant notified and the decision recorded.'
        : 'Closure refused. The case stays open with the investigating officer.');
      render();
    };
    const approveBtn = document.getElementById('approveClosure');
    if (!approveBtn.disabled) approveBtn.onclick = () => decide('approved');
    document.getElementById('rejectClosure').onclick = () => decide('refused');
  });

  /* Diagram 6 — the brought-forward review on a filed docket. */
  document.querySelectorAll('[data-bf]').forEach(b => b.onclick = () => {
    const d = Store.docket(Number(b.dataset.bf));
    openModal('Brought-forward review', `
      <div class="notice"><strong>${esc(d.cas_number)}</strong>
        Filed as ${esc(d.closure_type || '—')}. Twelve months have passed, so it comes back for review.</div>
      <div class="field">
        <label for="bfr">New evidence or information, if any</label>
        <textarea id="bfr" placeholder="Leave empty to note the review and keep the docket filed."></textarea>
      </div>`, () => {
      const text = document.getElementById('bfr').value.trim();
      if (!text) {
        Store.noteBroughtForwardReview(d.id, me);
        toast('Review recorded. The docket stays filed.');
      } else {
        const res = Store.reopenDocket(d.id, me, { trigger: 'manual', new_evidence: text });
        if (!res.ok) { toast(res.error, 'alert'); return false; }
        toast('Case reopened and the complainant notified.');
      }
      render();
    }, 'Record review');
  });

  document.querySelectorAll('[data-reassign]').forEach(b => b.onclick = () => {
    const d = Store.docket(Number(b.dataset.reassign));
    const cat = Store.categories().find(c => c.id === d.category_id);
    const dets = Store.users().filter(u => u.role === 'detective' && u.is_active &&
      u.station_id === me.station_id);
    openModal('Reassign this docket', `
      <div class="notice"><strong class="ref">${esc(d.cas_number)}</strong>
        ${esc(Store.categoryName(d.category_id))} — requires
        ${esc(Store.specialisations().find(s => s.id === cat.required_specialisation_id)?.name || 'general')} specialisation</div>
      <p class="small">An override is recorded as its own event with your name against it.
      Override frequency appears in station reports.</p>
      <div class="field"><label for="rd">Assign to <span class="req">*</span></label>
        <select id="rd">${dets.map(u => {
          const load = Store.dockets({ detective_id: u.id }).filter(x => x.current_status !== 'closed').length;
          const match = u.specialisation_id === cat.required_specialisation_id;
          return `<option value="${u.id}">${esc(u.name)} — ${load} open${match ? '' : ' (specialisation does not match)'}${u.availability === 'available' ? '' : ' (on leave)'}</option>`;
        }).join('')}</select></div>
      <div class="field"><label for="rcat2">Reason <span class="req">*</span></label>
        <select id="rcat2">
          <option value="">Select a reason</option>
          ${Store.reassignmentReasons().map(r => `<option>${esc(r)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="rr2">Detail <span class="req">*</span> <span class="small muted">(required for "Other")</span></label>
        <textarea id="rr2" style="min-height:80px"></textarea></div>
      <div id="reassignErr"></div>`, () => {
      const res = Store.reassign(d.id, document.getElementById('rd').value, me,
        document.getElementById('rcat2').value, document.getElementById('rr2').value);
      if (!res.ok) {
        toast(res.error, 'alert');
        const host = document.getElementById('reassignErr');
        if (host) host.innerHTML = `<div class="notice notice-alert">
          <strong>${res.routedToCluster ? 'Routed to the cluster commander' : 'Not reassigned'}</strong>
          ${esc(res.error)}${whyBlocked(res.code)}</div>`;
        render();
        return res.routedToCluster ? undefined : false;
      }
      if (d.current_status === 'awaiting_assignment') {
        Store.updateStatus(d.id, 'registered', me, 'Allocated by commander');
      }
      toast(`Docket allocated to ${res.detective.name} and the complainant notified.`);
      render();
    }, 'Reassign');
  });
}

/* Refusals a police official has proposed. Diagram 1 routes these to the
   station commander, who is the only person who can sign one off. */