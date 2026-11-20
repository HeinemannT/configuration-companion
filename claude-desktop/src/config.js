/**
 * Settings: plain bounded data that changes behaviour without a new install. They come from the file
 * `<base>/.config.json` (written by a person, or by the browser extension with a `config` link message) and fall
 * back to the defaults here. Nothing in them is run: only numbers, booleans and short plain texts, each checked
 * against a bound. See PROTOCOL.md for the table.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './fsx.js';

export const CONFIG_FILE = '.config.json';
export const LEARNED_FILE = '.learned.json';
export const MAX_CONFIG_BYTES = 16 * 1024;

export const BUILT_IN_STATES = ['queued', 'taken', 'working', 'done', 'question', 'cannot', 'withdrawn'];
/** The states a chat may give with reply, built in. */
export const REPLY_STATES = ['done', 'working', 'question', 'cannot'];
/** Built-in states that count as open (not finished). */
export const OPEN_BUILT_IN = new Set(['queued', 'taken', 'working', 'question']);

export const TEXT_NAMES = ['nothingYet', 'afterSketch', 'afterDone', 'afterWorking', 'afterQuestion', 'pictureNote', 'drawnNote', 'handedBefore', 'superseded', 'intro'];

export const DEFAULTS = Object.freeze({
  wait: { default: 45, byClient: [{ match: 'claude-code', seconds: 100 }] },
  texts: {},
  states: [],
  limits: { keep: 30, keepDays: 7, replyChars: 4000, sessionHours: 12, takenMinutes: 20 },
  origins: [],
});

const LIMIT_BOUNDS = { keep: [10, 500], keepDays: [1, 90], replyChars: [200, 20000], sessionHours: [1, 168], takenMinutes: [2, 240] };
const WAIT_BOUNDS = [10, 600];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

function plainText(v, max, path) {
  if (typeof v !== 'string') return `${path} is not text.`;
  if (v.length > max) return `${path} is longer than ${max} characters.`;
  if (CONTROL.test(v)) return `${path} holds control characters.`;
  return null;
}
function numberIn(v, [lo, hi], path) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${path} is not a number.`;
  if (v < lo || v > hi) return `${path} is not between ${lo} and ${hi}.`;
  return null;
}

/**
 * Check a settings object. Returns { ok: true, config } with only the known keys (unknown ones dropped), or
 * { ok: false, error } naming the first bad field. A known key of the wrong shape refuses the whole object.
 */
export function validateConfig(raw) {
  if (!isObj(raw)) return { ok: false, error: 'The settings are not an object.' };
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(raw), 'utf8'); } catch { return { ok: false, error: 'The settings are not plain data.' }; }
  if (size > MAX_CONFIG_BYTES) return { ok: false, error: `The settings are larger than ${MAX_CONFIG_BYTES / 1024} KB.` };
  const out = {};
  let err = null;
  if (raw.wait !== undefined) {
    if (!isObj(raw.wait)) return { ok: false, error: 'wait is not an object.' };
    out.wait = {};
    if (raw.wait.default !== undefined) {
      if ((err = numberIn(raw.wait.default, WAIT_BOUNDS, 'wait.default'))) return { ok: false, error: err };
      out.wait.default = raw.wait.default;
    }
    if (raw.wait.byClient !== undefined) {
      const list = raw.wait.byClient;
      if (!Array.isArray(list) || list.length > 10) return { ok: false, error: 'wait.byClient is not a list of at most 10.' };
      out.wait.byClient = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i], p = `wait.byClient[${i}]`;
        if (!isObj(e)) return { ok: false, error: `${p} is not an object.` };
        if (typeof e.match !== 'string' || !/^[A-Za-z0-9 ._*-]{1,60}$/.test(e.match)) return { ok: false, error: `${p}.match is not 1 to 60 of letters, digits, space, . _ - *.` };
        if ((err = numberIn(e.seconds, WAIT_BOUNDS, `${p}.seconds`))) return { ok: false, error: err };
        out.wait.byClient.push({ match: e.match, seconds: e.seconds });
      }
    }
  }
  if (raw.texts !== undefined) {
    if (!isObj(raw.texts)) return { ok: false, error: 'texts is not an object.' };
    out.texts = {};
    for (const name of TEXT_NAMES) {
      if (raw.texts[name] === undefined) continue;
      if ((err = plainText(raw.texts[name], 1000, `texts.${name}`))) return { ok: false, error: err };
      out.texts[name] = raw.texts[name];
    }
  }
  if (raw.states !== undefined) {
    if (!Array.isArray(raw.states) || raw.states.length > 12) return { ok: false, error: 'states is not a list of at most 12.' };
    out.states = [];
    const seen = new Set();
    for (let i = 0; i < raw.states.length; i++) {
      const s = raw.states[i], p = `states[${i}]`;
      if (!isObj(s)) return { ok: false, error: `${p} is not an object.` };
      if (typeof s.name !== 'string' || !/^[a-z]{2,16}$/.test(s.name)) return { ok: false, error: `${p}.name is not 2 to 16 of a-z.` };
      if (BUILT_IN_STATES.includes(s.name) || seen.has(s.name)) return { ok: false, error: `${p}.name is a built-in state or given twice.` };
      if (typeof s.open !== 'boolean') return { ok: false, error: `${p}.open is not true or false.` };
      if ((err = plainText(s.word, 24, `${p}.word`))) return { ok: false, error: err };
      if (!s.word.trim()) return { ok: false, error: `${p}.word is empty.` };
      seen.add(s.name);
      out.states.push({ name: s.name, open: s.open, word: s.word });
    }
  }
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) return { ok: false, error: 'limits is not an object.' };
    out.limits = {};
    for (const [k, b] of Object.entries(LIMIT_BOUNDS)) {
      if (raw.limits[k] === undefined) continue;
      if (!isInt(raw.limits[k])) return { ok: false, error: `limits.${k} is not a whole number.` };
      if ((err = numberIn(raw.limits[k], b, `limits.${k}`))) return { ok: false, error: err };
      out.limits[k] = raw.limits[k];
    }
  }
  if (raw.origins !== undefined) {
    if (!Array.isArray(raw.origins) || raw.origins.length > 10) return { ok: false, error: 'origins is not a list of at most 10.' };
    for (let i = 0; i < raw.origins.length; i++) {
      if (typeof raw.origins[i] !== 'string' || !/^[a-p]{32}$/.test(raw.origins[i])) return { ok: false, error: `origins[${i}] is not an extension id (32 of a-p).` };
    }
    out.origins = [...new Set(raw.origins)];
  }
  return { ok: true, config: out };
}

/** The settings in force: the checked file merged over the defaults. */
export function mergeConfig(checked = {}) {
  return {
    wait: {
      default: checked.wait?.default ?? DEFAULTS.wait.default,
      byClient: checked.wait?.byClient ?? DEFAULTS.wait.byClient,
    },
    texts: { ...(checked.texts ?? {}) },
    states: checked.states ?? [],
    limits: { ...DEFAULTS.limits, ...(checked.limits ?? {}) },
    origins: checked.origins ?? [],
  };
}

/** `match` with `*` for any run, compared case-insensitively to the whole name. */
export function clientMatches(match, name) {
  const re = new RegExp(`^${String(match).toLowerCase().split('*').map(s => s.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&')).join('.*')}$`);
  return re.test(String(name ?? '').toLowerCase());
}

/** Seconds next_sketch waits for a client by the settings alone (before what was learned). */
export function configuredWait(cfg, clientName) {
  for (const e of cfg.wait.byClient) if (clientMatches(e.match, clientName)) return e.seconds;
  return cfg.wait.default;
}

/**
 * The settings of one folder, read again when the file changes. `get()` is cheap: it looks at the file's
 * time and size at most once a second.
 */
export function configStore(base, { log = () => {} } = {}) {
  const path = base ? join(base, CONFIG_FILE) : null;
  let stamp = '';
  let checkedAt = 0;
  let state = { rev: 0, at: null, by: null, config: mergeConfig(), error: null };
  function load(force = false) {
    if (!path) return state;
    const t = Date.now();
    if (!force && Math.abs(t - checkedAt) < 1000) return state;
    checkedAt = t;
    let s = '';
    try { const st = statSync(path); s = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { s = 'none'; }
    if (s === stamp) return state;
    stamp = s;
    if (s === 'none') { state = { rev: 0, at: null, by: null, config: mergeConfig(), error: null }; return state; }
    let file;
    try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { state = { ...state, error: `The settings file is not JSON: ${e?.message ?? e}` }; log(`${state.error}\n`); return state; }
    // A person may write the settings object alone, or { rev, config }.
    const body = isObj(file) && isObj(file.config) ? file.config : file;
    const rev = isObj(file) && isInt(file.rev) && file.rev >= 0 ? file.rev : 0;
    const v = validateConfig(body);
    if (!v.ok) { state = { rev: 0, at: null, by: null, config: mergeConfig(), error: v.error }; log(`The settings file is not used: ${v.error}\n`); return state; }
    state = { rev, at: typeof file.at === 'string' ? file.at : null, by: typeof file.by === 'string' ? file.by.slice(0, 100) : null, config: mergeConfig(v.config), error: null };
    return state;
  }
  return {
    get: () => load(false),
    reload: () => load(true),
    /**
     * Apply settings that came over the link. Applied only when `rev` is above the rev in force.
     * Returns { ok, rev, applied } or { ok: false, error }.
     */
    apply(rev, raw, by) {
      if (!isInt(rev) || rev < 1 || rev > Number.MAX_SAFE_INTEGER) return { ok: false, error: 'rev is not a whole number of 1 or more.' };
      const v = validateConfig(raw);
      if (!v.ok) return v;
      const cur = load(true);
      if (rev <= cur.rev) return { ok: true, rev: cur.rev, applied: false };
      if (!path) return { ok: false, error: 'This copy has no settings folder.' };
      writeJson(path, { rev, at: new Date().toISOString(), by: String(by ?? '').slice(0, 100), config: v.config });
      const now = load(true);
      return { ok: true, rev: now.rev, applied: now.rev === rev };
    },
  };
}

/**
 * Waits learned per client name, kept in `<base>/.learned.json`. A wait that the client cut (cancelled it,
 * replaced it with a newer call, or closed the connection) after at least `minCutMs` counts as a cut. Two cuts
 * whose times lie within `nearMs` of each other set the learned wait to the shorter one minus `marginMs`, never
 * below `floorMs`. The learned wait only ever shrinks; it is dropped when the settings give that client another
 * wait than the one it was learned against.
 */
export function learnedWaits(base, { minCutMs = 20_000, marginMs = 15_000, floorMs = 15_000, nearMs = 5_000 } = {}) {
  const path = base ? join(base, LEARNED_FILE) : null;
  let mem = {};
  const read = () => {
    if (!path) return mem;
    const j = readJson(path);
    return isObj(j) && isObj(j.clients) ? j.clients : {};
  };
  const write = (clients) => {
    mem = clients;
    if (path) { try { writeJson(path, { clients }); } catch { /* learning is best effort */ } }
  };
  const key = (name) => String(name ?? '').slice(0, 100) || '?';
  return {
    /** The learned wait in ms for this client against the configured ms, or null. */
    get(name, configuredMs) {
      const e = read()[key(name)];
      if (!e || typeof e.waitMs !== 'number' || e.against !== configuredMs) return null;
      return e.waitMs;
    },
    /** Record a cut. Returns the learned wait in ms when this cut changed it, else null. */
    cut(name, elapsedMs, configuredMs, currentMs) {
      if (!(elapsedMs >= minCutMs) || elapsedMs >= currentMs) return null;
      const clients = read();
      const k = key(name);
      const e = isObj(clients[k]) && clients[k].against === configuredMs ? clients[k] : { against: configuredMs, cuts: [] };
      const cuts = Array.isArray(e.cuts) ? e.cuts.filter(c => typeof c === 'number') : [];
      const near = cuts.find(c => Math.abs(c - elapsedMs) <= nearMs);
      cuts.push(Math.round(elapsedMs));
      e.cuts = cuts.slice(-4);
      let changed = null;
      if (near !== undefined) {
        const next = Math.max(floorMs, Math.min(near, elapsedMs) - marginMs);
        if (next < (typeof e.waitMs === 'number' ? e.waitMs : currentMs)) { e.waitMs = next; changed = next; }
      }
      e.at = new Date().toISOString();
      clients[k] = e;
      write(clients);
      return changed;
    },
    all: () => read(),
  };
}
