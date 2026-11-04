import {
  api as rawApi, esc, $, fmtRange, fmtDate, fmtDateTime, fmtStamp, fmtLongDate, fmtTime,
  setTimezone, copy, storage, toast,
} from './common.js';

const session = storage('session');
const TOKEN = 'bp.admin';

const state = {
  token: session.get(TOKEN),
  tab: 'sessions',
  settings: null,
  sessions: [],
  currentId: null,
  detail: null,
  ticks: new Set(),
  dirty: false,
  editing: null, // null | {id|null, ...form values}
  people: null,
  peopleFilter: '',
  email: { kind: 'invite', filter: 'unsent', subject: '', body: '', key: '' },
  error: null,
};

async function api(path, opts = {}) {
  try {
    return await rawApi(path, { ...opts, token: state.token });
  } catch (e) {
    if (e.status === 401 && path !== '/api/admin/login') {
      state.token = null;
      session.remove(TOKEN);
      render();
    }
    throw e;
  }
}

// Wrap an async action: show errors, re-render after.
async function run(fn) {
  state.error = null;
  try {
    await fn();
  } catch (e) {
    state.error = e.message;
  }
  render();
}

// ------------------------------------------------------------ date helpers (browser-local = club time)

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');
const addDays = (iso, n) => {
  const d = new Date(iso);
  d.setDate(d.getDate() + n); // local calendar days, DST-safe
  return d.toISOString();
};
function prevBusinessDay(iso) {
  const d = new Date(iso);
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString();
}

// ------------------------------------------------------------ loading

async function loadAll() {
  const [settings, sessions] = await Promise.all([api('/api/admin/settings'), api('/api/admin/sessions')]);
  state.settings = settings;
  state.sessions = sessions;
  setTimezone(settings.timezone);
  if (!state.currentId && sessions.length) {
    // Default to the next upcoming session, else the most recent.
    const upcoming = sessions.filter((s) => Date.parse(s.ends_at) > Date.now());
    state.currentId = (upcoming.at(-1) || sessions[0]).id;
  }
  if (state.currentId) await loadDetail(state.currentId);
}

async function loadSessions() {
  state.sessions = await api('/api/admin/sessions');
}

function setDetail(d, keepTicks = false) {
  const changedSession = state.detail?.session.id !== d.session.id;
  state.detail = d;
  const ids = new Set(d.active.map((r) => r.id));
  if (keepTicks && state.dirty && !changedSession) {
    state.ticks = new Set([...state.ticks].filter((id) => ids.has(id)));
  } else {
    state.ticks = new Set(d.active.filter((r) => r.selected).map((r) => r.id));
    state.dirty = false;
  }
  if (changedSession) state.email.key = '';
}

async function loadDetail(id) {
  state.currentId = id;
  setDetail(await api(`/api/admin/sessions/${id}`));
}

// ------------------------------------------------------------ templates & email helpers

function fill(tpl, s) {
  const cfg = state.settings;
  const vars = {
    club: cfg.club_name,
    title: s.title,
    date: fmtLongDate(s.starts_at),
    time: `${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}`,
    location: s.location || 'TBC',
    fee: s.fee || 'TBC',
    payment_details: cfg.payment_details,
    organiser: cfg.organiser_name,
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Owes the fee: attended, or flagged invalid (late dropout without a valid reason / no-show).
const owesFee = (r) => !!r.invalid || (!!r.selected && !r.withdrawn_at && r.attended === 1);

function recipients() {
  const d = state.detail;
  const { kind, filter } = state.email;
  if (kind === 'invite') return d.active.filter((r) => r.selected && !(filter === 'unsent' && r.invited_at));
  if (kind === 'waitlist') return d.active.filter((r) => !r.selected);
  return [...d.active, ...d.withdrawn].filter(
    (r) => owesFee(r) && !(filter === 'unsent' && r.payment_requested_at) && !(filter === 'unpaid' && r.paid_at)
  );
}

function ensureDraft() {
  const s = state.detail.session;
  const key = `${s.id}:${state.email.kind}`;
  if (state.email.key === key) return;
  const cfg = state.settings;
  const k = state.email.kind;
  state.email.subject = fill(cfg[`${k}_subject`], s);
  state.email.body = fill(cfg[`${k}_body`], s);
  state.email.key = key;
}

const icsEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function icsFold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 73) {
      out.push(cur);
      cur = ' ' + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

function buildIcs(s, people) {
  const cfg = state.settings;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//badminton-signup//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cfg.organiser_email ? 'REQUEST' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:session-${s.id}-${icsDate(s.created_at)}@badminton-signup`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(s.starts_at)}`,
    `DTEND:${icsDate(s.ends_at)}`,
    `SUMMARY:${icsEscape(`${cfg.club_name}: ${s.title}`)}`,
    `LOCATION:${icsEscape(s.location)}`,
    `DESCRIPTION:${icsEscape(state.email.body)}`,
  ];
  if (cfg.organiser_email)
    lines.push(`ORGANIZER;CN=${icsEscape(cfg.organiser_name || cfg.organiser_email)}:mailto:${cfg.organiser_email}`);
  for (const p of people)
    lines.push(`ATTENDEE;CN=${icsEscape(p.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${p.email}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------ CSV

// Spreadsheet-friendly local time, e.g. "2026-11-07 19:00:00".
const csvTime = (iso) =>
  iso ? new Intl.DateTimeFormat('sv-SE', { timeZone: state.settings.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '';

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running attendee-entered text as formulas
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(filename, rows) {
  if (!rows.length) return toast('Nothing to export');
  const head = Object.keys(rows[0]);
  const lines = rows.map((r) => head.map((k) => csvCell(r[k])).join(','));
  // BOM so Excel opens it as UTF-8.
  download(filename, '﻿' + [head.join(','), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
}

function outcome(r, confirmed) {
  if (r.withdrawn_at) return { normal: 'dropped out', reason: 'dropped out late (reason given)', admin: 'removed by organiser' }[r.withdraw_kind] || 'dropped out';
  if (!confirmed) return 'registered (list not confirmed)';
  return r.selected ? 'played' : 'waitlisted';
}

const yn = (v) => (v === null || v === undefined ? '' : v ? 'yes' : 'no');

const historyRow = (r) => ({
  session_date: csvTime(r.session_start),
  session_title: r.session_title,
  location: r.location,
  fee: r.fee,
  name: r.name,
  email: r.email,
  registered_at: csvTime(r.registered_at),
  outcome: outcome(r, !!r.list_confirmed_at),
  added_by_organiser: yn(r.admin_added),
  dropped_out_at: csvTime(r.withdrawn_at),
  dropout_reason: r.withdraw_reason || '',
  attended: yn(r.attended),
  invalid: yn(r.invalid),
  invite_sent_at: csvTime(r.invited_at),
  payment_email_sent_at: csvTime(r.payment_requested_at),
  paid_at: csvTime(r.paid_at),
  note: r.note,
});

function mailtoUrl(emails) {
  const cfg = state.settings;
  const q = [`bcc=${encodeURIComponent(emails.join(','))}`, `subject=${encodeURIComponent(state.email.subject)}`, `body=${encodeURIComponent(state.email.body)}`];
  return `mailto:${encodeURIComponent(cfg.organiser_email || '')}?${q.join('&')}`;
}

function outlookUrl(s, emails) {
  const q = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: `${state.settings.club_name}: ${s.title}`,
    startdt: s.starts_at.replace(/\.\d{3}Z$/, 'Z'),
    enddt: s.ends_at.replace(/\.\d{3}Z$/, 'Z'),
    location: s.location || '',
    body: state.email.body,
    to: emails.join(','),
  });
  return `https://outlook.office.com/calendar/deeplink/compose?${q}`;
}

function googleUrl(s, emails) {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${state.settings.club_name}: ${s.title}`,
    dates: `${icsDate(s.starts_at)}/${icsDate(s.ends_at)}`,
    location: s.location || '',
    details: state.email.body,
    add: emails.join(','),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

// ------------------------------------------------------------ views

function viewLogin() {
  return `
    <section class="card" style="max-width:360px;margin:15vh auto 0">
      <h1>Organiser sign in</h1>
      <form id="login" class="stack" style="margin-top:12px">
        <div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus></div>
        ${state.error ? `<div class="notice bad">${esc(state.error)}</div>` : ''}
        <button class="primary" type="submit">Sign in</button>
      </form>
    </section>`;
}

function viewShell(inner) {
  const tzWarn =
    state.settings && Intl.DateTimeFormat().resolvedOptions().timeZone !== state.settings.timezone
      ? `<div class="notice warn" style="margin-bottom:12px">Your computer's timezone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}) differs from the club's (${esc(state.settings.timezone)}). Times you type are in your computer's timezone.</div>`
      : '';
  return `
    <div class="row spread">
      <h1>${esc(state.settings?.club_name || 'Badminton')} · organiser</h1>
      <div class="row"><a class="btn small" href="./" target="_blank" rel="noopener">Public page ↗</a><button class="small" data-act="logout">Sign out</button></div>
    </div>
    <nav class="tabs">
      ${['sessions', 'people', 'settings'].map((t) => `<button data-tab="${t}" class="${state.tab === t ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </nav>
    ${tzWarn}
    ${state.error ? `<div class="notice bad" style="margin-bottom:12px">${esc(state.error)}</div>` : ''}
    ${inner}`;
}

function viewSessions() {
  const list = state.sessions
    .map((s) => {
      const pill = s.finalised_at ? '<span class="pill ok">confirmed</span>' : Date.parse(s.ends_at) < Date.now() ? '<span class="pill">past</span>' : '';
      return `<button data-session="${s.id}" class="${s.id === state.currentId && !state.editing ? 'active' : ''}">
        <div class="row spread"><strong>${esc(fmtDate(s.starts_at))}</strong>${pill}</div>
        <div class="small muted">${esc(s.title)} · ${s.count}/${s.capacity}</div></button>`;
    })
    .join('');
  let right = '';
  if (state.editing) right = viewSessionForm();
  else if (state.detail) right = viewDetail();
  else right = `<div class="card muted">No sessions yet. Create one to get started.</div>`;
  return `
    <div class="layout">
      <div class="list">
        <button class="primary" data-act="new-session" style="text-align:center">+ New session</button>
        ${list}
      </div>
      <div>${right}</div>
    </div>`;
}

function viewSessionForm() {
  const e = state.editing;
  return `
    <form id="session-form" class="card stack">
      <h2>${e.id ? 'Edit session' : 'New session'}</h2>
      <div class="fields">
        <div><label>Title</label><input name="title" value="${esc(e.title)}" required maxlength="120"></div>
        <div><label>Location</label><input name="location" value="${esc(e.location)}" maxlength="200"></div>
      </div>
      <div class="fields">
        <div><label>Starts</label><input type="datetime-local" name="starts_at" value="${esc(e.starts_at)}" required></div>
        <div><label>Ends</label><input type="datetime-local" name="ends_at" value="${esc(e.ends_at)}" required></div>
      </div>
      <div class="fields">
        <div><label>Registration opens</label><input type="datetime-local" name="opens_at" value="${esc(e.opens_at)}" required></div>
        <div><label>Free drop-out until <span class="muted">(default: 1 business day before)</span></label>
          <input type="datetime-local" name="dropout_deadline" value="${esc(e.dropout_deadline)}" required></div>
      </div>
      <div class="fields">
        <div><label>Capacity</label><input type="number" name="capacity" min="1" max="500" value="${esc(e.capacity)}" required></div>
        <div><label>Fee per person</label><input name="fee" value="${esc(e.fee)}" placeholder="e.g. $12" maxlength="50"></div>
      </div>
      <div><label>Public notes</label><textarea name="notes" maxlength="1000" placeholder="Shown on the signup page">${esc(e.notes)}</textarea></div>
      <div class="row">
        <button class="primary" type="submit">${e.id ? 'Save' : 'Create session'}</button>
        <button type="button" data-act="cancel-edit">Cancel</button>
      </div>
    </form>`;
}

function annotations(r) {
  const st = r.stats;
  const a = [];
  if (r.admin_added) a.push('<span class="pill">added by organiser</span>');
  if (st.miss_streak) a.push(`<span class="pill warn" title="Consecutive times on the waitlist since last playing">missed ×${st.miss_streak}</span>`);
  if (st.invalid_total) a.push(`<span class="pill bad" title="Invalid dropouts / no-shows (recent ${st.invalid_recent})">invalid ×${st.invalid_total}</span>`);
  if (st.no_shows) a.push(`<span class="pill bad">no-show ×${st.no_shows}</span>`);
  if (st.unpaid) a.push(`<span class="pill bad" title="Past sessions with a fee owing and not marked paid">unpaid ×${st.unpaid}</span>`);
  if (st.excused) a.push(`<span class="pill" title="Late dropouts with a reason">excused ×${st.excused}</span>`);
  if (!st.played && !st.waitlisted) a.push('<span class="pill ok">new</span>');
  if (r.invited_at) a.push(`<span class="pill ok" title="Invite marked sent ${esc(fmtStamp(r.invited_at))}">invited</span>`);
  if (r.payment_requested_at) a.push(`<span class="pill ok" title="Payment email marked sent ${esc(fmtStamp(r.payment_requested_at))}">pay req.</span>`);
  return a.join(' ');
}

function priorityTitle(r) {
  const cfg = state.settings;
  const st = r.stats;
  return [
    `missed streak ${st.miss_streak} × ${cfg.weight_miss}`,
    `invalid (last ${cfg.penalty_days}d) ${st.invalid_recent} × −${cfg.weight_invalid}`,
    `played (last ${cfg.recent_days}d) ${st.recent_played} × −${cfg.weight_recent}`,
    `manual adjust ${r.priority_adjust}`,
    `played total ${st.played}, waitlisted total ${st.waitlisted}`,
  ].join('\n');
}

function viewDetail() {
  const { session: s, active, withdrawn } = state.detail;
  const ticked = state.ticks.size;
  const lateDrops = withdrawn.filter((r) => r.withdraw_kind === 'reason');

  const rows = active
    .map((r) => {
      const cut = r.rank === s.capacity && active.length > s.capacity;
      return `<tr class="${cut ? 'cut' : ''}">
        <td><input type="checkbox" data-tick="${r.id}" ${state.ticks.has(r.id) ? 'checked' : ''} aria-label="Tick ${esc(r.name)}"></td>
        <td class="num">${r.rank}</td>
        <td><strong>${esc(r.name)}</strong> <span class="small muted">${esc(r.email)}</span><div style="margin-top:2px">${annotations(r)}</div>
          ${r.person_notes ? `<div class="small muted">📝 ${esc(r.person_notes)}</div>` : ''}</td>
        <td class="small">${esc(fmtStamp(r.registered_at))}</td>
        <td class="num" title="${esc(priorityTitle(r))}">${r.priority}</td>
        <td><input type="checkbox" data-attended="${r.id}" ${r.attended === 1 ? 'checked' : ''} ${r.selected ? '' : 'disabled'} aria-label="Attended"></td>
        <td><input type="checkbox" data-invalid="${r.id}" ${r.invalid ? 'checked' : ''} aria-label="Invalid / no-show" title="Flag as invalid dropout / no-show (lowers priority, owes fee)"></td>
        <td><input type="checkbox" data-paid="${r.id}" ${r.paid_at ? 'checked' : ''} aria-label="Paid" title="${r.paid_at ? esc('Paid ' + fmtStamp(r.paid_at)) : 'Mark as paid'}"></td>
        <td><input type="text" data-note="${r.id}" value="${esc(r.note)}" placeholder="note"></td>
        <td><button class="small" data-withdraw="${r.id}">Remove</button></td>
      </tr>`;
    })
    .join('');

  const wRows = withdrawn
    .map((r) => {
      const kind = { normal: '<span class="pill">free drop-out</span>', reason: '<span class="pill warn">late, with reason</span>', admin: '<span class="pill">removed by organiser</span>' }[r.withdraw_kind] || '';
      return `<tr class="${r.invalid ? '' : 'out'}">
        <td><strong>${esc(r.name)}</strong> <span class="small muted">${esc(r.email)}</span>${r.selected ? ' <span class="pill bad">was ticked</span>' : ''}</td>
        <td class="small">${esc(fmtStamp(r.withdrawn_at))}</td>
        <td>${kind}${r.withdraw_reason ? `<div class="small">“${esc(r.withdraw_reason)}”</div>` : ''}</td>
        <td><label class="row small" style="margin:0"><input type="checkbox" data-invalid="${r.id}" ${r.invalid ? 'checked' : ''}> invalid</label>
          ${r.invalid ? `<label class="row small" style="margin:4px 0 0"><input type="checkbox" data-paid="${r.id}" ${r.paid_at ? 'checked' : ''}> paid</label>` : ''}</td>
        <td class="row"><button class="small" data-restore="${r.id}">Restore</button><button class="small danger" data-delete-reg="${r.id}">Delete</button></td>
      </tr>`;
    })
    .join('');

  return `
    <section class="card">
      <div class="row spread">
        <div><h2>${esc(s.title)}</h2>
          <p>${esc(fmtRange(s.starts_at, s.ends_at))}${s.location ? ` · ${esc(s.location)}` : ''}${s.fee ? ` · ${esc(s.fee)}` : ''}</p></div>
        <div class="row">
          <button class="small" data-act="edit-session">Edit</button>
          <button class="small" data-act="duplicate">Duplicate +1 week</button>
          <button class="small" data-act="export-session">Export CSV</button>
          <button class="small danger" data-act="delete-session">Delete</button>
        </div>
      </div>
      <p class="small muted">Registration opens ${esc(fmtDateTime(s.opens_at))} · free drop-out until ${esc(fmtDateTime(s.dropout_deadline))} ·
        ${s.finalised_at ? `list confirmed ${esc(fmtStamp(s.finalised_at))} <button class="link small" data-act="unfinalise">undo</button>` : 'list not confirmed yet'}</p>
    </section>

    <section class="card">
      <div class="row spread">
        <h2>Queue <span class="muted small">${active.length} registered · ${s.capacity} spots</span></h2>
        <div class="row">
          <span class="small ${ticked > s.capacity ? 'bad' : 'muted'}">${ticked}/${s.capacity} ticked${state.dirty ? ' · <strong>unsaved</strong>' : ''}</span>
          <button class="small" data-act="tick-top">Tick top ${s.capacity}</button>
          <button class="small" data-act="tick-none">Clear</button>
          <button class="small primary" data-act="save-ticks" ${state.dirty || !s.finalised_at ? '' : 'disabled'}>${s.finalised_at ? 'Save list' : 'Confirm list'}</button>
        </div>
      </div>
      <p class="small muted">Sorted by priority, then registration time. Dashed line = capacity. Confirming the list records who missed out (raising their priority next time).</p>
      ${active.length ? `<div class="table-wrap"><table>
        <thead><tr><th>In</th><th class="num">#</th><th>Name</th><th>Registered</th><th class="num">Prio</th><th>Attended</th><th>Invalid</th><th>Paid</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="muted">No registrations yet.</p>'}
      ${lateDrops.length ? `<div class="notice warn" style="margin-top:12px">${lateDrops.length} late drop-out${lateDrops.length > 1 ? 's' : ''} with a reason — review below and tick “invalid” if not acceptable.</div>` : ''}
      ${withdrawn.length ? `<h3>Dropped out</h3><div class="table-wrap"><table><tbody>${wRows}</tbody></table></div>` : ''}
      <details style="margin-top:12px">
        <summary>Add someone (organiser override)</summary>
        <form id="add-form" class="stack" style="margin-top:8px">
          <div class="fields">
            <div><label>Name</label><input name="name" required maxlength="80"></div>
            <div><label>Email</label><input name="email" type="email" required></div>
            <div><label>Note (private)</label><input name="note" maxlength="500"></div>
          </div>
          <label class="row" style="margin:0"><input type="checkbox" name="select" checked> Tick into the playing list</label>
          <div><button type="submit">Add</button></div>
        </form>
      </details>
    </section>

    ${viewEmail()}`;
}

function viewEmail() {
  ensureDraft();
  const s = state.detail.session;
  const { kind, filter, subject, body } = state.email;
  const list = recipients();
  const emails = list.map((r) => r.email);
  const mailto = mailtoUrl(emails);
  const tooLong = mailto.length > 1900;
  const desc = {
    invite: 'Ticked players (saved list).',
    waitlist: 'Registered but not ticked.',
    payment: 'Attended players, plus anyone flagged invalid (late dropout / no-show).',
  }[kind];
  const tickedNotAttended = state.detail.active.filter((r) => r.selected && r.attended !== 1).length;
  return `
    <section class="card stack">
      <div class="row spread">
        <h2>Emails &amp; invites</h2>
        <div class="row">
          ${['invite', 'waitlist', 'payment'].map((k) => `<button class="small ${kind === k ? 'primary' : ''}" data-email-kind="${k}">${{ invite: 'Invite', waitlist: 'Waitlist', payment: 'Payment' }[k]}</button>`).join('')}
        </div>
      </div>
      ${state.dirty ? '<div class="notice warn">You have unsaved ticks — save the list first so recipients are up to date.</div>' : ''}
      <div class="row spread">
        <p class="small muted" style="margin:0">${desc} ${list.length} recipient${list.length === 1 ? '' : 's'}.</p>
        ${kind !== 'waitlist' ? `<select data-act="email-filter" style="width:auto">
          <option value="unsent" ${filter === 'unsent' ? 'selected' : ''}>Not yet emailed</option>
          ${kind === 'payment' ? `<option value="unpaid" ${filter === 'unpaid' ? 'selected' : ''}>Not yet paid (reminder)</option>` : ''}
          <option value="all" ${filter === 'all' ? 'selected' : ''}>Everyone</option>
        </select>` : ''}
      </div>
      ${kind === 'payment' && tickedNotAttended ? `<div class="row"><span class="small muted">${tickedNotAttended} ticked player(s) not marked attended.</span><button class="small" data-act="all-attended">Mark all ticked as attended</button></div>` : ''}
      <div><label>Bcc</label><textarea readonly rows="2">${esc(emails.join(', '))}</textarea></div>
      <div><label>Subject</label><input data-email-field="subject" value="${esc(subject)}"></div>
      <div><label>Body</label><textarea data-email-field="body" rows="8">${esc(body)}</textarea></div>
      <div class="row">
        <a class="btn ${list.length ? '' : 'hidden'}" href="${esc(mailto)}" data-mailto>Open in email app</a>
        <button data-act="copy-emails" ${list.length ? '' : 'disabled'}>Copy addresses</button>
        <button data-act="copy-subject">Copy subject</button>
        <button data-act="copy-body">Copy body</button>
        ${kind !== 'waitlist' ? `<button data-act="mark-sent" ${list.length ? '' : 'disabled'}>Mark as sent</button>` : ''}
      </div>
      ${tooLong ? '<p class="small muted">Long recipient list: some mail apps truncate links this long. If addresses are missing, use the copy buttons.</p>' : ''}
      ${kind === 'invite' ? `
        <div>
          <label>Calendar invite</label>
          <div class="row">
            <button data-act="ics" ${list.length ? '' : 'disabled'}>Download .ics</button>
            <a class="btn ${list.length ? '' : 'hidden'}" target="_blank" rel="noopener" href="${esc(outlookUrl(s, emails))}">Outlook calendar ↗</a>
            <a class="btn ${list.length ? '' : 'hidden'}" target="_blank" rel="noopener" href="${esc(googleUrl(s, emails))}">Google Calendar ↗</a>
          </div>
          <p class="small muted" style="margin-top:4px">Outlook / Google open a new event with everyone pre-filled as attendees — press Send. Or open the .ics in your calendar app.</p>
        </div>` : ''}
    </section>`;
}

function viewPeople() {
  if (!state.people) return '<p class="muted">Loading…</p>';
  const cfg = state.settings;
  const f = state.peopleFilter.toLowerCase();
  const rows = state.people
    .filter((p) => !f || p.name.toLowerCase().includes(f) || p.email.includes(f))
    .map((p, i) => {
      const st = p.stats;
      return `<tr>
        <td class="num">${i + 1}</td>
        <td><input type="text" data-person="${p.id}" data-field="name" value="${esc(p.name)}"></td>
        <td><input type="text" data-person="${p.id}" data-field="email" value="${esc(p.email)}"></td>
        <td class="num"><strong>${p.priority}</strong></td>
        <td class="num">${st.played}</td>
        <td class="num">${st.waitlisted}</td>
        <td class="num">${st.miss_streak}</td>
        <td class="num">${st.invalid_recent}/${st.invalid_total}</td>
        <td class="num">${st.no_shows}</td>
        <td class="num">${st.excused}</td>
        <td class="num">${st.dropped}</td>
        <td class="num">${st.unpaid ? `<span class="pill bad">${st.unpaid}</span>` : 0}</td>
        <td class="small">${st.last_played ? esc(fmtDate(st.last_played)) : '—'}</td>
        <td><input type="number" step="0.5" data-person="${p.id}" data-field="priority_adjust" value="${p.priority_adjust}" style="width:70px"></td>
        <td><input type="text" data-person="${p.id}" data-field="notes" value="${esc(p.notes)}" placeholder="private notes"></td>
      </tr>`;
    })
    .join('');
  return `
    <section class="card stack">
      <div class="row spread">
        <h2>People <span class="muted small">${state.people.length}</span></h2>
        <div class="row"><input id="people-filter" placeholder="Search" value="${esc(state.peopleFilter)}" style="width:180px"><button class="small" data-act="export-people">Export people CSV</button><button class="small" data-act="export-history">Export full history CSV</button></div>
      </div>
      <p class="small muted">Priority for the next session = ${cfg.weight_miss} × missed streak − ${cfg.weight_invalid} × invalid (last ${cfg.penalty_days} days) − ${cfg.weight_recent} × played (last ${cfg.recent_days} days) + adjust. Ties go to whoever registered first. Change weights in Settings.</p>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">#</th><th>Name</th><th>Email</th><th class="num">Prio</th><th class="num">Played</th><th class="num">Waitlisted</th><th class="num" title="Consecutive misses">Streak</th>
          <th class="num" title="Recent / total">Invalid</th><th class="num">No-show</th><th class="num" title="Late dropouts with a reason">Excused</th><th class="num" title="Free dropouts">Dropped</th><th class="num" title="Sessions with a fee owing, not marked paid">Unpaid</th><th>Last played</th><th>Adjust</th><th>Notes</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="15" class="muted">Nobody yet.</td></tr>'}</tbody>
      </table></div>
    </section>`;
}

function viewSettings() {
  const c = state.settings;
  const field = (k, label, type = 'text', extra = '') =>
    `<div><label>${label}</label><input name="${k}" type="${type}" value="${esc(c[k])}" ${extra}></div>`;
  const area = (k, label, rows = 5) => `<div><label>${label}</label><textarea name="${k}" rows="${rows}">${esc(c[k])}</textarea></div>`;
  return `
    <form id="settings-form" class="stack">
      <section class="card stack">
        <h2>General</h2>
        <div class="fields">
          ${field('club_name', 'Club name')}
          ${field('timezone', 'Timezone (IANA)')}
          ${field('organiser_name', 'Organiser name (email sign-off)')}
          ${field('organiser_email', 'Organiser email', 'email')}
        </div>
        <div class="fields">
          ${field('default_location', 'Default location')}
          ${field('default_capacity', 'Default capacity', 'number', 'min="1"')}
          ${field('default_fee', 'Default fee')}
        </div>
      </section>
      <section class="card stack">
        <h2>Queue priority</h2>
        <p class="small muted">Higher priority plays first; equal priority is first come, first served. Set all weights to 0 for pure first come, first served.</p>
        <div class="fields">
          ${field('weight_miss', 'Bonus per consecutive miss', 'number', 'step="0.5"')}
          ${field('weight_invalid', 'Penalty per invalid dropout', 'number', 'step="0.5"')}
          ${field('penalty_days', 'Penalty lasts (days)', 'number', 'min="0"')}
          ${field('weight_recent', 'Penalty per recent session played', 'number', 'step="0.1"')}
          ${field('recent_days', '“Recent” window (days)', 'number', 'min="0"')}
        </div>
      </section>
      <section class="card stack">
        <h2>Email templates</h2>
        <p class="small muted">Placeholders: <code>{club}</code> <code>{title}</code> <code>{date}</code> <code>{time}</code> <code>{location}</code> <code>{fee}</code> <code>{payment_details}</code> <code>{organiser}</code></p>
        ${area('signup_message', 'Message shown to attendees after signing up (<code>{deadline}</code> = free drop-out deadline)', 4)}
        ${area('payment_details', 'Payment details (inserted as {payment_details})', 3)}
        ${field('invite_subject', 'Invite subject')}
        ${area('invite_body', 'Invite body')}
        ${field('waitlist_subject', 'Waitlist subject')}
        ${area('waitlist_body', 'Waitlist body')}
        ${field('payment_subject', 'Payment subject')}
        ${area('payment_body', 'Payment body')}
      </section>
      <div><button class="primary" type="submit">Save settings</button></div>
    </form>`;
}

function render() {
  const app = $('#app');
  if (!state.token) {
    app.innerHTML = viewLogin();
    return;
  }
  if (!state.settings) {
    app.innerHTML = state.error ? viewShell('') : '<p class="muted">Loading…</p>';
    return;
  }
  const inner = state.tab === 'sessions' ? viewSessions() : state.tab === 'people' ? viewPeople() : viewSettings();
  app.innerHTML = viewShell(inner);
}

// ------------------------------------------------------------ actions

function blankSessionForm() {
  const c = state.settings;
  const last = state.sessions[0];
  if (last) return formFromSession(last, 7, true);
  const start = new Date();
  start.setDate(start.getDate() + 7);
  start.setHours(19, 0, 0, 0);
  const startIso = start.toISOString();
  return {
    id: null,
    title: 'Badminton',
    location: c.default_location,
    starts_at: toLocalInput(startIso),
    ends_at: toLocalInput(new Date(start.getTime() + 2 * 3600e3).toISOString()),
    opens_at: toLocalInput(new Date().toISOString()),
    dropout_deadline: toLocalInput(prevBusinessDay(startIso)),
    capacity: c.default_capacity,
    fee: c.default_fee,
    notes: '',
  };
}

function formFromSession(s, shiftDays = 0, asNew = false) {
  const sh = (iso) => toLocalInput(shiftDays ? addDays(iso, shiftDays) : iso);
  return {
    id: asNew ? null : s.id,
    title: s.title,
    location: s.location,
    starts_at: sh(s.starts_at),
    ends_at: sh(s.ends_at),
    opens_at: sh(s.opens_at),
    dropout_deadline: sh(s.dropout_deadline),
    capacity: s.capacity,
    fee: s.fee,
    notes: s.notes,
  };
}

document.addEventListener('submit', (ev) => {
  const form = ev.target;
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(form));

  if (form.id === 'login')
    return run(async () => {
      const r = await rawApi('/api/admin/login', { method: 'POST', body: { password: fd.password } });
      state.token = r.token;
      session.set(TOKEN, r.token);
      state.error = null;
      await loadAll();
    });

  if (form.id === 'session-form')
    return run(async () => {
      const e = state.editing;
      const payload = {
        ...fd,
        starts_at: fromLocalInput(fd.starts_at),
        ends_at: fromLocalInput(fd.ends_at),
        opens_at: fromLocalInput(fd.opens_at),
        dropout_deadline: fromLocalInput(fd.dropout_deadline),
        capacity: Number(fd.capacity),
      };
      const saved = await api(e.id ? `/api/admin/sessions/${e.id}` : '/api/admin/sessions', { method: e.id ? 'PUT' : 'POST', body: payload });
      state.editing = null;
      await loadSessions();
      await loadDetail(saved.id);
      toast('Session saved');
    });

  if (form.id === 'add-form')
    return run(async () => {
      setDetail(await api(`/api/admin/sessions/${state.currentId}/add`, { method: 'POST', body: { ...fd, select: !!fd.select } }), true);
      await loadSessions();
      toast(`Added ${fd.name}${fd.select ? ' — save the list to keep the tick' : ''}`);
      if (fd.select) {
        const r = state.detail.active.find((x) => x.email === fd.email.trim().toLowerCase());
        if (r) state.ticks.add(r.id);
      }
    });

  if (form.id === 'settings-form')
    return run(async () => {
      state.settings = await api('/api/admin/settings', { method: 'PUT', body: fd });
      setTimezone(state.settings.timezone);
      state.email.key = '';
      toast('Settings saved');
    });
});

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('button, [data-act]');
  if (!t) return;
  const d = t.dataset;

  if (d.tab) {
    state.tab = d.tab;
    state.error = null;
    if (d.tab === 'people') {
      state.people = null;
      run(async () => (state.people = await api('/api/admin/people')));
    }
    return render();
  }
  if (d.session) {
    if (state.dirty && !confirm('Discard unsaved ticks?')) return;
    state.editing = null;
    return run(() => loadDetail(Number(d.session)));
  }
  const id = state.currentId;
  const patch = (rid, body) => run(async () => setDetail(await api(`/api/admin/registrations/${rid}`, { method: 'PATCH', body }), true));

  if (d.withdraw) {
    const reason = prompt('Remove from this session. Reason (optional, private):');
    if (reason === null) return;
    return patch(Number(d.withdraw), { withdraw_reason: reason }).then(loadSessions).then(render);
  }
  if (d.restore) return patch(Number(d.restore), { restore: true }).then(loadSessions).then(render);
  if (d.deleteReg) {
    if (!confirm('Permanently delete this registration? This removes it from history too.')) return;
    return run(async () => setDetail(await api(`/api/admin/registrations/${d.deleteReg}`, { method: 'DELETE' }), true));
  }
  if (d.emailKind) {
    state.email.kind = d.emailKind;
    if (d.emailKind !== 'payment' && state.email.filter === 'unpaid') state.email.filter = 'unsent';
    state.email.key = '';
    return render();
  }

  switch (d.act) {
    case 'logout':
      state.token = null;
      session.remove(TOKEN);
      return render();
    case 'new-session':
      state.editing = blankSessionForm();
      return render();
    case 'edit-session':
      state.editing = formFromSession(state.detail.session);
      return render();
    case 'duplicate':
      state.editing = formFromSession(state.detail.session, 7, true);
      return render();
    case 'cancel-edit':
      state.editing = null;
      return render();
    case 'delete-session':
      if (!confirm('Delete this session and all its registrations? This cannot be undone.')) return;
      return run(async () => {
        await api(`/api/admin/sessions/${id}`, { method: 'DELETE' });
        state.currentId = null;
        state.detail = null;
        await loadAll();
      });
    case 'unfinalise':
      if (!confirm('Mark the list as not confirmed? Waitlist counts from this session will stop counting.')) return;
      return run(async () => {
        setDetail(await api(`/api/admin/sessions/${id}/unfinalise`, { method: 'POST' }), true);
        await loadSessions();
      });
    case 'tick-top':
      state.ticks = new Set(state.detail.active.slice(0, state.detail.session.capacity).map((r) => r.id));
      state.dirty = true;
      return render();
    case 'tick-none':
      state.ticks = new Set();
      state.dirty = true;
      return render();
    case 'save-ticks':
      return run(async () => {
        setDetail(await api(`/api/admin/sessions/${id}/selection`, { method: 'POST', body: { ids: [...state.ticks] } }));
        await loadSessions();
        toast('List saved');
      });
    case 'all-attended': {
      const ids = state.detail.active.filter((r) => r.selected && r.attended !== 1).map((r) => r.id);
      return run(async () => {
        for (const rid of ids) setDetail(await api(`/api/admin/registrations/${rid}`, { method: 'PATCH', body: { attended: true } }), true);
      });
    }
    case 'copy-emails':
      return copy(recipients().map((r) => r.email).join(', '), 'Addresses copied');
    case 'copy-subject':
      return copy(state.email.subject, 'Subject copied');
    case 'copy-body':
      return copy(state.email.body, 'Body copied');
    case 'mark-sent': {
      const ids = recipients().map((r) => r.id);
      return run(async () => {
        setDetail(await api(`/api/admin/sessions/${id}/mark`, { method: 'POST', body: { field: state.email.kind === 'invite' ? 'invited' : 'payment', ids } }), true);
        toast(`Marked ${ids.length} as sent`);
      });
    }
    case 'ics': {
      const s = state.detail.session;
      return download(`badminton-${s.starts_at.slice(0, 10)}.ics`, buildIcs(s, recipients()), 'text/calendar');
    }
    case 'export-people':
      return downloadCsv('people.csv', state.people.map((p) => ({
        name: p.name, email: p.email, priority: p.priority, played: p.stats.played, waitlisted: p.stats.waitlisted,
        miss_streak: p.stats.miss_streak, invalid_recent: p.stats.invalid_recent, invalid_total: p.stats.invalid_total,
        no_shows: p.stats.no_shows, excused: p.stats.excused, dropped: p.stats.dropped, unpaid: p.stats.unpaid,
        last_played: csvTime(p.stats.last_played), priority_adjust: p.priority_adjust, notes: p.notes,
      })));
    case 'export-history':
      return run(async () => {
        const rows = await api('/api/admin/export');
        downloadCsv(`badminton-history-${new Date().toISOString().slice(0, 10)}.csv`, rows.map(historyRow));
      });
    case 'export-session': {
      const { session: s, active, withdrawn } = state.detail;
      const rows = [...active, ...withdrawn].map((r) => ({
        queue_rank: r.rank ?? '', priority: r.priority,
        ...historyRow({ ...r, session_start: s.starts_at, session_title: s.title, location: s.location, fee: s.fee, list_confirmed_at: s.finalised_at }),
      }));
      return downloadCsv(`badminton-${s.starts_at.slice(0, 10)}.csv`, rows);
    }
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  const d = t.dataset;
  if (d.tick) {
    const rid = Number(d.tick);
    t.checked ? state.ticks.add(rid) : state.ticks.delete(rid);
    state.dirty = true;
    return render();
  }
  if (d.attended) return patchReg(Number(d.attended), { attended: t.checked });
  if (d.invalid) return patchReg(Number(d.invalid), { invalid: t.checked });
  if (d.paid) return patchReg(Number(d.paid), { paid: t.checked });
  if (d.note !== undefined) return patchReg(Number(d.note), { note: t.value });
  if (d.act === 'email-filter') {
    state.email.filter = t.value;
    return render();
  }
  if (d.person)
    return run(async () => {
      await api(`/api/admin/people/${d.person}`, { method: 'PATCH', body: { [d.field]: t.value } });
      state.people = await api('/api/admin/people');
      toast('Saved');
    });

  // Session form: keep the drop-out deadline in sync with start time unless edited by hand.
  const form = t.closest('#session-form');
  if (form && state.editing) {
    const el = form.elements;
    const prevStart = state.editing.starts_at;
    if (t.name === 'starts_at' && t.value) {
      // Move the deadline along with the start, unless it was edited by hand.
      const autoDeadline = prevStart ? toLocalInput(prevBusinessDay(fromLocalInput(prevStart))) : '';
      if (!el.dropout_deadline.value || el.dropout_deadline.value === autoDeadline)
        el.dropout_deadline.value = toLocalInput(prevBusinessDay(fromLocalInput(t.value)));
      // Keep the same duration.
      const dur = prevStart && Date.parse(fromLocalInput(el.ends_at.value)) - Date.parse(fromLocalInput(prevStart));
      if (dur > 0) el.ends_at.value = toLocalInput(new Date(Date.parse(fromLocalInput(t.value)) + dur).toISOString());
    }
    state.editing = { ...state.editing, ...Object.fromEntries(new FormData(form)) };
  }
});

function patchReg(rid, body) {
  return run(async () => setDetail(await api(`/api/admin/registrations/${rid}`, { method: 'PATCH', body }), true));
}

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.emailField) {
    state.email[t.dataset.emailField] = t.value;
    const a = document.querySelector('[data-mailto]');
    if (a) a.href = mailtoUrl(recipients().map((r) => r.email));
  }
  if (t.id === 'people-filter') {
    state.peopleFilter = t.value;
    const pos = t.selectionStart;
    render();
    const el = $('#people-filter');
    el.focus();
    el.setSelectionRange(pos, pos);
  }
});

window.addEventListener('beforeunload', (ev) => {
  if (state.dirty) ev.preventDefault();
});

if (state.token) run(loadAll);
else render();
