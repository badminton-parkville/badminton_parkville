import { api, esc, $, fmtRange, fmtDateTime, fmtStamp, fmtCountdown, setTimezone, copy, storage, toast } from './common.js';

const store = storage('local');
const TOKENS = 'bp.tokens'; // { [sessionId]: token }
const PROFILE = 'bp.profile'; // { name, email }

const state = {
  data: null, // /api/sessions response
  offset: 0, // server clock - local clock
  mine: {}, // sessionId -> status
  profile: store.get(PROFILE, { name: '', email: '' }),
  reasonOpen: {}, // sessionId -> bool
  busy: false,
  error: null,
};

const now = () => Date.now() + state.offset;
const DROP_WARNING =
  'Are you sure?\n\nYour spot will be offered to someone on the waiting list, and if you sign up again you will go to the back of the queue.';
const tokens = () => store.get(TOKENS, {});
function saveToken(sessionId, token) {
  const t = tokens();
  t[sessionId] = token;
  store.set(TOKENS, t);
}

async function load() {
  // Manage link: ?t=<token>
  const params = new URLSearchParams(location.search);
  const linkToken = params.get('t');
  if (linkToken) {
    try {
      const st = await api('/api/status', { method: 'POST', body: { token: linkToken } });
      saveToken(st.session.id, st.token);
    } catch (e) {
      state.error = 'That manage link is not valid any more.';
    }
    history.replaceState(null, '', location.pathname);
  }

  try {
    state.data = await api('/api/sessions');
  } catch (e) {
    $('#sessions').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    return;
  }
  state.offset = Date.parse(state.data.now) - Date.now();
  setTimezone(state.data.timezone);
  document.title = state.data.club_name;
  $('#club').textContent = state.data.club_name;
  if (state.data.organiser_email)
    $('#footer').innerHTML = `Questions? Email <a href="mailto:${esc(state.data.organiser_email)}">${esc(state.data.organiser_email)}</a>.`;

  const t = tokens();
  const live = new Set(state.data.sessions.map((s) => String(s.id)));
  // Forget tokens for sessions that are over.
  for (const id of Object.keys(t)) if (!live.has(id)) delete t[id];
  store.set(TOKENS, t);
  await Promise.all(
    Object.entries(t).map(async ([id, token]) => {
      try {
        state.mine[id] = await api('/api/status', { method: 'POST', body: { token } });
      } catch (e) {
        if (e.status === 404) {
          const t2 = tokens();
          delete t2[id];
          store.set(TOKENS, t2);
        }
      }
    })
  );
  render();
}

function phase(s) {
  const n = now();
  if (n < Date.parse(s.opens_at)) return 'upcoming';
  if (n < Date.parse(s.starts_at)) return 'open';
  return 'closed';
}

function statusBlock(s, me) {
  const n = now();
  const freeDrop = n < Date.parse(s.dropout_deadline);
  const msg = (state.data.signup_message || 'Signup recorded.').replaceAll('{deadline}', fmtDateTime(s.dropout_deadline));
  const headline = `<span class="pill ok">Registered</span> ${esc(msg)}`;

  const manageUrl = `${location.origin}${location.pathname}?t=${encodeURIComponent(me.token)}`;
  const reasonOpen = state.reasonOpen[s.id];
  return `
    <div class="notice" style="margin-top:12px">${headline}</div>
    <p class="small muted" style="margin-top:8px">Registered as ${esc(me.name)} (${esc(me.email)}) at ${esc(fmtStamp(me.registered_at))}.</p>
    <div class="row" style="margin-top:8px">
      <button data-act="drop" data-id="${s.id}" ${freeDrop ? '' : 'disabled'}>Drop out</button>
      ${freeDrop ? '' : `<button data-act="reason-toggle" data-id="${s.id}">Drop out with a reason…</button>`}
    </div>
    <p class="small muted" style="margin-top:6px">
      ${freeDrop
        ? `Free drop-out until ${esc(fmtDateTime(s.dropout_deadline))}.`
        : `Free drop-out closed ${esc(fmtDateTime(s.dropout_deadline))}. You can still drop out for a valid reason (e.g. illness).`}
    </p>
    ${!freeDrop && reasonOpen ? `
      <form class="stack" data-form="reason" data-id="${s.id}" style="margin-top:8px">
        <div><label for="reason-${s.id}">Reason</label>
        <textarea id="reason-${s.id}" name="reason" required minlength="3" maxlength="500" placeholder="e.g. Sick with flu"></textarea></div>
        <div><button class="primary" type="submit">Confirm drop out</button></div>
      </form>` : ''}
    <details style="margin-top:12px">
      <summary>Manage from another device</summary>
      <p class="small muted" style="margin-top:6px">This link lets you check your signup or drop out. Keep it private.</p>
      <button class="small" data-act="copy" data-text="${esc(manageUrl)}">Copy my link</button>
    </details>`;
}

function registerForm(s) {
  const p = state.profile;
  return `
    <form class="stack" data-form="register" data-id="${s.id}" style="margin-top:12px">
      <div class="fields">
        <div><label for="name-${s.id}">Name</label>
          <input id="name-${s.id}" name="name" autocomplete="name" required maxlength="80" value="${esc(p.name)}"></div>
        <div><label for="email-${s.id}">Email</label>
          <input id="email-${s.id}" name="email" type="email" autocomplete="email" required value="${esc(p.email)}"></div>
      </div>
      <p class="small muted">Free drop-out until ${esc(fmtDateTime(s.dropout_deadline))}.</p>
      <div><button class="primary" type="submit" ${state.busy ? 'disabled' : ''}>Register</button></div>
    </form>`;
}

function card(s) {
  const me = state.mine[s.id];
  const ph = phase(s);
  const pct = Math.min(100, Math.round((s.count / s.capacity) * 100));
  const waitlist = Math.max(0, s.count - s.capacity);
  let pill = '';
  if (ph === 'upcoming') pill = `<span class="pill">Opens soon</span>`;
  else if (ph === 'open') pill = s.count >= s.capacity ? `<span class="pill warn">Full · waitlist open</span>` : `<span class="pill ok">Open</span>`;
  else pill = `<span class="pill">Closed</span>`;

  let body = '';
  if (me && me.state !== 'withdrawn') {
    body = statusBlock(s, me);
  } else {
    if (me && me.state === 'withdrawn') body += `<p class="notice warn" style="margin-top:12px">You dropped out of this session.</p>`;
    if (ph === 'upcoming')
      body += `<p class="notice" style="margin-top:12px">Registration opens ${esc(fmtDateTime(s.opens_at))}
        <span class="muted">(in <span data-countdown="${esc(s.opens_at)}">${fmtCountdown(Date.parse(s.opens_at) - now())}</span>)</span>.</p>`;
    else if (ph === 'open') body += registerForm(s);
    else body += `<p class="muted" style="margin-top:12px">Registration has closed.</p>`;
  }

  return `
    <section class="card">
      <div class="row spread"><h2>${esc(s.title)}</h2>${pill}</div>
      <p>${esc(fmtRange(s.starts_at, s.ends_at))}${s.location ? ` · ${esc(s.location)}` : ''}</p>
      ${s.fee ? `<p class="small muted">Fee: ${esc(s.fee)}</p>` : ''}
      ${s.notes ? `<p class="small muted">${esc(s.notes)}</p>` : ''}
      <div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <p class="small muted">${s.count} registered · ${s.capacity} spots${waitlist ? ` · ${waitlist} on waitlist` : ''}</p>
      ${body}
    </section>`;
}

function render() {
  const sessions = state.data?.sessions || [];
  const err = state.error ? `<div class="notice bad" style="margin-bottom:12px">${esc(state.error)}</div>` : '';
  $('#sessions').innerHTML =
    err + (sessions.length ? sessions.map(card).join('') : `<div class="card muted">No sessions scheduled yet. Check back soon.</div>`);
}

// ------------------------------------------------------------ events

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const id = form.dataset.id;
  const fd = new FormData(form);
  if (form.dataset.form === 'reason' && !confirm(DROP_WARNING)) return;
  state.error = null;
  state.busy = true;
  form.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    if (form.dataset.form === 'register') {
      const profile = { name: fd.get('name').trim(), email: fd.get('email').trim() };
      state.profile = profile;
      store.set(PROFILE, profile);
      const st = await api('/api/register', { method: 'POST', body: { session_id: Number(id), ...profile } });
      saveToken(id, st.token);
      state.mine[id] = st;
      toast('Registered!');
    } else if (form.dataset.form === 'reason') {
      const st = await api('/api/withdraw', { method: 'POST', body: { token: state.mine[id].token, reason: fd.get('reason') } });
      state.mine[id] = st;
      state.reasonOpen[id] = false;
      toast('You have dropped out');
    }
    await refreshCounts();
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  render();
});

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'copy') return copy(btn.dataset.text, 'Link copied');
  if (act === 'reason-toggle') {
    state.reasonOpen[id] = !state.reasonOpen[id];
    render();
    document.getElementById(`reason-${id}`)?.focus();
    return;
  }
  if (act === 'drop') {
    if (!confirm(DROP_WARNING)) return;
    state.error = null;
    try {
      state.mine[id] = await api('/api/withdraw', { method: 'POST', body: { token: state.mine[id].token } });
      toast('You have dropped out');
      await refreshCounts();
    } catch (e) {
      state.error = e.message;
    }
    render();
  }
});

async function refreshCounts() {
  try {
    state.data = await api('/api/sessions');
    state.offset = Date.parse(state.data.now) - Date.now();
  } catch {}
}

// Tick countdowns; re-render when a session opens, closes or passes its drop-out deadline.
let lastKey = '';
setInterval(() => {
  if (!state.data) return;
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    el.textContent = fmtCountdown(Date.parse(el.dataset.countdown) - now());
  });
  const key = state.data.sessions.map((s) => phase(s) + (now() < Date.parse(s.dropout_deadline))).join();
  if (lastKey && key !== lastKey && !document.activeElement?.matches('input, textarea')) render();
  lastKey = key;
}, 15000);

load();
