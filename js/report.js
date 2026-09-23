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

/* ---------------- category-specific questions ----------------
   The extra questions exist so that an official can test the elements of the
   offence against what the complainant actually said, rather than inferring
   them. They are rendered from the category specification in store.js, so the
   form and the data layer cannot drift apart. */
const catFieldHost = document.getElementById('catFields');
const descHint = document.getElementById('descHint');
const descBox = document.getElementById('description');

catSel.onchange = renderCategoryFields;

function renderCategoryFields() {
  const id = Number(catSel.value);
  const fields = catSel.value ? Store.categoryFields(id) : [];
  const cat = Store.categories().find(c => c.id === id);

  renderGuideSection(cat ? cat.name : null);

  const intro = specialIntro(id, cat);
  catFieldHost.innerHTML = (intro || '') + (fields.length ? `
    <h3 style="font-size:.95rem;margin-top:1.3rem">About this ${esc((cat.name || '').toLowerCase())}</h3>
    ${fields.map(f => fieldHtml(f)).join('')}` : '');

  /* A sexual offence is not described on a web form. The statement is taken in
     private by a trained officer, so the free-text box stops being required
     and stops asking for the story. */
  if (id === 3) {
    descBox.placeholder = 'You do not have to describe what happened here. If you want to add anything, you may — but nothing is required.';
    descHint.innerHTML = '<strong>You do not need to write what happened.</strong> A trained officer will take your statement in private. Nothing you leave blank here counts against your case.';
    descBox.style.minHeight = '90px';
  } else if (id === 11) {
    descBox.placeholder = 'Describe what happened in your own words. An official will decide which crime this is.';
    descHint.innerHTML = 'Because you chose <strong>Other</strong>, no category is assumed. An official reads this and classifies it — that is a decision recorded against their name.';
    descBox.style.minHeight = '150px';
  } else {
    descBox.placeholder = 'What happened, when, who was involved, where it happened, why you think it happened, and how.';
    descHint.innerHTML = 'Cover the <strong>what, when, who, where, why and how</strong> — this is what the sworn statement has to cover, so writing it now means you are not starting from nothing at the station. Use your own words; nothing here has to sound official.';
    descBox.style.minHeight = '150px';
  }
}

/* ---------------- the guide, inline ----------------
   The advice for this crime is most use at the moment the category is chosen,
   so that section of the guide is shown right under the dropdown, collapsed.
   It is read out of what-happens-next.html rather than copied here, so there is one
   source for it and the two cannot drift apart. */
const guideHost = document.getElementById('guideForCategory');
let guidePromise = null;

function guideSections() {
  if (guidePromise) return guidePromise;

  /* Resolves to null rather than rejecting whenever the guide cannot be read —
     opened from a file:// path, offline, or an environment without fetch. The
     caller then shows a plain link, which still works. */
  guidePromise = new Promise(resolve => {
    const parse = html => {
      try { resolve(new DOMParser().parseFromString(html, 'text/html')); }
      catch (e) { resolve(null); }
    };

    try {
      if (typeof fetch === 'function') {
        fetch('what-happens-next.html')
          .then(r => (r.ok ? r.text().then(parse) : resolve(null)))
          .catch(() => resolve(null));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'what-happens-next.html');
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? parse(xhr.responseText) : resolve(null));
      xhr.onerror = () => resolve(null);
      xhr.send();
    } catch (e) {
      resolve(null);
    }
  });
  return guidePromise;
}

function renderGuideLink(categoryName) {
  guideHost.innerHTML = `<p class="small guide-more" style="margin:-.2rem 0 1.1rem">
    <a href="what-happens-next.html">What happens after you report${categoryName ? ' — the full guide' : ''}</a>
  </p>`;
}

function renderGuideSection(categoryName) {
  if (!categoryName) { guideHost.innerHTML = ''; return; }

  guideSections().then(doc => {
    /* No section for this crime, or the guide could not be loaded: fall back
       to the plain link rather than showing nothing. */
    const section = doc && doc.querySelector(`details[data-category="${cssEscape(categoryName)}"]`);
    if (!section) { renderGuideLink(categoryName); return; }

    const heading = section.querySelector('summary');
    const body = section.querySelector('.body');
    guideHost.innerHTML = `
      <details class="guide-inline">
        <summary>What happens with a report of ${esc((heading ? heading.textContent : categoryName).toLowerCase())}</summary>
        <div class="guide-body">
          ${body ? body.innerHTML : ''}
          <p class="guide-more"><a href="what-happens-next.html">Read the full guide</a> — the process, what is
          expected of you, the possible outcomes, and your rights.</p>
        </div>
      </details>`;
  });
}

/* Attribute selectors choke on quotes and the em dash in a category name. */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/* Drawn once everything it needs exists: the field host, the guide host and
   the helpers below are all declared by this point. */
renderCategoryFields();

/* Warnings that belong at the top of the form, before anything is typed. */
function specialIntro(id) {
  if (id === 3) {
    return `<div class="notice notice-alert" style="margin-top:.9rem">
      <strong>Go to a police station or a Thuthuzela Care Centre now</strong>
      Do not wait for this report to be processed. Go to the nearest station or Thuthuzela Care
      Centre, where a trained officer will take your statement in private and you can be examined
      by a doctor. If you can, do not wash or change your clothes first — that evidence cannot be
      recovered afterwards. If you are in danger right now, call <span class="ref">10111</span>.
      <br><br>This form asks you almost nothing about what happened, on purpose.
    </div>`;
  }
  if (id === 4) {
    return `<div class="notice notice-alert" style="margin-top:.9rem">
      <strong>If you are in immediate danger, call 10111 first</strong>
      A protection order can be applied for at any magistrate's court, and the clerk of the court
      will help you complete the form. You do not need a lawyer and it costs nothing. Reporting
      here and applying for a protection order are separate things — you can do both.
    </div>`;
  }
  return '';
}

function fieldHtml(f) {
  const req = f.required ? ' <span class="req">*</span>' : '';
  const hint = f.hint ? `<p class="hint">${esc(f.hint)}</p>` : '';
  const id = 'cf_' + f.key;
  if (f.type === 'textarea') {
    return `<div class="field"><label for="${id}">${esc(f.label)}${req}</label>
      <textarea id="${id}" data-cf="${esc(f.key)}"${f.required ? ' data-required="1"' : ''}></textarea>${hint}</div>`;
  }
  if (f.type === 'select') {
    return `<div class="field"><label for="${id}">${esc(f.label)}${req}</label>
      <select id="${id}" data-cf="${esc(f.key)}"${f.required ? ' data-required="1"' : ''}>
        <option value="">Select an answer</option>
        ${(f.options || []).map(o => `<option>${esc(o)}</option>`).join('')}
      </select>${hint}</div>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}${req}</label>
    <input type="text" id="${id}" data-cf="${esc(f.key)}"${f.required ? ' data-required="1"' : ''}>${hint}</div>`;
}

/* ---------------- suspect and witnesses ---------------- */
const suspectSel = document.getElementById('suspectKnown');
suspectSel.onchange = () => {
  document.getElementById('suspectBox').hidden = suspectSel.value !== 'yes';
};

const witnessSel = document.getElementById('witnessKnown');
const witnessList = document.getElementById('witnessList');
witnessSel.onchange = () => {
  const on = witnessSel.value === 'yes';
  document.getElementById('witnessBox').hidden = !on;
  if (on && !witnessList.children.length) addWitnessRow();
};
document.getElementById('addWitnessRow').onclick = () => addWitnessRow();

function addWitnessRow() {
  const row = document.createElement('div');
  row.className = 'row row-2';
  row.innerHTML = `
    <div class="field"><label>Witness name</label>
      <input type="text" data-wname placeholder="Name and surname"></div>
    <div class="field"><label>Contact number, if known</label>
      <input type="text" data-wcontact placeholder="e.g. 082 555 0141"></div>`;
  witnessList.appendChild(row);
}

function collectCategoryDetails() {
  const out = {};
  catFieldHost.querySelectorAll('[data-cf]').forEach(el => {
    const v = el.value.trim();
    if (v) out[el.dataset.cf] = v;
  });
  return out;
}

function missingCategoryFields() {
  const missing = [];
  catFieldHost.querySelectorAll('[data-required="1"]').forEach(el => {
    if (!el.value.trim()) {
      const label = el.closest('.field').querySelector('label');
      missing.push(label ? label.textContent.replace('*', '').trim().toLowerCase() : el.dataset.cf);
    }
  });
  return missing;
}

function collectWitnesses() {
  if (witnessSel.value !== 'yes') return [];
  return [...witnessList.querySelectorAll('.row')].map(r => ({
    name: r.querySelector('[data-wname]').value,
    contact: r.querySelector('[data-wcontact]').value
  })).filter(w => w.name.trim());
}

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
  /* A sexual offence is the one category where the description is not
     required — that statement is taken in private, not typed here. */
  if (Number(catSel.value) !== 3 && !document.getElementById('description').value.trim()) {
    missing.push('description');
  }
  missing.push(...missingCategoryFields());
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
    incident_datetime: new Date(d + 'T' + t).toISOString(),
    details: collectCategoryDetails(),
    suspect: suspectSel.value === 'yes' ? {
      name: document.getElementById('suspectName').value,
      description: document.getElementById('suspectDesc').value,
      contact: document.getElementById('suspectContact').value
    } : null,
    witnesses: collectWitnesses()
  });

  if (converted.attachments.length) Store.addComplainantEvidence(rec.id, converted.attachments, '');

  document.getElementById('stampHost').innerHTML =
    stampBlock('Your reference number', rec.intake_number, 'Received') +
    qrBlock(rec.intake_number, 'Scan to track this report', rec.track_token);
  document.getElementById('rComplainant').textContent = Store.complainant(rec.complainant_id).complainant_number;
  document.getElementById('rSubmitted').textContent = fmtDateTime(rec.created_at);
  document.getElementById('rStation').textContent = Store.stationName(rec.station_id);
  document.getElementById('rStatus').innerHTML =
    '<span class="badge badge-alert">Awaiting police action</span>';

  /* The medical-evidence advice is shown only where it applies, so it does not
     become noise that people learn to scroll past. */
  const cid = Number(catSel.value);
  document.getElementById('medicalAdvice').hidden = ![2, 3, 4, 9].includes(cid);

  show(3);
  toast('Report submitted. Keep your reference number.');
};
