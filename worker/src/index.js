// Badminton signup API — Cloudflare Worker + D1.
//
// Public routes (no auth):
//   GET  /api/sessions                 upcoming sessions + counts
//   POST /api/register                 {session_id, name, email}
//   POST /api/status                   {token}
//   POST /api/withdraw                 {token, reason?}
//
// Admin routes (Authorization: Bearer <token from /api/admin/login>):
//   POST   /api/admin/login            {password}
//   GET    /api/admin/sessions
//   POST   /api/admin/sessions
//   GET    /api/admin/sessions/:id      session + priority-ordered queue
//   PUT    /api/admin/sessions/:id
//   DELETE /api/admin/sessions/:id
//   POST   /api/admin/sessions/:id/add        {name, email, note?}
//   POST   /api/admin/sessions/:id/selection  {ids: [registrationId]}
//   POST   /api/admin/sessions/:id/unfinalise
//   POST   /api/admin/sessions/:id/mark       {field: 'invited'|'payment', ids}
//   PATCH  /api/admin/registrations/:id       {attended, invalid, paid, note, selected, withdraw_reason, restore}
//   DELETE /api/admin/registrations/:id
//   GET    /api/admin/export                  every registration ever, flattened (for CSV)
//   GET    /api/admin/people
//   PATCH  /api/admin/people/:id              {name, email, notes, priority_adjust}
//   GET    /api/admin/settings
//   PUT    /api/admin/settings

const DAY = 86400000;
const ADMIN_TOKEN_TTL = 12 * 3600 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

export const DEFAULT_SETTINGS = {
  club_name: 'Parkville Badminton',
  organiser_name: '',
  organiser_email: '',
  timezone: 'Australia/Melbourne',
  default_location: '',
  default_capacity: 12,
  default_fee: '',
  // Queue priority (slurm-style multifactor). Score = higher plays first;
  // ties broken by registration time (first come, first served).
  weight_miss: 1,       // + per consecutive time waitlisted since last played
  weight_invalid: 2,    // − per organiser-flagged invalid dropout / no-show (within penalty_days)
  weight_recent: 0,     // − per session played within recent_days (fair-share; 0 = off)
  penalty_days: 90,
  recent_days: 28,
  // Shown to attendees after they register. {deadline} = free drop-out deadline.
  signup_message:
    'Signup recorded. If you are successful (depending on available spots and the waiting list) you will receive an ' +
    'email closer to the session. Please drop out by {deadline} if you can\'t make it, to allow others to join. ' +
    'Except for illness or other emergencies, registrants who do not drop out will be charged the attendance fee ' +
    'and have reduced priority in future signups.',
  payment_details: 'Account name: ...\nBSB: ...  Account: ...\n(or PayID: ...)',
  invite_subject: '{club}: you\'re in for {date}',
  invite_body:
    'Hi all,\n\nYou\'re confirmed for badminton on {date}, {time} at {location}.\n\n' +
    'If you can no longer make it, please drop out via the signup page as early as possible ' +
    'so someone on the waitlist can take your spot.\n\nSee you on court!\n{organiser}',
  waitlist_subject: '{club}: waitlist for {date}',
  waitlist_body:
    'Hi all,\n\nThanks for registering for {date}. The session is full and you\'re currently on the waitlist. ' +
    'We\'ll email you if a spot opens up. Your priority goes up for next time.\n\n{organiser}',
  payment_subject: '{club}: payment for {date}',
  payment_body:
    'Hi all,\n\nThanks for playing on {date}. The fee is {fee} per person — please pay to:\n\n' +
    '{payment_details}\n\nUse your name as the reference.\n\nThanks!\n{organiser}',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const nowISO = () => new Date().toISOString();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed.includes('*') && !allowed.includes(origin) && !isLocal) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res = json({ error: status === 500 ? 'Server error' : e.message }, status);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

// ---------------------------------------------------------------- routing

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;

  if (path === '/api/sessions' && m === 'GET') return publicSessions(env);
  if (path === '/api/register' && m === 'POST') return register(env, await body(request));
  if (path === '/api/status' && m === 'POST') return status(env, await body(request));
  if (path === '/api/withdraw' && m === 'POST') return withdraw(env, await body(request));
  if (path === '/api/admin/login' && m === 'POST') return login(env, await body(request));

  if (path.startsWith('/api/admin/')) {
    await requireAdmin(request, env);
    const parts = path.split('/').slice(3); // after /api/admin
    const [res, idStr, action] = parts;
    const id = idStr ? Number(idStr) : null;
    if (idStr && !Number.isInteger(id)) throw new HttpError(404, 'Not found');

    if (res === 'sessions') {
      if (!id && m === 'GET') return adminSessions(env);
      if (!id && m === 'POST') return saveSession(env, null, await body(request));
      if (id && !action && m === 'GET') return adminSessionDetail(env, id);
      if (id && !action && m === 'PUT') return saveSession(env, id, await body(request));
      if (id && !action && m === 'DELETE') return deleteSession(env, id);
      if (id && action === 'add' && m === 'POST') return adminAdd(env, id, await body(request));
      if (id && action === 'selection' && m === 'POST') return saveSelection(env, id, await body(request));
      if (id && action === 'unfinalise' && m === 'POST') return unfinalise(env, id);
      if (id && action === 'mark' && m === 'POST') return markSent(env, id, await body(request));
    }
    if (res === 'registrations' && id) {
      if (m === 'PATCH') return patchRegistration(env, id, await body(request));
      if (m === 'DELETE') return deleteRegistration(env, id);
    }
    if (res === 'people') {
      if (!id && m === 'GET') return adminPeople(env);
      if (id && m === 'PATCH') return patchPerson(env, id, await body(request));
    }
    if (res === 'export' && !id && m === 'GET') return exportAll(env);
    if (res === 'settings') {
      if (m === 'GET') return json(await getSettings(env));
      if (m === 'PUT') return putSettings(env, await body(request));
    }
  }
  throw new HttpError(404, 'Not found');
}

async function body(request) {
  const text = await request.text();
  if (text.length > 100_000) throw new HttpError(413, 'Request too large');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, 'Invalid JSON');
}

// ---------------------------------------------------------------- validation

function cleanName(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 80) throw new HttpError(400, 'Please enter your name (max 80 characters).');
  return s;
}

function cleanEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(s))
    throw new HttpError(400, 'Please enter a valid email address.');
  return s;
}

function cleanText(v, max = 2000) {
  return String(v ?? '').trim().slice(0, max);
}

function cleanISO(v, label) {
  const t = Date.parse(v);
  if (!v || Number.isNaN(t)) throw new HttpError(400, `Invalid ${label}`);
  return new Date(t).toISOString();
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

// ---------------------------------------------------------------- settings

async function getSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = 'settings'").first();
  const stored = row ? JSON.parse(row.value) : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in stored) out[k] = stored[k];
  return out;
}

async function putSettings(env, input) {
  const cur = await getSettings(env);
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in input)) continue;
    if (typeof def === 'number') {
      const n = Number(input[k]);
      if (!Number.isFinite(n)) throw new HttpError(400, `Invalid number for ${k}`);
      cur[k] = n;
    } else {
      cur[k] = cleanText(input[k], 5000);
    }
  }
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(cur))
    .run();
  return json(cur);
}

// ---------------------------------------------------------------- admin auth

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function adminSecret(env) {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8)
    throw new HttpError(500, 'ADMIN_PASSWORD secret not configured (min 8 chars)');
  return env.ADMIN_PASSWORD;
}

async function login(env, input) {
  const secret = adminSecret(env);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = 'login_failures'").first();
  let failures = (row ? JSON.parse(row.value) : []).filter((t) => now - t < LOGIN_WINDOW);
  if (failures.length >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');

  // Constant-time comparison: compare HMACs of both values under a random key.
  const key = await crypto.subtle.importKey(
    'raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const expected = await crypto.subtle.sign('HMAC', key, enc.encode(secret));
  const ok = await crypto.subtle.verify('HMAC', key, expected, enc.encode(String(input.password ?? '')));

  if (!ok) {
    failures.push(now);
    await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('login_failures', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify(failures))
      .run();
    throw new HttpError(401, 'Wrong password');
  }
  const exp = now + ADMIN_TOKEN_TTL;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`admin:${exp}`));
  return json({ token: `${exp}.${b64url(sig)}`, expires_at: new Date(exp).toISOString() });
}

async function requireAdmin(request, env) {
  const secret = adminSecret(env);
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer (\d+)\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new HttpError(401, 'Not signed in');
  const exp = Number(m[1]);
  if (exp < Date.now()) throw new HttpError(401, 'Session expired, sign in again');
  let sig;
  try {
    sig = fromB64url(m[2]);
  } catch {
    throw new HttpError(401, 'Not signed in');
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(`admin:${exp}`));
  if (!ok) throw new HttpError(401, 'Not signed in');
}

// ---------------------------------------------------------------- priority queue

const blankStats = () => ({
  played: 0,
  waitlisted: 0,
  miss_streak: 0,
  invalid_total: 0,
  invalid_recent: 0,
  excused: 0,
  dropped: 0,
  no_shows: 0,
  recent_played: 0,
  last_played: null,
  paid: 0,
  unpaid: 0, // owes a fee (attended, or flagged invalid) but not marked paid
});

// Someone owes the fee if they attended, or were flagged invalid (late dropout / no-show).
const owesFee = (r) => !!r.invalid || (!!r.selected && !r.withdrawn_at && r.attended === 1);

// Stats per person from finalised sessions that started before `beforeMs`.
export function computeStats(history, beforeMs, cfg) {
  const penaltyFrom = beforeMs - cfg.penalty_days * DAY;
  const recentFrom = beforeMs - cfg.recent_days * DAY;
  const rows = history
    .filter((r) => r.finalised_at && Date.parse(r.starts_at) < beforeMs)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id - b.id);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.person_id)) map.set(r.person_id, blankStats());
    const st = map.get(r.person_id);
    const t = Date.parse(r.starts_at);
    if (r.invalid) {
      st.invalid_total++;
      if (t >= penaltyFrom) st.invalid_recent++;
    }
    if (owesFee(r)) r.paid_at ? st.paid++ : st.unpaid++;
    if (r.withdrawn_at) {
      if (r.withdraw_kind === 'reason') st.excused++;
      else if (r.withdraw_kind === 'normal') st.dropped++;
      continue;
    }
    if (r.selected) {
      st.played++;
      st.miss_streak = 0;
      st.last_played = r.starts_at;
      if (t >= recentFrom) st.recent_played++;
      if (r.attended === 0) st.no_shows++;
    } else {
      st.waitlisted++;
      st.miss_streak++;
    }
  }
  return map;
}

export function priorityOf(st, adjust, cfg) {
  const p =
    cfg.weight_miss * st.miss_streak -
    cfg.weight_invalid * st.invalid_recent -
    cfg.weight_recent * st.recent_played +
    (adjust || 0);
  return Math.round(p * 100) / 100;
}

export const queueOrder = (a, b) =>
  b.priority - a.priority || Date.parse(a.registered_at) - Date.parse(b.registered_at) || a.id - b.id;

async function loadHistory(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, s.starts_at, s.finalised_at
       FROM registrations r JOIN sessions s ON s.id = r.session_id`
  ).all();
  return results;
}

async function loadPeople(env) {
  const { results } = await env.DB.prepare('SELECT * FROM people').all();
  return new Map(results.map((p) => [p.id, p]));
}

async function sessionQueue(env, session, cfg) {
  const [history, people] = await Promise.all([loadHistory(env), loadPeople(env)]);
  const stats = computeStats(history, Date.parse(session.starts_at), cfg);
  const rows = history
    .filter((r) => r.session_id === session.id)
    .map((r) => {
      const p = people.get(r.person_id) || {};
      const st = stats.get(r.person_id) || blankStats();
      const { starts_at, finalised_at, ...reg } = r;
      return {
        ...reg,
        name: p.name,
        email: p.email,
        person_notes: p.notes || '',
        priority_adjust: p.priority_adjust || 0,
        stats: st,
        priority: priorityOf(st, p.priority_adjust, cfg),
      };
    });
  const active = rows.filter((r) => !r.withdrawn_at).sort(queueOrder);
  active.forEach((r, i) => (r.rank = i + 1));
  const withdrawn = rows
    .filter((r) => r.withdrawn_at)
    .sort((a, b) => Date.parse(a.withdrawn_at) - Date.parse(b.withdrawn_at));
  return { active, withdrawn };
}

// ---------------------------------------------------------------- public

const PUBLIC_SESSION_FIELDS = [
  'id', 'title', 'location', 'starts_at', 'ends_at', 'opens_at', 'dropout_deadline', 'capacity', 'fee', 'notes',
];

function publicSession(s) {
  const o = {};
  for (const k of PUBLIC_SESSION_FIELDS) o[k] = s[k];
  o.confirmed = !!s.finalised_at;
  if ('count' in s) o.count = s.count;
  return o;
}

async function getSession(env, id) {
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(Number(id)).first();
  if (!s) throw new HttpError(404, 'Session not found');
  return s;
}

async function publicSessions(env) {
  const cfg = await getSettings(env);
  const { results } = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM registrations r WHERE r.session_id = s.id AND r.withdrawn_at IS NULL) AS count
       FROM sessions s WHERE s.ends_at > ? ORDER BY s.starts_at LIMIT 20`
  ).bind(nowISO()).all();
  return json({
    club_name: cfg.club_name,
    timezone: cfg.timezone,
    organiser_email: cfg.organiser_email,
    signup_message: cfg.signup_message,
    now: nowISO(),
    sessions: results.map(publicSession),
  });
}

// What an attendee may see about their own registration. Deliberately excludes
// queue position and whether they were selected — they find out by email.
async function statusFor(env, session, regId) {
  const reg = await env.DB.prepare(
    'SELECT r.*, p.name, p.email FROM registrations r JOIN people p ON p.id = r.person_id WHERE r.id = ?'
  ).bind(regId).first();
  return {
    token: reg.token,
    session: publicSession(session),
    name: reg.name,
    email: reg.email,
    registered_at: reg.registered_at,
    withdrawn_at: reg.withdrawn_at,
    state: reg.withdrawn_at ? 'withdrawn' : 'registered',
  };
}

// Does this (active) registration currently hold a playing spot?
async function holdsSpot(env, session, regId) {
  const { active } = await sessionQueue(env, session, await getSettings(env));
  const me = active.find((r) => r.id === regId);
  if (!me) return false;
  return session.finalised_at ? !!me.selected : me.rank <= session.capacity;
}

async function upsertPerson(env, name, email) {
  await env.DB.prepare('INSERT OR IGNORE INTO people (email, name, created_at) VALUES (?, ?, ?)')
    .bind(email, name, nowISO())
    .run();
  return env.DB.prepare('SELECT * FROM people WHERE email = ?').bind(email).first();
}

// Insert or re-activate a registration. Returns registration id.
async function createRegistration(env, session, person, { adminAdded = false, note = '' } = {}) {
  const existing = await env.DB.prepare('SELECT * FROM registrations WHERE session_id = ? AND person_id = ?')
    .bind(session.id, person.id)
    .first();
  const now = nowISO();
  const token = randomToken();
  if (existing && !existing.withdrawn_at) {
    throw new HttpError(
      409,
      adminAdded
        ? `${person.name} is already registered.`
        : 'This email is already registered for this session. Use the link you got when you registered, or contact the organiser.'
    );
  }
  if (existing) {
    // Re-registering after withdrawing: goes to the back of the queue.
    await env.DB.prepare(
      `UPDATE registrations SET registered_at = ?, token = ?, withdrawn_at = NULL, withdraw_kind = NULL,
              withdraw_reason = NULL, selected = 0, attended = NULL, invalid = 0, admin_added = ?,
              note = CASE WHEN ? = '' THEN note ELSE ? END, invited_at = NULL, payment_requested_at = NULL,
              paid_at = NULL
        WHERE id = ?`
    ).bind(now, token, adminAdded ? 1 : 0, note, note, existing.id).run();
    return existing.id;
  }
  try {
    const r = await env.DB.prepare(
      `INSERT INTO registrations (session_id, person_id, registered_at, token, admin_added, note)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(session.id, person.id, now, token, adminAdded ? 1 : 0, note).first();
    return r.id;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Already registered for this session.');
    throw e;
  }
}

async function register(env, input) {
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const session = await getSession(env, input.session_id);
  const now = Date.now();
  if (now < Date.parse(session.opens_at)) throw new HttpError(400, 'Registration has not opened yet.');
  if (now >= Date.parse(session.starts_at)) throw new HttpError(400, 'Registration has closed.');
  const person = await upsertPerson(env, name, email);
  const id = await createRegistration(env, session, person);
  return json(await statusFor(env, session, id));
}

async function regByToken(env, token) {
  if (typeof token !== 'string' || token.length < 10) throw new HttpError(404, 'Registration not found');
  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE token = ?').bind(token).first();
  if (!reg) throw new HttpError(404, 'Registration not found');
  return reg;
}

async function status(env, input) {
  const reg = await regByToken(env, input.token);
  const session = await getSession(env, reg.session_id);
  return json(await statusFor(env, session, reg.id));
}

async function withdraw(env, input) {
  const reg = await regByToken(env, input.token);
  const session = await getSession(env, reg.session_id);
  if (reg.withdrawn_at) throw new HttpError(400, 'You have already dropped out.');
  const now = Date.now();
  if (now >= Date.parse(session.starts_at))
    throw new HttpError(400, 'The session has started — please contact the organiser.');
  const reason = cleanText(input.reason, 500);
  let kind = 'normal';
  if (now >= Date.parse(session.dropout_deadline)) {
    // Attendees can't see whether they hold a spot, so everyone gives a reason after
    // the deadline. Waitlisted people hold no spot, so theirs counts as a normal dropout.
    if (reason.length < 3)
      throw new HttpError(400, 'The free drop-out window has closed. Please give a reason (e.g. illness).');
    if (await holdsSpot(env, session, reg.id)) kind = 'reason';
  }
  await env.DB.prepare('UPDATE registrations SET withdrawn_at = ?, withdraw_kind = ?, withdraw_reason = ? WHERE id = ?')
    .bind(nowISO(), kind, reason || null, reg.id)
    .run();
  return json(await statusFor(env, session, reg.id));
}

// ---------------------------------------------------------------- admin: sessions

async function adminSessions(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM registrations r WHERE r.session_id = s.id AND r.withdrawn_at IS NULL) AS count,
            (SELECT COUNT(*) FROM registrations r WHERE r.session_id = s.id AND r.withdrawn_at IS NULL AND r.selected = 1) AS selected_count
       FROM sessions s ORDER BY s.starts_at DESC`
  ).all();
  return json(results);
}

async function saveSession(env, id, input) {
  const s = {
    title: cleanText(input.title, 120) || 'Badminton',
    location: cleanText(input.location, 200),
    starts_at: cleanISO(input.starts_at, 'start time'),
    ends_at: cleanISO(input.ends_at, 'end time'),
    opens_at: cleanISO(input.opens_at, 'registration open time'),
    dropout_deadline: cleanISO(input.dropout_deadline, 'drop-out deadline'),
    capacity: Number(input.capacity),
    fee: cleanText(input.fee, 50),
    notes: cleanText(input.notes, 1000),
  };
  if (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 500) throw new HttpError(400, 'Invalid capacity');
  if (s.ends_at <= s.starts_at) throw new HttpError(400, 'End time must be after start time');
  if (s.opens_at >= s.starts_at) throw new HttpError(400, 'Registration must open before the session starts');
  if (id) {
    await getSession(env, id);
    await env.DB.prepare(
      `UPDATE sessions SET title=?, location=?, starts_at=?, ends_at=?, opens_at=?, dropout_deadline=?,
              capacity=?, fee=?, notes=? WHERE id=?`
    ).bind(s.title, s.location, s.starts_at, s.ends_at, s.opens_at, s.dropout_deadline, s.capacity, s.fee, s.notes, id).run();
    return json(await getSession(env, id));
  }
  const row = await env.DB.prepare(
    `INSERT INTO sessions (title, location, starts_at, ends_at, opens_at, dropout_deadline, capacity, fee, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(s.title, s.location, s.starts_at, s.ends_at, s.opens_at, s.dropout_deadline, s.capacity, s.fee, s.notes, nowISO()).first();
  return json(row, 201);
}

async function deleteSession(env, id) {
  await getSession(env, id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM registrations WHERE session_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function adminSessionDetail(env, id) {
  const session = await getSession(env, id);
  const cfg = await getSettings(env);
  const queue = await sessionQueue(env, session, cfg);
  return json({ session, ...queue });
}

async function adminAdd(env, id, input) {
  const session = await getSession(env, id);
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const person = await upsertPerson(env, name, email);
  const regId = await createRegistration(env, session, person, { adminAdded: true, note: cleanText(input.note, 500) });
  if (input.select) await env.DB.prepare('UPDATE registrations SET selected = 1 WHERE id = ?').bind(regId).run();
  return adminSessionDetail(env, id);
}

function idList(v) {
  if (!Array.isArray(v) || v.length > 1000 || !v.every((x) => Number.isInteger(x)))
    throw new HttpError(400, 'Invalid id list');
  return v;
}

async function saveSelection(env, id, input) {
  await getSession(env, id);
  const ids = idList(input.ids);
  const stmts = [
    env.DB.prepare('UPDATE registrations SET selected = 0 WHERE session_id = ?').bind(id),
    ...ids.map((rid) => env.DB.prepare('UPDATE registrations SET selected = 1 WHERE id = ? AND session_id = ?').bind(rid, id)),
    env.DB.prepare('UPDATE sessions SET finalised_at = COALESCE(finalised_at, ?) WHERE id = ?').bind(nowISO(), id),
  ];
  await env.DB.batch(stmts);
  return adminSessionDetail(env, id);
}

async function unfinalise(env, id) {
  await getSession(env, id);
  await env.DB.prepare('UPDATE sessions SET finalised_at = NULL WHERE id = ?').bind(id).run();
  return adminSessionDetail(env, id);
}

async function markSent(env, id, input) {
  const col = { invited: 'invited_at', payment: 'payment_requested_at' }[input.field];
  if (!col) throw new HttpError(400, 'Invalid field');
  const ids = idList(input.ids);
  const now = nowISO();
  if (ids.length)
    await env.DB.batch(
      ids.map((rid) => env.DB.prepare(`UPDATE registrations SET ${col} = ? WHERE id = ? AND session_id = ?`).bind(now, rid, id))
    );
  return adminSessionDetail(env, id);
}

async function patchRegistration(env, id, input) {
  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first();
  if (!reg) throw new HttpError(404, 'Registration not found');
  const sets = [];
  const vals = [];
  const set = (col, v) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if ('attended' in input) set('attended', input.attended === null ? null : input.attended ? 1 : 0);
  if ('invalid' in input) set('invalid', input.invalid ? 1 : 0);
  if ('selected' in input) set('selected', input.selected ? 1 : 0);
  if ('paid' in input && !!input.paid !== !!reg.paid_at) set('paid_at', input.paid ? nowISO() : null);
  if ('note' in input) set('note', cleanText(input.note, 500));
  if ('withdraw_reason' in input && !reg.withdrawn_at) {
    set('withdrawn_at', nowISO());
    set('withdraw_kind', 'admin');
    set('withdraw_reason', cleanText(input.withdraw_reason, 500) || null);
  }
  if (input.restore && reg.withdrawn_at) {
    // Restore keeps the original registration time.
    set('withdrawn_at', null);
    set('withdraw_kind', null);
    set('withdraw_reason', null);
  }
  if (sets.length) await env.DB.prepare(`UPDATE registrations SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  return adminSessionDetail(env, reg.session_id);
}

async function deleteRegistration(env, id) {
  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first();
  if (!reg) throw new HttpError(404, 'Registration not found');
  await env.DB.prepare('DELETE FROM registrations WHERE id = ?').bind(id).run();
  return adminSessionDetail(env, reg.session_id);
}

async function exportAll(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS session_id, s.starts_at AS session_start, s.title AS session_title, s.location, s.fee,
            s.capacity, s.finalised_at AS list_confirmed_at,
            p.name, p.email, r.registered_at, r.admin_added, r.selected, r.withdrawn_at, r.withdraw_kind,
            r.withdraw_reason, r.attended, r.invalid, r.invited_at, r.payment_requested_at, r.paid_at, r.note
       FROM registrations r
       JOIN sessions s ON s.id = r.session_id
       JOIN people p ON p.id = r.person_id
      ORDER BY s.starts_at, r.registered_at`
  ).all();
  return json(results);
}

// ---------------------------------------------------------------- admin: people

async function adminPeople(env) {
  const cfg = await getSettings(env);
  const [history, people] = await Promise.all([loadHistory(env), loadPeople(env)]);
  // "Next session" view: count everything finalised so far, including upcoming finalised sessions.
  const latest = history.reduce((mx, r) => Math.max(mx, Date.parse(r.starts_at)), Date.now());
  const stats = computeStats(history, latest + 1, cfg);
  const regCount = new Map();
  for (const r of history) regCount.set(r.person_id, (regCount.get(r.person_id) || 0) + 1);
  const out = [...people.values()].map((p) => {
    const st = stats.get(p.id) || blankStats();
    return { ...p, stats: st, registrations: regCount.get(p.id) || 0, priority: priorityOf(st, p.priority_adjust, cfg) };
  });
  out.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  return json(out);
}

async function patchPerson(env, id, input) {
  const p = await env.DB.prepare('SELECT * FROM people WHERE id = ?').bind(id).first();
  if (!p) throw new HttpError(404, 'Person not found');
  const name = 'name' in input ? cleanName(input.name) : p.name;
  const email = 'email' in input ? cleanEmail(input.email) : p.email;
  const notes = 'notes' in input ? cleanText(input.notes, 1000) : p.notes;
  const adj = 'priority_adjust' in input ? Number(input.priority_adjust) : p.priority_adjust;
  if (!Number.isFinite(adj)) throw new HttpError(400, 'Invalid priority adjustment');
  try {
    await env.DB.prepare('UPDATE people SET name = ?, email = ?, notes = ?, priority_adjust = ? WHERE id = ?')
      .bind(name, email, notes, adj, id)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Another person already uses that email');
    throw e;
  }
  return json({ ok: true });
}
