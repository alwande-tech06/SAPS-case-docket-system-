/* track.js — complainant status lookup and escalation */

renderPublicHeader();

let current = null;

/* a QR code scanned from a report receipt links here with ?ref=... */
const prefillRef = new URLSearchParams(location.search).get('ref');
if (prefillRef) {
  document.getElementById('ref').value = prefillRef;
  document.getElementById('fullname').focus();
}

document.getElementById('find').onclick = doLookup;
document.getElementById('ref').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
document.getElementById('fullname').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });

function doLookup() {
  const ref = document.getElementById('ref').value.trim();
  const fullname = document.getElementById('fullname').value.trim();
  const box = document.getElementById('lookupError');

  if (!ref || !fullname) {
    box.innerHTML = '<div class="notice notice-alert"><strong>Both fields are needed</strong>Enter your reference number and your full name.</div>';
    return;
  }

  /* A complainant ID (CMP-…) or a 13-digit SA ID number both identify the
     person rather than one report, so they list everything they have filed. */
  const isIdNumber = /^\d{13}$/.test(ref.replace(/\D/g, '')) && !/[A-Za-z]/.test(ref);
  if (/^CMP-/i.test(ref) || isIdNumber) {
    const list = isIdNumber
      ? Store.trackByIdNumber(ref, fullname)
      : Store.trackByComplainantNumber(ref, fullname);
    if (!list.ok) {
      box.innerHTML = `<div class="notice notice-alert"><strong>No record found</strong>Check the
        ${isIdNumber ? 'ID number' : 'complainant ID'} and full name and try again.</div>`;
      document.getElementById('result').hidden = true;
      return;
    }
    box.innerHTML = '';
    current = null;
    renderMulti(list, fullname);
    return;
  }

  const res = Store.track(ref, fullname);
  if (!res.ok) {
    /* deliberately generic — never confirm which part was wrong */
    box.innerHTML = '<div class="notice notice-alert"><strong>No report found</strong>Check the reference number and full name and try again.</div>';
    document.getElementById('result').hidden = true;
    return;
  }

  box.innerHTML = '';
  current = res;
  render(res);
}

function renderMulti(list, fullname) {
  const host = document.getElementById('result');
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Reports under ${esc(list.complainant.complainant_number)}</h2></div>
      <p class="small muted">Select a report to see its full status.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Reference</th><th>Type</th><th>Status</th><th>Reported</th><th></th></tr></thead>
        <tbody>
          ${list.reports.length ? list.reports.map(r => `
            <tr>
              <td class="ref">${esc(r.ref)}</td>
              <td>${esc(r.category)}</td>
              <td>${esc(r.status)}</td>
              <td>${esc(fmtDate(r.created_at))}</td>
              <td class="actions"><button class="btn btn-sm" data-view="${esc(r.ref)}">View</button></td>
            </tr>`).join('') : emptyRow(5, 'No reports found under this ID.')}
        </tbody>
      </table></div>
    </div>`;
  host.hidden = false;

  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    document.getElementById('ref').value = b.dataset.view;
    document.getElementById('fullname').value = fullname;
    doLookup();
  });
}

function render(res) {
  const host = document.getElementById('result');
  const d = res.docket;
  const i = res.intake;

  const ref = d ? d.cas_number : i.intake_number;
  const status = d ? labelStatus(d.current_status)
    : i.disposition === 'refused' ? 'Docket not opened'
    : i.disposition === 'referred' ? 'Referred to another station'
    : 'Awaiting police action';

  const events = [];
  events.push({ at: i.created_at, text: `Report received via ${labelChannel(i.channel)}` });
  events.push({ at: i.created_at, text: `Routed to ${Store.stationName(i.station_id)}` });
  if (d) {
    events.push({ at: d.registered_at, text: `Case registered — ${d.cas_number} issued` });
    if (d.detective_id) events.push({ at: d.registered_at, text: 'Investigator assigned' });
    res.history.filter(h => h.previous_status).forEach(h =>
      events.push({ at: h.changed_at, text: `Status: ${labelStatus(h.new_status)}` }));
  }
  if (res.refusal) {
    events.push({ at: res.refusal.refused_at,
      text: res.refusal.referred_to_station
        ? `Referred to ${res.refusal.referred_to_station}`
        : `Docket not opened — ${res.refusal.reason_category}` });
  }
  res.escalations.forEach(e => {
    events.push({ at: e.raised_at, text: e.raised_by_complainant
      ? 'You escalated this case to the station commander'
      : 'System escalated this case to the station commander' });
    if (e.responded_at) events.push({ at: e.responded_at, text: `Commander responded: ${e.response}` });
  });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const openEsc = res.escalations.find(e => e.status === 'open');
  const undisposed = !d && i.disposition === 'pending';
  const overdue = undisposed && ageHours(i.created_at) > 24;

  host.innerHTML = `
    <div class="evidence-row">
      ${stampBlock(d ? 'Case number' : 'Report reference', ref, d ? 'Registered' : 'Pending')}
      ${qrBlock(ref, 'Scan to reopen this case')}
    </div>

    <div class="card" style="margin-top:1rem">
      <div class="card-head">
        <h2>${esc(Store.categoryName(i.category_id))}</h2>
        <span class="badge ${d ? 'badge-neutral' : 'badge-alert'}">${esc(status)}</span>
      </div>
      <p class="small muted">Reported ${esc(fmtDateTime(i.created_at))} · ${esc(Store.stationName(i.station_id))}</p>

      ${overdue ? `<div class="notice notice-alert">
        <strong>No case number has been issued</strong>
        More than 24 hours have passed since you reported this. The system has placed it on
        the station commander's dashboard, and you do not need to do anything further.
      </div>` : ''}

      ${res.refusal && !res.refusal.referred_to_station ? `<div class="notice notice-alert">
        <strong>A docket was not opened</strong>
        Reason given: ${esc(res.refusal.reason_category)}. ${esc(res.refusal.reason_detail)}
        This decision is recorded permanently and is visible to the station commander.
      </div>` : ''}

      <h3 style="margin-top:1.2rem">Progress</h3>
      <ul class="timeline">
        ${events.map(e => `<li><div class="when">${esc(fmtDateTime(e.at))}</div>${esc(e.text)}</li>`).join('')}
      </ul>

      <div class="notice" style="margin-top:.6rem">
        Investigation notes are not shown here. They are kept out of public view to protect
        the case, not to keep you uninformed.
      </div>
    </div>

    <div class="card" style="margin-top:1rem">
      <div class="card-head"><h3>Not satisfied with progress?</h3></div>
      ${openEsc ? `
        <div class="notice"><strong>Escalation already open</strong>
          Raised ${esc(fmtDateTime(openEsc.raised_at))}. The station commander must respond
          within the service level. You will see the outcome here.</div>
      ` : `
        <p class="small muted">Your complaint goes to the station commander, above the official
        handling your case. That official cannot close or edit it.</p>
        <div class="field">
          <label for="escReason">Why are you escalating? <span class="req">*</span></label>
          <select id="escReason">
            <option value="">Select a reason</option>
            <option>No feedback has been given</option>
            <option>The case is not progressing</option>
            <option>I was turned away when I reported</option>
            <option>Concern about the conduct of an official</option>
          </select>
        </div>
        <div class="field">
          <label for="escDetail">Anything you want to add</label>
          <textarea id="escDetail" style="min-height:80px"></textarea>
        </div>
        <button class="btn btn-danger" id="escalate">Escalate to station commander</button>
      `}
    </div>

    ${renderWithdrawalCard(i)}`;

  host.hidden = false;

  const btn = document.getElementById('escalate');
  if (btn) btn.onclick = () => {
    const reason = document.getElementById('escReason').value;
    if (!reason) { toast('Choose a reason so the commander knows what to look at.', 'alert'); return; }
    const detail = document.getElementById('escDetail').value.trim();
    Store.raiseEscalation({
      docket_id: res.docket ? res.docket.id : null,
      intake_id: res.docket ? null : res.intake.id,
      reason: detail ? `${reason} — ${detail}` : reason,
      raised_by_complainant: true
    });
    toast('Escalation sent to the station commander.');
    render(Store.track(ref, document.getElementById('fullname').value.trim()));
  };

  const wbtn = document.getElementById('requestWithdrawal');
  if (wbtn) wbtn.onclick = () => {
    const cat = document.getElementById('wCat').value;
    if (!cat) { toast('Choose a reason so the request can be reviewed.', 'alert'); return; }
    const detail = document.getElementById('wDetail').value.trim();
    const outcome = Store.requestWithdrawal(i.id, { reason_category: cat, reason_detail: detail });
    if (!outcome.ok) { toast(outcome.error, 'alert'); return; }
    toast('Withdrawal request sent to the station commander.');
    render(Store.track(ref, document.getElementById('fullname').value.trim()));
  };
}

function renderWithdrawalCard(intake) {
  const elig = Store.withdrawalEligibility(intake.id);
  return `
    <div class="card" style="margin-top:1rem">
      <div class="card-head"><h3>Request to withdraw this case</h3></div>
      ${!elig.allowed ? `<div class="notice${elig.pending ? '' : ' notice-alert'}">
          <strong>${elig.pending ? 'Request already submitted' : 'This case cannot be withdrawn'}</strong>
          ${esc(elig.reason)}
        </div>` : `
        ${elig.protectedCategory ? `<div class="notice notice-alert">
          <strong>This request will be recorded, not automatically approved</strong>
          For this type of case, the investigation can continue in the public interest even if you
          ask to withdraw it. The station commander will note your request on the record.
        </div>` : `<p class="small muted">The station commander decides on every withdrawal request —
          the official or detective handling your case cannot approve it themselves.</p>`}
        <div class="field">
          <label for="wCat">Why are you asking to withdraw? <span class="req">*</span></label>
          <select id="wCat">
            <option value="">Select a reason</option>
            <option>The matter has been resolved between the parties</option>
            <option>I no longer wish to pursue this</option>
            <option>I reported this in error</option>
            <option>I am concerned about my safety if this continues</option>
            <option>Other</option>
          </select>
        </div>
        <div class="field">
          <label for="wDetail">Anything you want to add</label>
          <textarea id="wDetail" style="min-height:80px"></textarea>
        </div>
        <button class="btn btn-danger" id="requestWithdrawal">Request withdrawal</button>
      `}
    </div>`;
}
