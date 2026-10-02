/* track.js — complainant status lookup and escalation */

renderPublicHeader();

let current = null;

/* ---------------- arriving from a scanned QR code ----------------
   The link carries the reference and the report's random token. The token only
   makes the URL unguessable — it is not a credential. A printed slip can be
   lost, photographed or picked up by somebody else, and what is behind it is
   private under the Victims' Charter. So the link identifies the report, and
   the person still has to prove they are the complainant: the ID number given
   when reporting, then a one-time code sent to the number on the report. The
   server checks both, and only then does the report reach this page. */
const params = new URLSearchParams(location.search);
const prefillRef = params.get('ref');
const linkToken = params.get('t');

if (prefillRef && linkToken) {
  startLinkVerification(prefillRef, linkToken);
} else if (prefillRef) {
  document.getElementById('ref').value = prefillRef;
  document.getElementById('fullname').focus();
}

async function startLinkVerification(ref, token) {
  const check = await Store.fetchTrackLink(ref, token);
  const host = document.getElementById('result');
  const lookup = document.getElementById('lookup');

  if (!check.ok) {
    /* Deliberately the same message whether the reference is unknown or the
       token is wrong, so the page cannot be used to confirm that a reference
       exists. */
    document.getElementById('lookupError').innerHTML = `
      <div class="notice notice-alert">
        <strong>This link cannot be opened</strong>
        It may have been mistyped, or it may belong to a report that is no longer on this
        system. You can still look your report up below.
      </div>`;
    return;
  }

  lookup.hidden = true;
  host.hidden = false;

  function drawIdStep(error) {
    host.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Check it is you</h2></div>
        <p class="small muted">This link opens a specific report. Before anything is shown, we
        confirm you are the person who made it — a printed slip can be lost or photographed,
        and what is in your case is private.</p>
        ${error ? `<div class="notice notice-alert"><strong>That did not match</strong>${esc(error)}</div>` : ''}
        <div class="field">
          <label for="linkId">The ID number you gave when you reported <span class="req">*</span></label>
          <input type="text" id="linkId" inputmode="numeric" maxlength="13" placeholder="13 digits">
          ${check.id_hint ? `<p class="hint">It ends in ${esc(check.id_hint)}.</p>` : ''}
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="linkIdGo">Continue</button>
          <a class="btn" href="/track">Look up a different report</a>
        </div>
      </div>`;
    const go = document.getElementById('linkIdGo');
    const input = document.getElementById('linkId');
    input.focus();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
    go.onclick = async () => {
      if (go.disabled) return;
      go.disabled = true;
      const res = await Store.fetchTrackLink(ref, token, { id_number: input.value });
      go.disabled = false;
      if (!res.ok) {
        drawIdStep(res.code === 'id_mismatch' ? 'That is not the ID number recorded on this report.'
          : res.error || 'The report could not be fetched. Check your connection and try again.');
        return;
      }
      drawOtpStep(res, null);
    };
  }

  /* person: { name, demo_code } — demo_code only on a demonstration system,
     which has no SMS and shows the code instead. */
  function drawOtpStep(person, error) {
    host.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Enter the code we sent you</h2></div>
        <div class="notice">
          <strong>Code sent to ${person.sent_to && person.sent_to.channel === 'email'
            ? 'the email on this report' : 'the number on this report'}</strong>
          ${person.demo_code
            ? `This demonstration system cannot deliver it, so the code is shown here:
               <span class="ref">${esc(person.demo_code)}</span>`
            : `It went to ${esc(person.sent_to ? person.sent_to.to : 'you')}${
                person.sent_to && person.sent_to.channel === 'email' ? '' : ' by SMS'} and expires in 10 minutes.`}
        </div>
        ${error ? `<div class="notice notice-alert"><strong>That code did not match</strong>${esc(error)}</div>` : ''}
        <div class="field">
          <label for="linkOtp">Six-digit code <span class="req">*</span></label>
          <input type="text" id="linkOtp" inputmode="numeric" maxlength="6" placeholder="000000">
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="linkOtpGo">Show my report</button>
          <a class="btn" href="/track">Cancel</a>
        </div>
      </div>`;
    const go = document.getElementById('linkOtpGo');
    const input = document.getElementById('linkOtp');
    input.focus();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
    go.onclick = async () => {
      if (go.disabled) return;
      go.disabled = true;
      const res = await Store.fetchTrackLink(ref, token, { otp: input.value });
      go.disabled = false;
      if (!res.ok) {
        drawOtpStep(person, res.error || 'Check the code and try again.');
        return;
      }
      /* Verified. From here it is the ordinary tracking view, opened through
         the same Store.track() everything else uses. */
      document.getElementById('ref').value = prefillRef;
      document.getElementById('fullname').value = person.name;
      lookup.hidden = false;
      const found = Store.track(prefillRef, person.name);
      if (!found.ok) {
        host.innerHTML = '';
        document.getElementById('lookupError').innerHTML =
          '<div class="notice notice-alert"><strong>No report found</strong>Look it up below.</div>';
        return;
      }
      current = found;
      render(found);
    };
  }

  drawIdStep(null);
}

document.getElementById('find').onclick = doLookup;
document.getElementById('ref').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
document.getElementById('fullname').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });

async function doLookup() {
  /* Whatever goes wrong, the complainant must see something happen. An
     unhandled error here leaves the button looking dead, which reads as the
     system ignoring them. */
  try {
    await runLookup();
  } catch (e) {
    console.error(e);
    document.getElementById('result').hidden = true;
    document.getElementById('lookupError').innerHTML =
      `<div class="notice notice-alert"><strong>Something went wrong on this page</strong>
        Your report has not been lost. Reload the page and try again, or take your reference
        number to the station.</div>`;
  }
}

async function runLookup() {
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
    await Store.fetchTrack(isIdNumber
      ? { id_number: ref, name: fullname }
      : { complainant_number: ref, name: fullname });
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

  await Store.fetchTrack({ reference: ref, name: fullname });
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
    /* A docket opened in another browser: the report knows, but the docket
       itself (and its case number) is not on the server yet. */
    : i.disposition === 'docket_opened' ? 'Case opened'
    : i.disposition === 'withdrawn' ? 'Withdrawn'
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
  /* Every diagram ends with the complainant being told something. Those
     messages are recorded, so they belong on the complainant's own timeline
     rather than only in the audit log. */
  (Store.notifications(i.id) || []).forEach(n =>
    events.push({ at: n.created_at, text: n.message }));

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
      ${stampBlock(d ? 'Case number' : 'Report reference', ref, d || i.disposition === 'docket_opened' ? 'Registered' : 'Pending')}
      ${qrBlock(ref, 'Scan to track this case', i.track_token)}
    </div>
    <p class="no-print" style="margin:.6rem 0 0"><button type="button" class="btn btn-sm" id="printStatus">Print or save
      this as proof of your report</button></p>

    <div class="card" style="margin-top:1rem">
      <div class="card-head">
        <h2>${esc(Store.categoryName(i.category_id))}</h2>
        <span class="badge ${d ? 'badge-neutral' : 'badge-alert'}">${esc(status)}</span>
      </div>
      <p class="small muted">Reported ${esc(fmtDateTime(i.created_at))} · ${esc(Store.stationName(i.station_id))}
        ${i.urgent ? ' · <span class="badge badge-urgent">You flagged this as urgent</span>' : ''}</p>

      ${i.info_request ? (i.info_responded_at ? `<div class="notice notice-good">
          <strong>You answered the station's question</strong>
          <span class="small muted">They asked: </span>${esc(i.info_request)}
          <span class="small muted" style="display:block;margin-top:.3rem">You answered ${esc(fmtDateTime(i.info_responded_at))}: </span>${esc(i.info_response)}
        </div>` : `<div class="notice notice-alert no-print">
          <strong>The station needs more information from you</strong>
          ${esc(i.info_request)}
          <div class="field" style="margin-top:.7rem">
            <label for="infoAnswer">Your answer <span class="req">*</span></label>
            <textarea id="infoAnswer" style="min-height:90px" placeholder="Write what they asked for. You can also add photos or documents below."></textarea>
          </div>
          <button class="btn btn-primary btn-sm" id="sendInfo">Send my answer</button>
        </div>`) : ''}

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

    ${d && d.current_status === 'closed' ? `
    <div class="card" style="margin-top:1rem">
      <div class="card-head"><h3>Something new about this case?</h3></div>
      <p class="small muted">This case has been filed: ${esc(d.closure_type || '—')}. If something
      new has come to light — a witness, a document, property found — it can be reopened. New
      evidence or new information is what reopens it, not a change of mind.</p>
      <div class="field">
        <label for="reopenText">What is new? <span class="req">*</span></label>
        <textarea id="reopenText" style="min-height:80px" placeholder="Describe what has changed since the case was filed."></textarea>
      </div>
      <button class="btn btn-danger" id="requestReopen">Ask for this case to be reopened</button>
    </div>` : ''}

    ${renderWithdrawalCard(i)}`;

  host.hidden = false;

  const btn = document.getElementById('escalate');
  if (btn) btn.onclick = async () => {
    const reason = document.getElementById('escReason').value;
    if (!reason) { toast('Choose a reason so the commander knows what to look at.', 'alert'); return; }
    const detail = document.getElementById('escDetail').value.trim();
    const raised = await Store.raiseEscalation({
      docket_id: res.docket ? res.docket.id : null,
      intake_id: res.docket ? null : res.intake.id,
      reason: detail ? `${reason} — ${detail}` : reason,
      raised_by_complainant: true
    });
    if (!raised || raised.ok === false) return;
    toast('Escalation sent to the station commander.');
    render(Store.track(ref, document.getElementById('fullname').value.trim()));
  };

  const ibtn = document.getElementById('sendInfo');
  if (ibtn) ibtn.onclick = async () => {
    if (ibtn.disabled) return;
    ibtn.disabled = true;
    const out = await Store.respondInfo(i.id, document.getElementById('infoAnswer').value);
    ibtn.disabled = false;
    if (!out.ok) { toast(out.error, 'alert'); return; }
    toast('Your answer has been sent to the station.');
    render(Store.track(ref, document.getElementById('fullname').value.trim()));
  };

  const pbtn = document.getElementById('printStatus');
  if (pbtn) pbtn.onclick = () => window.print();

  const rbtn = document.getElementById('requestReopen');
  if (rbtn) rbtn.onclick = async () => {
    const res = await Store.requestReopenByComplainant(d.id, document.getElementById('reopenText').value);
    if (!res.ok) { toast(res.error, 'alert'); return; }
    toast('The case has been reopened and sent back for investigation.');
    render(Store.track(ref, document.getElementById('fullname').value.trim()));
  };

  const wbtn = document.getElementById('requestWithdrawal');
  if (wbtn) wbtn.onclick = async () => {
    const cat = document.getElementById('wCat').value;
    if (!cat) { toast('Choose a reason so the request can be reviewed.', 'alert'); return; }
    const detail = document.getElementById('wDetail').value.trim();
    const outcome = await Store.requestWithdrawal(i.id, { reason_category: cat, reason_detail: detail });
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
