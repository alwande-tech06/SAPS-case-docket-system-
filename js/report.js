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
  const idNumber = document.getElementById('idnum').value.trim();
  if (!hasNameAndSurname(name)) { toast('Enter both your first name and surname.', 'alert'); return; }
  if (!document.querySelector('input[name="gender"]:checked')) { toast('Select your gender.', 'alert'); return; }
  if (!isValidSaMobile(contact)) { toast('Enter a valid South African mobile number, e.g. 082 555 0141.', 'alert'); return; }
  if (!/^\d{13}$/.test(idNumber)) { toast('Enter your 13-digit South African ID number.', 'alert'); return; }

  const age = ageFromSaId(idNumber);
  if (age === null) {
    toast('That ID number is not valid — the first six digits must be a real date of birth.', 'alert'); return;
  }
  if (age < 18) {
    toast('You must be 18 or older to report online. An adult can report on your behalf, or you can report at any police station.', 'alert');
    return;
  }

  otpCode = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById('otpShown').textContent = otpCode;
  document.getElementById('otpBox').hidden = false;
  document.getElementById('sendOtp').textContent = 'Resend code';
  document.getElementById('submitReport').hidden = false;
  document.getElementById('otp').focus();
};

document.getElementById('submitReport').onclick = async () => {
  if (document.getElementById('otp').value.trim() !== otpCode) {
    toast('That code does not match the one we sent.', 'alert');
    return;
  }

  const fileInput = document.getElementById('files');
  const converted = await filesToAttachments(fileInput.files);
  if (!converted.ok) { toast(converted.error, 'alert'); return; }

  const d = document.getElementById('idate').value;
  const t = document.getElementById('itime').value || '00:00';

  const genderChoice = document.querySelector('input[name="gender"]:checked');

  const rec = Store.submitReport({
    name: document.getElementById('name').value.trim(),
    contact: document.getElementById('contact').value.trim(),
    id_number: document.getElementById('idnum').value.trim(),
    gender: genderChoice ? genderChoice.value : null,
    category_id: catSel.value,
    channel: 'public_web',
    description: document.getElementById('description').value.trim(),
    location: document.getElementById('location').value.trim(),
    incident_datetime: new Date(d + 'T' + t).toISOString()
  });

  if (converted.attachments.length) Store.addComplainantEvidence(rec.id, converted.attachments, '');

  document.getElementById('stampHost').innerHTML =
    stampBlock('Your reference number', rec.intake_number, 'Received') +
    qrBlock(rec.intake_number, 'Scan to reopen this report');
  document.getElementById('rComplainant').textContent = Store.complainant(rec.complainant_id).complainant_number;
  document.getElementById('rSubmitted').textContent = fmtDateTime(rec.created_at);
  document.getElementById('rStation').textContent = Store.stationName(rec.station_id);
  document.getElementById('rStatus').innerHTML =
    '<span class="badge badge-alert">Awaiting police action</span>';

  show(3);
  toast('Report submitted. Keep your reference number.');
};
