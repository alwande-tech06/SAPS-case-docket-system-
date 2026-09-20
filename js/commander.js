/* commander.js — oversight dashboard */

const me = requireRole('commander');
if (me) { renderChrome('dashboard-commander.html'); render(); }

function render() {
  const st = me.station_id;
  const rec = Store.reconciliation(st);
  const stale = Store.staleDockets(st);
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
      <div class="n">${stale.length}</div><div class="k">Stale 30+ days</div></div>
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
  stale.forEach(d => rows.push({ ref: d.cas_number, at: d.last_activity_at, sla: '—', late: false,
    type: `No activity ${ageFrom(d.last_activity_at)}`,
    action: `<button class="btn btn-sm" data-reassign="${d.id}">Reassign</button>` }));
  unassigned.forEach(d => rows.push({ ref: d.cas_number, at: d.registered_at, sla: '—', late: true,
    type: 'Awaiting assignment',
    action: `<button class="btn btn-sm btn-primary" data-reassign="${d.id}">Assign</button>` }));

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
      Store.respondEscalation(e.id, me, oc, or);
      toast('Response recorded and the complainant updated.');
      render();
    }, 'Record response');
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
      <div class="field"><label for="rr2">Reason <span class="req">*</span></label>
        <textarea id="rr2" style="min-height:80px"></textarea></div>`, () => {
      const reason = document.getElementById('rr2').value.trim();
      if (!reason) { toast('A reason is required for every override.', 'alert'); return false; }
      Store.reassign(d.id, document.getElementById('rd').value, me, reason);
      Store.updateStatus(d.id, 'registered', me, 'Reassigned by commander');
      toast('Docket reassigned and the override logged.');
      render();
    }, 'Reassign');
  });
}
