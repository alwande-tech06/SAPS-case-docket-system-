/* report.js — public reporting flow (no account required) */

renderPublicHeader();

let otpCode = null;

/* categories */
const catSel = document.getElementById('category');
Store.categories().forEach(c => {
  const o = document.createElement('option');
  o.value = c.id; o.textContent = c.name;
  catSel.appendChild(o);
});

/* default date to today */
document.getElementById('idate').value = new Date().toISOString().slice(0, 10);

function show(step) {
  [1, 2, 3].forEach(n => {
    document.getElementById('step' + n).hidden = n !== step;
    const s = document.getElementById('s' + n);
    s.className = 'step' + (n === step ? ' is-active' : n < step ? ' is-done' : '');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('toStep2').onclick = () => {
  const missing = [];
  if (!catSel.value) missing.push('type of incident');
  if (!document.getElementById('idate').value) missing.push('date');
  if (!document.getElementById('location').value.trim()) missing.push('location');
  if (!document.getElementById('description').value.trim()) missing.push('description');
  if (missing.length) { toast('Still needed: ' + missing.join(', '), 'alert'); return; }
  show(2);
};

document.getElementById('backTo1').onclick = () => show(1);

document.getElementById('sendOtp').onclick = () => {
  const name = document.getElementById('name').value.trim();
  const contact = document.getElementById('contact').value.trim();
  if (!name) { toast('Enter your name so the station knows who reported this.', 'alert'); return; }
  if (contact.replace(/\D/g, '').length < 9) { toast('Enter a mobile number we can reach you on.', 'alert'); return; }

  otpCode = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById('otpShown').textContent = otpCode;
  document.getElementById('otpBox').hidden = false;
  document.getElementById('sendOtp').textContent = 'Resend code';
  document.getElementById('submitReport').hidden = false;
  document.getElementById('otp').focus();
};

document.getElementById('submitReport').onclick = () => {
  if (document.getElementById('otp').value.trim() !== otpCode) {
    toast('That code does not match the one we sent.', 'alert');
    return;
  }

  const d = document.getElementById('idate').value;
  const t = document.getElementById('itime').value || '00:00';

  const rec = Store.submitReport({
    name: document.getElementById('name').value.trim(),
    contact: document.getElementById('contact').value.trim(),
    category_id: catSel.value,
    station_id: 1,
    channel: 'public_web',
    description: document.getElementById('description').value.trim(),
    location: document.getElementById('location').value.trim(),
    incident_datetime: new Date(d + 'T' + t).toISOString()
  });

  document.getElementById('stampHost').innerHTML =
    stampBlock('Your reference number', rec.intake_number, 'Received') +
    qrBlock(rec.intake_number, 'Scan to reopen this report');
  document.getElementById('rSubmitted').textContent = fmtDateTime(rec.created_at);
  document.getElementById('rStation').textContent = Store.stationName(rec.station_id);
  document.getElementById('rStatus').innerHTML =
    '<span class="badge badge-alert">Awaiting police action</span>';

  show(3);
  toast('Report submitted. Keep your reference number.');
};
