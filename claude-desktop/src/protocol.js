/**
 * What the browser extension may send, and what this side answers (PROTOCOL.md is the contract). Everything that
 * arrives over the socket is checked here before it is used. Nothing here touches the network or the disk.
 */
export const APP = 'configuration-companion-link';
export const VERSION = 1;
/** This extension's version (manifest.json; a test keeps them equal). Sent in the hello so the browser can offer an update. */
export const EXTENSION_VERSION = '0.3.1';
/** The on-disk format this version writes. */
export const FMT = 1;
/** What this server understands beyond the 0.2.x messages. The browser uses a feature only when it is listed. */
export const CAPS = ['id', 'key', 'follows', 'handover', 'drawn', 'requeue', 'withdraw', 'config', 'facts', 'states', 'ref'];

/** Fixed default and the fallback range, in the order the extension tries them. */
export const DEFAULT_PORT = 47615;
export const PORT_COUNT = 5;

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
export const MAX_PAGE_CHARS = 200;
export const MAX_PAGEKEY_CHARS = 300;
export const MAX_HANDOVER_CHARS = 2000;
export const MAX_KEY_CHARS = 64;
/** Largest message the socket accepts: text, a base64 picture, hand-over texts and a little framing. */
export const MAX_MESSAGE_BYTES = MAX_TEXT_BYTES * 4 + Math.ceil(MAX_PICTURE_BYTES * 4 / 3) + MAX_HANDOVER_CHARS * 8 + 8192;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/** Only a page of an installed Chrome or Edge extension may connect; with an allow-list, only those extensions. */
export function originAllowed(origin, allowed = []) {
  if (typeof origin !== 'string') return false;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!m) return false;
  return !allowed.length || allowed.includes(m[1]);
}
export const extensionIdOf = (origin) => /^chrome-extension:\/\/([a-p]{32})$/.exec(String(origin ?? ''))?.[1] ?? null;

/** The Host header of a loopback request, so a web page cannot reach this port through a name that points here. */
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const hasPrefix = (bytes, prefix) => prefix.every((b, i) => bytes[i] === b);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ID_RE = /^[0-9a-z-]{1,40}$/;

/** A reference to a sketch: its number (or a numeric string) or its id. Null when it is neither. */
export function sketchRef(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e9) return { number: v };
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d{1,9}$/.test(t) && Number(t) > 0) return { number: Number(t) };
    if (ID_RE.test(t)) return { id: t };
  }
  return null;
}

function parseFollows(f) {
  if (!isObj(f)) return { error: 'follows is not an object.' };
  const out = {};
  if (f.answers !== undefined && f.answers !== null) {
    const r = sketchRef(f.answers);
    if (!r) return { error: 'follows.answers is not a sketch number or id.' };
    out.answers = r;
  }
  if (f.corrects !== undefined) {
    if (!Array.isArray(f.corrects) || f.corrects.length > 20) return { error: 'follows.corrects is not a list of at most 20.' };
    out.corrects = [];
    for (const c of f.corrects) {
      if (!isObj(c)) return { error: 'follows.corrects holds something that is not an object.' };
      const r = sketchRef(c.sketch);
      if (!r) return { error: 'follows.corrects[].sketch is not a sketch number or id.' };
      const marks = c.marks === undefined ? [] : c.marks;
      if (!Array.isArray(marks) || marks.length > 50 || !marks.every(k => Number.isInteger(k) && k >= 1 && k <= 999)) return { error: 'follows.corrects[].marks is not a list of mark numbers.' };
      out.corrects.push({ sketch: r, marks: [...new Set(marks)] });
    }
  }
  return { follows: out };
}

function parseHandover(h) {
  if (!isObj(h)) return { error: 'handover is not an object.' };
  const out = {};
  for (const k of ['before', 'after']) {
    if (h[k] === undefined || h[k] === null) continue;
    if (typeof h[k] !== 'string') return { error: `handover.${k} is not text.` };
    const t = h[k].replace(CONTROL, ' ').slice(0, MAX_HANDOVER_CHARS).trim();
    if (t) out[k] = t;
  }
  return { handover: out };
}

/**
 * Parse and check one message. Returns { ok: false, error, unknown? } or { ok: true, type, ...fields }:
 * sketch → { sketch }, status → {}, requeue / withdraw → { ref }, config → { rev, config }.
 * `ref` (a correlation tag the answer echoes) is returned on every outcome where it could be read.
 */
export function parseMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { ok: false, error: 'Not JSON.' }; }
  if (!isObj(msg)) return { ok: false, error: 'Not an object.' };
  const tag = typeof msg.ref === 'string' && msg.ref.length <= 64 ? { tag: msg.ref } : {};
  if (msg.v !== VERSION) return { ok: false, error: 'Unknown protocol version.', ...tag };
  switch (msg.type) {
    case 'status': return { ok: true, type: 'status', ...tag };
    case 'sketch': { const r = parseSketch(msg); return { ...r, type: 'sketch', ...tag }; }
    case 'requeue':
    case 'withdraw': {
      const r = sketchRef(msg.id ?? msg.number);
      if (!r) return { ok: false, error: 'Name the sketch by id or number.', ...tag };
      return { ok: true, type: msg.type, ref: r, ...tag };
    }
    case 'config': return { ok: true, type: 'config', rev: msg.rev, config: msg.config, ...tag };
    default: return { ok: false, unknown: true, got: typeof msg.type === 'string' ? msg.type.slice(0, 40) : null, error: 'Unknown message type.', ...tag };
  }
}

function parseSketch(msg) {
  if (typeof msg.text !== 'string' || msg.text.trim() === '') return { ok: false, error: 'The sketch has no text.' };
  if (Buffer.byteLength(msg.text, 'utf8') > MAX_TEXT_BYTES) return { ok: false, error: 'The text is larger than 64 KB.' };
  let page = '';
  if (msg.page !== undefined) {
    if (typeof msg.page !== 'string') return { ok: false, error: 'The page name is not text.' };
    page = msg.page.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_CHARS);
  }
  let pageKey = '';
  if (msg.pageKey !== undefined) {
    if (typeof msg.pageKey !== 'string') return { ok: false, error: 'The page key is not text.' };
    pageKey = msg.pageKey.slice(0, MAX_PAGEKEY_CHARS);
  }
  let picture = null;
  if (msg.picture !== undefined) {
    const p = msg.picture;
    if (!isObj(p)) return { ok: false, error: 'The picture is not an object.' };
    if (p.mime !== 'image/png' && p.mime !== 'image/jpeg') return { ok: false, error: 'The picture is not a PNG or JPEG.' };
    if (typeof p.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) return { ok: false, error: 'The picture is not base64.' };
    if (Math.floor(p.data.length * 3 / 4) > MAX_PICTURE_BYTES) return { ok: false, error: 'The picture is larger than 4 MB.' };
    const bytes = Buffer.from(p.data.slice(0, 16), 'base64');
    if (!hasPrefix(bytes, p.mime === 'image/png' ? PNG : JPEG)) return { ok: false, error: 'The picture does not match its type.' };
    // `drawn` (optional): the browser drew the picture from the page layout because it had no screenshot.
    picture = { mime: p.mime, data: p.data, ...(p.drawn === true ? { drawn: true } : {}) };
  }
  const sketch = { text: msg.text, page, pageKey, picture };
  if (msg.key !== undefined && msg.key !== null) {
    if (typeof msg.key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(msg.key)) return { ok: false, error: 'The key is not 1 to 64 of A-Z, a-z, 0-9, _ and -.' };
    sketch.key = msg.key;
  }
  if (msg.follows !== undefined && msg.follows !== null) {
    const f = parseFollows(msg.follows);
    if (f.error) return { ok: false, error: f.error };
    if (f.follows.answers || f.follows.corrects?.length) sketch.follows = f.follows;
  }
  if (msg.handover !== undefined && msg.handover !== null) {
    const h = parseHandover(msg.handover);
    if (h.error) return { ok: false, error: h.error };
    if (h.handover.before || h.handover.after) sketch.handover = h.handover;
  }
  return { ok: true, sketch };
}

/** 0.2.x name, kept for tests and callers that only push sketches. */
export function parsePush(raw) {
  const r = parseMessage(raw);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.type === 'status') return { ok: true, status: true };
  if (r.type !== 'sketch') return { ok: false, error: 'Unknown message type.' };
  return { ok: true, sketch: r.sketch };
}

export const hello = (fields = {}) => JSON.stringify({ type: 'hello', app: APP, v: VERSION, version: EXTENSION_VERSION, caps: CAPS, fmt: FMT, ...fields });
export const ack = (fields) => JSON.stringify({ type: 'ack', v: VERSION, ...fields });
export const statusMessage = (status) => JSON.stringify({ type: 'status', v: VERSION, ...status });
