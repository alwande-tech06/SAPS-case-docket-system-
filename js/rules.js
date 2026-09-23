/* ==========================================================================
   rules.js — what a screen may do yet, and what is still missing

   One place answers that question, for every action and every screen. The
   queue row asks it to draw a readiness badge, the button asks it to decide
   whether it is live, and the modal asks it to list what is outstanding. They
   cannot disagree, because it is the same answer.

   Every item carries the blocking `code` the data layer uses, so the guide
   link beside a blocked control points at the rule that is actually stopping
   it (see RULE_ANCHORS in store.js).
   ========================================================================== */

const Rules = {

  /* ----- the one entry point -----
     ctx: { intakeId } or { docketId } or { closureId }
     action: open_docket | refuse | transfer | request_closure |
             approve_closure | register_exhibit
     draft: what the user has filled in so far, where the action needs it. */
  checklist(ctx, action, draft = {}) {
    const items = (BUILDERS[action] || (() => []))(ctx, draft) || [];
    const blocking = items.filter(i => !i.ok && !i.informational);
    return {
      action,
      items,
      outstanding: blocking,
      canProceed: blocking.length === 0,
      /* the first thing standing in the way, which is what a link should
         explain and what a tooltip should say */
      blocker: blocking[0] || null
    };
  },

  /* ----- honest buttons -----
     A control that cannot succeed is disabled before it is pressed, says why
     on hover, and carries a link to the rule. Nobody should open a modal, fill
     it in and only then be told no. */
  gate(el, res, options = {}) {
    if (!el) return res;
    el.disabled = !res.canProceed;
    el.classList.toggle('is-blocked', !res.canProceed);
    el.title = res.canProceed
      ? (options.readyTitle || '')
      : res.outstanding.map(i => '• ' + i.label).join('\n');

    /* the "Why is this blocked?" link lives next to the button, and is removed
       again the moment the button becomes live */
    const holder = options.linkHost || el.parentNode;
    if (!holder) return res;
    let link = holder.querySelector(':scope > .why[data-gate]');
    if (res.canProceed) {
      if (link) link.remove();
      return res;
    }
    const href = typeof ruleHref === 'function' ? ruleHref(res.blocker.code) : null;
    if (!href) return res;
    if (!link) {
      link = document.createElement('a');
      link.className = 'why';
      link.dataset.gate = '1';
      link.target = '_blank';
      link.rel = 'noopener';
      holder.appendChild(link);
    }
    link.href = href;
    link.textContent = options.linkLabel || 'Why is this blocked?';
    return res;
  },

  /* ----- the badge on a queue row -----
     Three states, because that is what an official scanning a queue needs:
     what they can act on, what needs work, and what is with someone else. */
  readiness(intakeId) {
    const cosigning = Store.pendingRefusals().some(r => r.intake_id === Number(intakeId));
    if (cosigning) {
      return { state: 'cosign', label: 'Co-sign pending', cls: 'badge-brass',
               title: 'A decision not to open a docket is with the station commander.',
               res: this.checklist({ intakeId }, 'open_docket') };
    }
    const res = this.checklist({ intakeId }, 'open_docket');
    return res.canProceed
      ? { state: 'ready', label: 'Ready', cls: 'badge-good',
          title: 'Every intake requirement is met.', res }
      : { state: 'outstanding', label: res.outstanding.length + ' outstanding',
          cls: 'badge-alert',
          title: res.outstanding.map(i => '• ' + i.label).join('\n'), res };
  },

  badgeHtml(readiness) {
    return `<span class="badge ${readiness.cls}" title="${esc(readiness.title)}">${
      esc(readiness.label)}</span>`;
  },

  /* ----- the checklist, drawn -----
     Used inside a modal, where the requirements change with what was chosen,
     and in the side panel beside the queue. */
  render(host, ctx, action, draft = {}) {
    const res = this.checklist(ctx, action, draft);
    if (!host) return res;

    host.innerHTML = `
      <ul class="checklist">
        ${res.items.map(i => `
          <li class="${i.informational ? 'is-note' : (i.ok ? 'is-ok' : 'is-missing')}">
            <span class="mark">${i.informational ? '·' : (i.ok ? '✓' : '!')}</span>
            <span>
              <strong>${esc(i.label)}</strong>
              ${i.detail ? `<span class="small muted">${esc(i.detail)}</span>` : ''}
            </span>
          </li>`).join('')}
      </ul>
      ${res.canProceed ? '' : `<div class="notice notice-alert">
        <strong>${res.outstanding.length} outstanding</strong>
        This cannot be submitted yet.${
          typeof whyBlocked === 'function' ? whyBlocked(res.blocker.code) : ''}</div>`}`;
    return res;
  }
};

/* ==========================================================================
   The checks themselves, one builder per action.
   An item is { key, code, label, ok, detail, informational }.
   ========================================================================== */

/* Kept in step with MIN_REASON_LENGTH in store.js, which is what actually
   enforces it — this is only what the screen shows while typing. */
const MIN_REASON = 25;

function item(key, code, label, ok, detail, informational) {
  return { key, code, label, ok: !!ok, detail: detail || '', informational: !!informational };
}

const BUILDERS = {

  /* ---------------- opening a docket ---------------- */
  open_docket(ctx) {
    const intake = Store.intakes().find(i => i.id === Number(ctx.intakeId));
    if (!intake) return [item('found', 'intake_preconditions', 'Report not found', false)];
    const c = Store.complainant(intake.complainant_id) || {};
    const out = [];

    const nameOk = hasNameAndSurname(c.name);
    const idOk = /^\d{13}$/.test(String(c.id_number || ''));
    const contactOk = isValidSaMobile(c.contact);
    out.push(item('identity', 'intake_preconditions',
      'Complainant name, ID number and contact number',
      nameOk && idOk && contactOk,
      [nameOk ? '' : 'name and surname', idOk ? '' : '13-digit ID number',
       contactOk ? '' : 'valid mobile number'].filter(Boolean).join(', ') || 'On file'));

    out.push(item('otp', 'intake_preconditions', 'Contact number verified by OTP',
      !!c.verified_at, c.verified_at ? 'Verified ' + fmtDate(c.verified_at) : 'Not verified'));

    /* A sexual offence is deliberately not described online — that statement is
       taken in private — so the absence of one is not a gap here. */
    const isProtectedStatement = Number(intake.category_id) === 3;
    const statementOk = isProtectedStatement || !!(intake.incident_description || '').trim();
    out.push(item('statement', 'intake_preconditions',
      'Statement covering what, when, who, where, why and how',
      statementOk,
      isProtectedStatement ? 'Taken in person by a trained officer, not on the form'
        : (statementOk ? 'On file' : 'Nothing recorded')));

    const whenOk = !!intake.incident_datetime;
    const whereOk = !!(intake.incident_location || '').trim();
    out.push(item('when_where', 'intake_preconditions', 'Incident date, time and location',
      whenOk && whereOk,
      whenOk && whereOk ? fmtDateTime(intake.incident_datetime) + ' · ' + intake.incident_location
        : 'Incomplete'));

    const needsClass = Store.classificationNeeded(intake.id);
    out.push(item('category', 'intake_preconditions', 'Crime category selected',
      !needsClass,
      needsClass ? 'Reported as "Other" — you classify it when opening the docket'
        : Store.categoryName(intake.category_id)));

    const cosigning = Store.pendingRefusals().some(r => r.intake_id === intake.id);
    if (cosigning) {
      out.push(item('cosign', 'cosign', 'No decision is already with the commander', false,
        'A refusal on this report is waiting for the commander\'s signature'));
    }

    if (intake.disposition !== 'pending') {
      out.push(item('open', 'intake_preconditions', 'Report is still open', false,
        'Already ' + labelDisposition(intake.disposition)));
    }
    return out;
  },

  /* ---------------- proposing that no docket be opened ----------------
     The requirements change with the ground, which is the whole reason this
     is re-rendered when the dropdown changes. */
  refuse(ctx, draft) {
    const intake = Store.intakes().find(i => i.id === Number(ctx.intakeId));
    if (!intake) return [item('found', 'invalid_grounds', 'Report not found', false)];
    const ground = draft.reason_category || '';
    const allowed = Store.refusalReasonsFor(intake.id);
    const cat = Store.categories().find(c => c.id === intake.category_id);
    const out = [];

    out.push(item('ground', 'invalid_grounds', 'A valid ground is selected',
      !!ground && allowed.includes(ground),
      ground ? (allowed.includes(ground) ? ground : 'Not a ground available on this report')
             : 'Nothing selected yet'));

    if (cat && cat.protected_from_withdrawal) {
      out.push(item('protected', 'protected_categories',
        `${cat.name} — a verified duplicate is the only ground`,
        !ground || ground === allowed[0],
        'Additional duties apply to this category'));
    }

    const detail = (draft.reason_detail || '').trim();
    out.push(item('detail', /duplicate/i.test(ground) ? 'duplicate' : 'no_offence',
      'Full reasons recorded, in enough detail to be weighed',
      detail.length >= MIN_REASON,
      detail ? `${detail.length} of ${MIN_REASON} characters` : 'Nothing written yet'));

    if (/^No offence disclosed/.test(ground)) {
      const el = draft.missing_element;
      out.push(item('element', 'no_offence', 'The missing element is named',
        Store.missingElements().includes(el), el || 'Legality or conduct'));
      out.push(item('definition', 'no_offence', 'The crime definition consulted is recorded',
        !!(draft.definition_reference || '').trim(),
        (draft.definition_reference || '').trim() || 'Not recorded'));
    }

    if (ground === Store.refusalReasonsFor(intake.id).find(r => /duplicate/i.test(r))) {
      const ref = (draft.duplicate_of || '').trim();
      const resolves = ref && Store.referenceResolves(ref);
      out.push(item('duplicate_ref', 'duplicate', 'The existing case number is given',
        !!ref, ref || 'Not given'));
      out.push(item('duplicate_found', 'duplicate', 'That case number resolves to a real report',
        !!resolves, ref ? (resolves ? 'Found on the system' : 'No report found under that number') : '—'));
    }

    out.push(item('cosign', 'cosign', 'The station commander signs it off',
      true, 'Happens after you submit. The report stays open until then.', true));
    return out;
  },

  /* ---------------- wrong station ---------------- */
  transfer(ctx, draft) {
    const intake = Store.intakes().find(i => i.id === Number(ctx.intakeId));
    if (!intake) return [item('found', 'transfer', 'Report not found', false)];
    const to = Number(draft.to_station_id);
    return [
      item('station', 'transfer', 'A receiving station is chosen',
        !!to && to !== intake.station_id,
        to ? (to === intake.station_id ? 'That is this station' : Store.stationName(to))
           : 'Nothing selected yet'),
      item('reason', 'transfer', 'A reason for the transfer is recorded',
        !!(draft.reason || '').trim(), (draft.reason || '').trim() || 'Nothing written yet'),
      item('registered', 'transfer', 'A case number is issued here first', true,
        'The complainant is never sent to another station to report again', true)
    ];
  },

  /* ---------------- asking for a docket to be filed ---------------- */
  request_closure(ctx, draft) {
    const d = Store.docket(ctx.docketId);
    if (!d) return [item('found', 'closure_request', 'Case not found', false)];
    const out = [];

    out.push(item('status', 'closure_status', 'The docket has been investigated',
      d.current_status === 'under_investigation',
      d.current_status === 'under_investigation' ? 'Under investigation'
        : labelStatus(d.current_status) + ' — it cannot be filed from here'));

    const open = Store.instructions(d.id).filter(n => n.status === 'open');
    out.push(item('instructions', 'closure_diary', 'Every diary instruction is answered',
      open.length === 0,
      open.length ? open.length + ' still open' : 'None outstanding'));

    if (draft.category) {
      const blocker = Store.closureBlocker(d.id, draft.category, draft);
      out.push(item('category', blocker ? blocker.code : 'filing_categories',
        'This filing category can be used on this docket',
        !blocker, blocker ? blocker.message : 'Requirements met'));
    } else {
      out.push(item('category', 'filing_categories', 'A filing category is chosen', false,
        'Each one has its own requirement'));
    }

    out.push(item('motivation', 'closure_request', 'A motivation is written',
      !!(draft.motivation || '').trim(), (draft.motivation || '').trim() || 'Nothing written yet'));

    out.push(item('approval', 'approve_closure', 'The station commander approves it', true,
      'You are requesting, not deciding. It cannot be you who approves.', true));
    return out;
  },

  /* ---------------- the second signature on a no-docket decision ----------------
     Signing ends the report, so it carries the heavier requirements: the
     comparison against the definition has to be stated, not assumed. */
  cosign(ctx, draft) {
    const rec = Store.pendingRefusals().find(r => r.id === Number(ctx.refusalId));
    if (!rec) return [item('found', 'cosign', 'Decision not found', false)];
    const intake = Store.intakes().find(i => i.id === rec.intake_id);
    const signing = draft.decision === 'agree';
    const note = (draft.note || '').trim();
    const out = [];

    out.push(item('decision', 'cosign', 'A decision is chosen',
      draft.decision === 'agree' || draft.decision === 'reject',
      draft.decision ? (signing ? 'Sign off — no docket is opened'
                                : 'Do not sign — a docket is opened') : 'Nothing chosen yet'));

    out.push(item('note', 'cosign',
      signing ? 'Why the facts disclose no offence' : 'Why a docket must be opened',
      note.length >= MIN_REASON,
      note ? `${note.length} of ${MIN_REASON} characters` : 'Nothing written yet'));

    if (signing) {
      out.push(item('definition', 'no_offence',
        `Compared against the definition of ${intake ? Store.categoryName(intake.category_id).toLowerCase() : 'the crime'}`,
        !!draft.definition_checked,
        'You are stating that no element of that definition is present'));
    }

    out.push(item('separation', 'separation', 'You are not the official who proposed it',
      rec.officer_id !== (ctx.actorId || null),
      'Proposed by ' + Store.userName(rec.officer_id)));

    return out;
  },

  /* ---------------- the commander's inspection ---------------- */
  approve_closure(ctx) {
    const check = Store.closureChecklist(ctx.closureId, ctx.approverId);
    if (!check) return [item('found', 'approve_closure', 'Closure request not found', false)];
    return check.items.map(i =>
      item(i.key, i.code, i.label, i.ok, i.detail, i.informational));
  },

  /* ---------------- registering an exhibit ---------------- */
  register_exhibit(ctx, draft) {
    const d = Store.docket(ctx.docketId);
    if (!d) return [item('found', 'exhibit', 'Case not found', false)];
    const suspectOnCase = Store.arrests(d.id).length > 0;
    const trio = [draft.suspect_name, draft.suspect_id_number, draft.suspect_photo_data_url];
    const started = trio.some(Boolean);
    return [
      item('description', 'exhibit', 'The exhibit is described',
        !!(draft.description || '').trim()),
      item('photo', 'exhibit', 'A photograph, or a scan for a document',
        !!draft.image_data_url),
      item('storage', 'exhibit', 'Storage location', !!(draft.storage_location || '').trim()),
      item('saps13', 'exhibit', 'SAPS 13 register number', !!(draft.saps13_number || '').trim()),
      item('suspect', 'exhibit',
        suspectOnCase ? 'Linked to the suspect or the charge on this case'
                      : 'Suspect link, if you are making one, is complete',
        suspectOnCase
          ? !!(draft.suspect_id_number || draft.linked_arrest_id)
          : (!started || trio.every(Boolean)),
        suspectOnCase ? 'This case has a recorded suspect'
                      : 'Name, ID number and photograph are required together')
    ];
  }
};
