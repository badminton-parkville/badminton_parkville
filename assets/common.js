import { API_BASE } from '../config.js';

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let tz = 'Australia/Melbourne';
export const setTimezone = (t) => (tz = t || tz);
export const getTimezone = () => tz;

const fmt = (iso, opts) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, ...opts }).format(new Date(iso));

export const fmtDate = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtLongDate = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtTime = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
export const fmtDateTime = (iso) => `${fmtDate(iso)}, ${fmtTime(iso)}`;
export const fmtStamp = (iso) =>
  iso ? fmt(iso, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
export const fmtRange = (a, b) => `${fmtDate(a)}, ${fmtTime(a)}–${fmtTime(b)}`;

export function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

export function toast(msg, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    prompt('Copy this:', text);
  }
}

export function storage(kind = 'local') {
  const s = () => (kind === 'local' ? window.localStorage : window.sessionStorage);
  return {
    get(k, fallback = null) {
      try {
        const v = s().getItem(k);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        s().setItem(k, JSON.stringify(v));
      } catch {}
    },
    remove(k) {
      try {
        s().removeItem(k);
      } catch {}
    },
  };
}
