/* track.js — complainant status lookup and escalation */

renderPublicHeader();

let current = null;

/* a QR code scanned from a report receipt links here with ?ref=... */
const prefillRef = new URLSearchParams(location.search).get('ref');
if (prefillRef) {
  document.getElementById('ref').value = prefillRef;
  document.getElementById('surname').focus();
}

document.getElementById('find').onclick = doLookup;
document.getElementById('ref').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
document.getElementById('surname').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });

function doLookup() {
  const ref = document.getElementById('ref').value.trim();
  const surname = document.getElementById('surname').value.trim();
  const box = document.getElementById('lookupError');

  if (!ref || !surname) {
    box.innerHTML = '<div class="notice notice-alert"><strong>Both fields are needed</strong>Enter your reference number and the surname you reported under.</div>';
    return;
  }

  const res = Store.track(ref, surname);
  if (!res.ok) {
    /* deliberately generic — never confirm which part was wrong */
    box.innerHTML = '<div class="notice notice-alert"><strong>No report found</strong>Check the reference number and surname and try again.</div>';
    document.getElementById('result').hidden = true;
    return;
  }

  box.innerHTML = '';
  current = res;
  render(res);
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
    </div>`;

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
    render(Store.track(ref, document.getElementById('surname').value.trim()));
  };
}
