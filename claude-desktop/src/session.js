/**
 * The working session: the sketches the user sent, the states Claude gives them, and the folder on disk a person
 * (or Claude Code, or Codex) can read.
 *
 * Claude Desktop runs one to three copies of this server at once and kills them at any moment, so nothing about the
 * session lives only in memory: the folder on disk is the record, and every copy reads and writes it. Every state
 * change happens under one short-lived lock file and is written by rename, so a copy that dies leaves nothing half
 * done; a lock left by a dead copy is broken after a few seconds.
 *
 * Layout (names starting with a dot are bookkeeping):
 *   <base>/.current.json        the current session: { fmt, name, id, started, from }
 *   <base>/.numbers.json        { last, rev }: the highest sketch number ever used, and the newest revision
 *   <base>/.config.json         settings (config.js)
 *   <base>/.learned.json        waits learned per client (config.js)
 *   <base>/.bell                rewritten on every change, so a waiting copy reads one small file to know
 *   <base>/.lock                held while a state changes
 *   <base>/.copies/<copy>.json  each running copy: pid, heartbeat, last tool call, waiting or not, client
 *   <base>/2026-11-20 14-32/index.md
 *   <base>/2026-11-20 14-32/01 Supplier risk/brief.md, picture.png, reply.md
 *   <base>/2026-11-20 14-32/.sketches/1.json   the record of sketch 1
 *   <base>/2026-11-20 14-32/.keys/<key>        the number a push key was given
 *
 * A session ends only by clear(), or when a sketch arrives and the newest record is older than
 * limits.sessionHours. Sketch numbers never start again.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnce, pidAlive, readJson, replaceFile, retire, withLock, writeJson } from './fsx.js';
import { configStore, OPEN_BUILT_IN, REPLY_STATES } from './config.js';
import { EXTENSION_VERSION, FMT } from './protocol.js';

/** 0.2.x names, kept for callers: the built-in values of the settings. */
export const KEEP_DAYS = 7;
export const KEEP = 30;
export const STATES = REPLY_STATES;
export const MAX_REPLY_CHARS = 4000;

/** A waiting next_sketch reads the bell this often. Only while it waits. */
export const POLL_MS = 300;
/** A waiting next_sketch looks at the whole session this often, for sketches whose taker is gone. */
export const SCAN_MS = 5_000;
/** Each copy rewrites its heartbeat this often; more often while it waits, so a cut wait can be timed. */
export const BEAT_MS = 10_000;
export const WAIT_BEAT_MS = 1_000;
/** A copy whose heartbeat is older than this, or whose process is gone, is gone. */
export const ALIVE_MS = 30_000;
/** A copy whose process runs but which has not beaten for this long is taken as hung. */
export const HUNG_MS = 10 * 60_000;
/** A tool call this recent counts as a chat that is there (the `agent` field 0.2.x browsers read). */
export const RECENT_MS = 10 * 60_000;
/** Kept open sketches above this refuse new ones: something is wrong with the chat, and the browser says so. */
export const MAX_OPEN = 200;

const POINTER = '.current.json';
const NUMBERS = '.numbers.json';
const BELL = '.bell';
const LOCK = '.lock';
const COPIES = '.copies';
const META = '.sketches';
const KEYS = '.keys';

const pad = (n) => String(n).padStart(2, '0');
const iso = (t) => new Date(t).toISOString();
const ms = (s) => (s ? Date.parse(s) || 0 : 0);

/** Where sessions live: the user's home folder, which no cloud sync takes by default (Documents and Desktop are). */
export function defaultBase(env = process.env, home = homedir()) {
  const set = String(env.COMPANION_FOLDER ?? '').trim();
  // An unfilled manifest placeholder (a host that does not substitute user_config) counts as not set.
  return set && !set.includes('${') ? set : join(home, 'Configuration Companion', 'Sessions');
}

/** "2026-11-20 14-32": sortable, no characters Windows refuses. */
export function sessionName(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}
const SESSION_NAME = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}( \(\d+\))?$/;

export function safeName(s, max = 40) {
  // eslint-disable-next-line no-control-regex
  const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, max).trim();
  return t || 'Sketch';
}

/** Delete session folders older than `days`, never the current one. Only folders named like a session are touched. */
export function cleanOld(base, days = KEEP_DAYS, now = Date.now()) {
  const removed = [];
  let names = [];
  try { names = readdirSync(base); } catch { return removed; }
  const cur = readJson(join(base, POINTER))?.name;
  for (const name of names) {
    if (!SESSION_NAME.test(name) || name === cur) continue;
    const dir = join(base, name);
    try {
      const st = statSync(dir);
      if (st.isDirectory() && now - st.mtimeMs > days * 86_400_000) { rmSync(dir, { recursive: true, force: true }); removed.push(name); }
    } catch { /* leave it */ }
  }
  return removed;
}

const ext = (mime) => (mime === 'image/jpeg' ? 'jpg' : 'png');
const BUILT_IN_WORDS = { queued: 'waiting', taken: 'taken', working: 'working', done: 'done', question: 'question', cannot: 'could not', withdrawn: 'withdrawn' };
const clockText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Private folders of stores made without a base (tests): removed when the process ends, closed or not. */
const temps = new Set();
let tempsHooked = false;
function rememberTemp(dir) {
  temps.add(dir);
  if (tempsHooked) return;
  tempsHooked = true;
  process.on('exit', () => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
}

const numbersIn = (dir) => {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.map(n => /^(\d+)\.json$/.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
};
const legacyId = (session, n) => createHash('sha1').update(`${session}/${n}`).digest('hex').slice(0, 16);
const newId = () => randomBytes(8).toString('hex');

export class ReadOnlyError extends Error {
  constructor() { super('A newer version of Companion for Claude Desktop uses this folder; this copy only reads.'); this.code = 'READONLY'; }
}

/**
 * @param {object} o
 * @param {string|null} o.base   folder for sessions; null uses a private temporary folder, removed on close
 * @param {object} [o.config]    a configStore; by default the one of the folder
 * @param {function} [o.onDeadWait] (clientName, elapsedMs) for a copy found dead while it waited (its wait was cut)
 */
export function createSession({
  base = null, now = () => new Date(), config = null, onDeadWait = () => {},
  aliveMs = ALIVE_MS, pollMs = POLL_MS, scanMs = SCAN_MS, beatMs = BEAT_MS, waitBeatMs = WAIT_BEAT_MS, lockWaitMs = 3_000,
} = {}) {
  const temp = !base;
  const root = base ?? mkdtempSync(join(tmpdir(), 'companion-session-'));
  if (temp) rememberTemp(root);
  const settings = config ?? configStore(root);
  const cfg = () => settings.get().config;
  const copy = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const P = {
    pointer: join(root, POINTER), numbers: join(root, NUMBERS), bell: join(root, BELL), lock: join(root, LOCK), copies: join(root, COPIES),
  };
  const mine = { copy, pid: process.pid, version: EXTENSION_VERSION, beat: 0, at: 0, waiting: 0, waitStart: 0, client: null, wait: null };
  const waiters = [];
  let lastRev = 0;
  let closed = false;
  const t = () => Date.now();

  // ---- copies ----

  function beat() {
    if (closed) return;
    mine.beat = t();
    try { mkdirSync(P.copies, { recursive: true }); writeJson(join(P.copies, `${copy}.json`), mine); } catch { /* a heartbeat is best effort */ }
  }
  function readCopies() {
    let names = [];
    try { names = readdirSync(P.copies); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const c = readJson(join(P.copies, n));
      if (c && typeof c.beat === 'number') out.push({ ...c, copy: c.copy ?? n.slice(0, -5), file: n });
    }
    return out;
  }
  /**
   * A copy is alive while its process runs (all copies run on this computer). Its heartbeat decides only when the
   * file names no process, or when it stopped beating for HUNG_MS: a computer waking from sleep finds every
   * heartbeat old, and that must not hand its sketches to another chat.
   */
  const isAliveCopy = (c, at = t()) => !!c && (c.copy === copy
    || (Number.isInteger(c.pid) ? pidAlive(c.pid) && Math.abs(at - c.beat) < HUNG_MS : Math.abs(at - c.beat) < aliveMs));
  /** Copies by id, and which are alive. Dead copies' files are removed, after what their waits tell is learned. */
  function survey(sweep) {
    const at = t();
    const all = readCopies();
    const alive = new Set([copy]);
    for (const c of all) {
      if (isAliveCopy(c, at)) { alive.add(c.copy); continue; }
      if (!sweep) continue;
      // Only the copy that removes the file learns from it, so a cut wait counts once.
      if (retire(join(P.copies, c.file)) && c.waiting > 0 && c.waitStart > 0 && c.beat > c.waitStart) {
        try { onDeadWait(c.client?.name ?? '', c.beat - c.waitStart); } catch { /* learning is best effort */ }
      }
    }
    return { all, alive };
  }

  const touch = () => { mine.at = t(); beat(); };
  const setClient = (info, waitSeconds) => {
    mine.client = { name: String(info?.name ?? '').slice(0, 100), version: String(info?.version ?? '').slice(0, 100) };
    if (waitSeconds !== undefined) mine.wait = waitSeconds;
    beat();
  };

  // ---- the current session ----

  function pointer() {
    const p = readJson(P.pointer);
    if (!p || typeof p.name !== 'string' || !SESSION_NAME.test(p.name)) return null;
    return p;
  }
  function current() {
    const p = pointer();
    if (!p) return null;
    const dir = join(root, p.name);
    if (!existsSync(dir)) return null;
    return { name: p.name, dir, id: typeof p.id === 'string' ? p.id : `s-${legacyId(p.name, 0).slice(0, 12)}`, started: new Date(p.started ?? Date.now()), from: Number(p.from) || 0, fmt: Number(p.fmt) || 1, legacy: !p.fmt };
  }
  const readOnly = () => { const p = readJson(P.pointer); return !!p && Number(p.fmt) > FMT; };
  const locked = (fn, waitMs = lockWaitMs) => { mkdirSync(root, { recursive: true }); return withLock(P.lock, fn, { waitMs }); };
  const readNumbers = () => { const j = readJson(P.numbers); return { last: Number(j?.last) || 0, rev: Number(j?.rev) || 0 }; };

  /** A revision above every one made before, here or in another copy, also when the clock went back. Under the lock. */
  function nextRev(after = 0) {
    const n = readNumbers();
    const r = Math.max(t(), n.rev + 1, lastRev + 1, after + 1);
    lastRev = r;
    return r;
  }
  /**
   * Record that revision `rev` is now visible. Written after the record that carries it, never before: a status
   * that reports a rev then always shows the rows of that rev (a soak run caught a status that was ahead of its row).
   */
  const publishRev = (rev) => { const n = readNumbers(); if (rev > n.rev) writeJson(P.numbers, { ...n, rev }); };
  function ring(rev) { try { replaceFile(P.bell, `${rev}-${randomBytes(3).toString('hex')}`); } catch { /* waiters still scan */ } }
  const readBell = () => { try { return readFileSync(P.bell, 'utf8'); } catch { return ''; } };

  /** The highest sketch number in any session folder still on disk. Read only when a session starts. */
  function highestOnDisk() {
    let best = 0;
    let names = [];
    try { names = readdirSync(root); } catch { return 0; }
    for (const name of names) if (SESSION_NAME.test(name)) best = Math.max(best, numbersIn(join(root, name, META)).at(-1) ?? 0);
    return best;
  }

  /** Start a new session folder and point at it. Under the lock. */
  function startSession() {
    mkdirSync(root, { recursive: true });
    const from = Math.max(readNumbers().last, highestOnDisk());
    const startedAt = now();
    const first = sessionName(startedAt);
    let name = first, k = 1;
    for (;;) { try { mkdirSync(join(root, name)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; name = `${first} (${++k})`; } }
    writeJson(P.pointer, { fmt: FMT, name, id: `s-${newId().slice(0, 12)}`, started: startedAt.toISOString(), from });
    return current();
  }

  // ---- records ----

  const metaPath = (f, n) => join(f.dir, META, `${n}.json`);
  const cache = new Map(); // path -> { stamp, meta }
  /** A record as on disk. `fresh` skips the cache (always, under the lock). */
  function readMeta(f, n, fresh = false) {
    const path = metaPath(f, n);
    if (!fresh) {
      let stamp;
      try { const st = statSync(path); stamp = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { cache.delete(path); return null; }
      const c = cache.get(path);
      if (c && c.stamp === stamp) return structuredClone(c.meta);
      const m = readJson(path);
      if (!m || m.number !== n) return null;
      cache.set(path, { stamp, meta: m });
      return structuredClone(m);
    }
    const m = readJson(path);
    return m && m.number === n ? m : null;
  }
  const writeMeta = (f, m) => { writeJson(metaPath(f, m.number), m); publishRev(m.rev); };
  const idOf = (f, m) => m.id ?? legacyId(f.name, m.number);
  const handedOf = (m) => (typeof m.handed === 'number' ? m.handed : m.state === 'queued' || m.state === 'adding' ? 0 : 1);

  function openSet() {
    const s = new Set(OPEN_BUILT_IN);
    for (const st of cfg().states) if (st.open) s.add(st.name);
    return s;
  }
  const knownReplyStates = () => [...REPLY_STATES, ...cfg().states.map(s => s.name)];
  const wordOf = (state) => cfg().states.find(s => s.name === state)?.word ?? null;

  /** The kept records, oldest first: every open one, and the newest `keep`. One still being written is left out. */
  function keptMetas(f, fresh = false) {
    const nums = numbersIn(join(f.dir, META));
    const keep = cfg().limits.keep;
    const open = openSet();
    const out = [];
    nums.forEach((n, i) => {
      const m = readMeta(f, n, fresh);
      if (!m || m.state === 'adding') return;
      if (open.has(m.state) || i >= nums.length - keep) out.push(m);
    });
    return out;
  }

  function hydrate(f, m, withPicture) {
    let picture = null;
    if (m.mime) {
      picture = { mime: m.mime, ...(m.drawn ? { drawn: true } : {}) };
      if (withPicture) {
        try { picture.data = readFileSync(join(f.dir, m.dir, `picture.${ext(m.mime)}`)).toString('base64'); }
        catch { picture = null; }
      }
    }
    return {
      id: idOf(f, m), number: m.number, at: new Date(m.at), text: m.text, page: m.page, pageKey: m.pageKey, picture, state: m.state,
      open: openSet().has(m.state), word: wordOf(m.state), rev: m.rev,
      reply: m.reply ? { text: m.reply.text, at: new Date(m.reply.at) } : null,
      handed: handedOf(m), requeued: m.requeued ?? 0, takenAt: m.takenAt ? new Date(m.takenAt) : null, takenBy: m.takenBy ?? null,
      lastTakenAt: m.lastTakenAt ? new Date(m.lastTakenAt) : null,
      follows: m.follows ?? null, handover: m.handover ?? null, history: m.history ?? [], key: m.key ?? null,
      dir: join(f.dir, m.dir), session: f.id,
    };
  }

  /** index.md, rebuilt from the records. Best effort: the records are what counts. */
  function writeIndex(f) {
    try {
      const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
      const rows = keptMetas(f).map(s => `| ${pad(s.number)} | ${clockText(new Date(s.at))} | ${cell(s.page) || '-'} | ${wordOf(s.state) ?? BUILT_IN_WORDS[s.state] ?? s.state} | ${cell(s.reply?.text).slice(0, 80)} |`);
      replaceFile(join(f.dir, 'index.md'), [
        `# Working session ${sessionName(f.started)}`,
        '',
        'Sketches sent from Configuration Companion, oldest first. Each folder holds brief.md, picture.png when there is one, and reply.md once Claude has answered.',
        `These files stay on this computer and are deleted after ${cfg().limits.keepDays} days.`,
        '',
        '| No. | Sent | Page | State | Reply |',
        '| --- | --- | --- | --- | --- |',
        ...rows, '',
      ].join('\n'));
    } catch { /* the records are what counts */ }
  }

  /** Back to waiting, with what it had kept in its history. Under the lock; the caller writes. */
  function backToQueue(m, why) {
    m.history = [...(m.history ?? []), { state: m.state, reply: m.reply ?? null, at: iso(t()), why }].slice(-5);
    m.lastTakenAt = m.takenAt ?? m.lastTakenAt ?? null;
    m.state = 'queued';
    m.reply = null;
    m.takenBy = null;
    m.takenAt = null;
    m.workingAt = null;
    m.requeued = (m.requeued ?? 0) + 1;
    if (typeof m.handed !== 'number') m.handed = 1;
  }

  /** Requeue what lost its taker or its time. Under the lock. Returns true when something changed. */
  function sweepTaken(f, metas, alive) {
    const at = t();
    const limit = cfg().limits.takenMinutes * 60_000;
    let changed = false;
    for (const m of metas) {
      if (m.state !== 'taken' && m.state !== 'working') continue;
      const since = Math.max(ms(m.takenAt), ms(m.workingAt), ms(m.reply?.at));
      if (since - at > 60_000) {           // the clock went back: count from now
        m.takenAt = iso(at); if (m.workingAt) m.workingAt = iso(at);
        m.rev = nextRev(m.rev); writeMeta(f, m); changed = true; continue;
      }
      const gone = m.state === 'taken' && !alive.has(m.takenBy?.copy);
      if (gone || at - since > limit) {
        backToQueue(m, gone ? 'taker gone' : 'no answer in time');
        m.rev = nextRev(m.rev);
        writeMeta(f, m);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Hand out a sketch, or null. Under the lock: requeue what lost its taker; with `rehand`, give this copy again the
   * sketch it took and did not answer (once per take); else the oldest waiting sketch.
   */
  function take({ rehand }) {
    if (readOnly()) throw new ReadOnlyError();
    const f0 = current();
    if (!f0) { survey(true); return null; }
    return locked(() => {
      const f = current();
      if (!f) return null;
      const { alive } = survey(true);
      const metas = keptMetas(f, true);
      let changed = sweepTaken(f, metas, alive);
      const finish = (m, extra) => {
        writeMeta(f, m); ring(m.rev); writeIndex(f);
        return { sketch: hydrate(f, m, true), ...extra };
      };
      if (rehand) {
        const own = metas.find(m => m.state === 'taken' && m.takenBy?.copy === copy && (m.takenBy.rehands ?? 0) < 1);
        if (own) {
          own.lastTakenAt = own.takenAt;
          own.takenBy = { ...own.takenBy, rehands: (own.takenBy.rehands ?? 0) + 1, at: iso(t()) };
          own.takenAt = iso(t());
          own.handed = handedOf(own) + 1;
          own.rev = nextRev(own.rev);
          return finish(own, { rehand: true, handedBefore: true });
        }
      }
      const m = metas.filter(x => x.state === 'queued').sort((a, b) => a.number - b.number)[0];
      if (!m) { if (changed) { ring(lastRev); writeIndex(f); } return null; }
      const before = handedOf(m);
      m.state = 'taken';
      m.takenBy = { copy, client: mine.client?.name ?? '', at: iso(t()), rehands: 0 };
      m.takenAt = iso(t());
      m.handed = before + 1;
      m.rev = nextRev(m.rev);
      return finish(m, { handedBefore: before > 0 });
    });
  }
  const tryTake = (o) => { try { return take(o); } catch (e) { if (e?.code === 'READONLY') throw e; return null; } };

  /** Put back a sketch this copy just took and could not hand over (its call was cancelled at that moment). */
  function untake(number) {
    try {
      locked(() => {
        const f = current();
        const m = f && readMeta(f, number, true);
        if (!m || m.state !== 'taken' || m.takenBy?.copy !== copy) return;
        m.state = 'queued'; m.takenBy = null; m.takenAt = null;
        m.handed = Math.max(0, handedOf(m) - 1);
        m.rev = nextRev(m.rev);
        writeMeta(f, m); ring(m.rev); writeIndex(f);
      });
    } catch { /* the sweep requeues it when this copy is gone, the re-hand gives it again otherwise */ }
  }

  /** Find a record of the current session by { number } or { id }. Fresh. */
  function find(f, ref) {
    if (ref.number !== undefined) { const m = readMeta(f, ref.number, true); return m && m.state !== 'adding' ? m : null; }
    for (const n of numbersIn(join(f.dir, META)).reverse()) {
      const m = readMeta(f, n, true);
      if (m && m.state !== 'adding' && idOf(f, m) === ref.id) return m;
    }
    return null;
  }

  function newestRecordAt(f) {
    let best = f.started.getTime();
    const nums = numbersIn(join(f.dir, META));
    for (const n of nums.slice(-50)) {
      const m = readMeta(f, n);
      if (m) best = Math.max(best, ms(m.at), ms(m.takenAt), ms(m.reply?.at), ms(m.workingAt));
    }
    return best;
  }

  beat();
  const heart = setInterval(beat, beatMs);
  heart.unref?.();

  return {
    copy,
    /**
     * Keep a checked sketch at the end of the queue. Returns { sketch, duplicate }. Throws when the disk refuses
     * it, or with code FULL when too many sketches are open.
     */
    add(sketch) {
      if (readOnly()) throw new ReadOnlyError();
      const at = now();
      const picture = sketch.picture ?? null;
      const keyHit = (f) => {
        if (!sketch.key) return null;
        const n = Number(readJson(join(f.dir, KEYS, sketch.key))?.number);
        const m = n ? readMeta(f, n, true) : null;
        return m && m.state !== 'adding' ? m : null;
      };
      // 1. Under the lock: the session (a new one when there is none or it went idle), the number, the record.
      const reserved = locked(() => {
        let f = current();
        if (f) {
          const hit = keyHit(f);
          if (hit) return { f, dup: hit };
          if (t() - newestRecordAt(f) > cfg().limits.sessionHours * 3_600_000) f = null;
        }
        if (!f) f = startSession();
        mkdirSync(join(f.dir, META), { recursive: true });
        const open = openSet();
        const openCount = keptMetas(f, true).filter(m => open.has(m.state)).length;
        if (openCount >= MAX_OPEN) { const e = new Error(`${openCount} sketches wait for Claude already. Ask Claude to work through them, or clear the session.`); e.code = 'FULL'; throw e; }
        const nums = readNumbers();
        let n = Math.max(nums.last, f.from, numbersIn(join(f.dir, META)).at(-1) ?? 0) + 1;
        while (existsSync(metaPath(f, n))) n++;
        writeJson(P.numbers, { ...readNumbers(), last: n });
        const m = {
          number: n, id: newId(), at: at.toISOString(), text: sketch.text, page: sketch.page ?? '', pageKey: sketch.pageKey ?? '',
          mime: picture?.mime ?? null, ...(picture?.drawn ? { drawn: true } : {}), state: 'adding', reply: null, rev: nextRev(),
          dir: `${pad(n)} ${safeName(sketch.page)}`, handed: 0, requeued: 0,
          ...(sketch.key ? { key: sketch.key } : {}), ...(sketch.follows ? { follows: sketch.follows } : {}), ...(sketch.handover ? { handover: sketch.handover } : {}),
        };
        if (!createOnce(metaPath(f, n), m)) throw new Error('The sketch number was taken meanwhile.');
        return { f, m };
      });
      if (reserved.dup) return { sketch: { ...hydrate(reserved.f, reserved.dup, false), picture: reserved.dup.mime ? { mime: reserved.dup.mime } : null }, duplicate: true };
      const { f, m } = reserved;
      // 2. The files, outside the lock (a picture can be a few MB).
      const dir = join(f.dir, m.dir);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'brief.md'), `${m.text}\n`);
        if (picture) writeFileSync(join(dir, `picture.${ext(picture.mime)}`), Buffer.from(picture.data, 'base64'));
      } catch (e) { retire(metaPath(f, m.number)); throw e; }
      // 3. Offered only now that its files are there. A push with the same key that finished meanwhile wins.
      const done = locked(() => {
        const hit = keyHit(f);
        if (hit) { retire(metaPath(f, m.number)); try { rmSync(dir, { recursive: true, force: true }); } catch { /* left */ } return { dup: hit }; }
        if (sketch.key) { mkdirSync(join(f.dir, KEYS), { recursive: true }); writeJson(join(f.dir, KEYS, sketch.key), { number: m.number }); }
        m.state = 'queued';
        m.rev = nextRev(m.rev);
        writeMeta(f, m); ring(m.rev); writeIndex(f);
        return { m };
      });
      if (done.dup) return { sketch: { ...hydrate(f, done.dup, false), picture: done.dup.mime ? { mime: done.dup.mime } : null }, duplicate: true };
      for (const w of [...waiters]) w.poke(true);
      return { sketch: { ...hydrate(f, done.m, false), picture }, duplicate: false };
    },
    /** The newest sketch, or the one with this number when it is in the current session. */
    get(number) {
      const f = current();
      if (!f) return undefined;
      if (number === undefined) { const k = keptMetas(f); const m = k.reduce((a, b) => (!a || b.number > a.number ? b : a), null); return m ? hydrate(f, m, true) : undefined; }
      const m = readMeta(f, number);
      return m && m.state !== 'adding' ? hydrate(f, m, true) : undefined;
    },
    /** The kept sketches, newest first. */
    list() { const f = current(); return f ? keptMetas(f).reverse().map(m => hydrate(f, m, false)) : []; },
    size() { const f = current(); return f ? keptMetas(f).length : 0; },
    queued() { const f = current(); return f ? keptMetas(f).filter(m => m.state === 'queued').length : 0; },
    /**
     * Wait up to `ms` for a sketch. A new call ends this copy's older wait first ({ cut: 'superseded' }); a cancel
     * ends it with { cut: 'aborted' }, closing the copy with { cut: 'closed' }; a cut wait never takes a sketch.
     * Resolves { sketch, handedBefore, rehand } or {} when time runs out.
     */
    next(waitMs, signal) {
      for (const w of [...waiters]) w.cut('superseded');
      touch();
      if (signal?.aborted) return Promise.resolve({ cut: 'aborted', elapsed: 0 });
      let got = null;
      try { got = take({ rehand: true }); } catch (e) { if (e?.code !== 'LOCKED') return Promise.reject(e); }
      if (got) return Promise.resolve(got);
      return new Promise((resolve, reject) => {
        const start = t();
        let done = false;
        let bell = readBell();
        let scanned = start;
        const w = {
          poke(force) {
            if (done) return;
            const b = readBell();
            if (!force && b === bell && Math.abs(t() - scanned) < scanMs) return;
            bell = b; scanned = t();
            let s = null;
            try { s = tryTake({ rehand: false }); } catch (e) { finish(null, e); return; }
            if (s) finish(s);
          },
          cut: (why) => finish({ cut: why, elapsed: t() - start }),
        };
        const poll = setInterval(() => w.poke(false), pollMs);
        const quick = setInterval(beat, waitBeatMs);
        const timer = setTimeout(() => finish({}), waitMs);
        const onAbort = () => finish({ cut: 'aborted', elapsed: t() - start });
        function finish(value, error) {
          if (done) return;
          done = true;
          clearInterval(poll); clearInterval(quick); clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          mine.waiting = waiters.length;
          if (!waiters.length) mine.waitStart = 0;
          touch();
          if (error) reject(error); else resolve(value);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(w);
        mine.waiting = waiters.length;
        mine.waitStart = start;
        beat();
      });
    },
    untake,
    /** Look for copies that died; learn from their cut waits. Called before a wait is chosen. */
    sweep() { try { survey(true); } catch { /* best effort */ } },
    /** next() calls waiting in this copy. */
    waiting: () => waiters.length,
    /** The states reply accepts now. */
    replyStates: knownReplyStates,
    /**
     * Record Claude's answer. Returns { sketch, cut } or { error: 'unknown' | 'not-handed' | 'withdrawn' }.
     * `chain`: a reply carried over to the sketch a follow-up answers.
     */
    reply(number, status, text, { chain = false } = {}) {
      if (readOnly()) throw new ReadOnlyError();
      touch();
      const max = cfg().limits.replyChars;
      const words = String(text ?? '');
      return locked(() => {
        const f = current();
        const m = f && readMeta(f, number, true);
        if (!m || m.state === 'adding') return { error: 'unknown' };
        if (m.state === 'withdrawn') return { error: 'withdrawn', sketch: hydrate(f, m, false) };
        if (!chain && handedOf(m) === 0) return { error: 'not-handed', sketch: hydrate(f, m, false) };
        m.state = status;
        m.reply = { text: words.slice(0, max), at: now().toISOString() };
        if (status === 'working') m.workingAt = m.reply.at;
        m.rev = nextRev(m.rev);
        writeMeta(f, m);
        try { writeFileSync(join(f.dir, m.dir, 'reply.md'), `Status: ${m.state}\n\n${m.reply.text}\n`); } catch { /* the record is what counts */ }
        ring(m.rev); writeIndex(f);
        return { sketch: hydrate(f, m, false), cut: words.length > max ? max : 0 };
      }, 6_000);
    },
    /** "Send again" from the browser: back to waiting, from any state but waiting. */
    requeue(ref) {
      if (readOnly()) throw new ReadOnlyError();
      return locked(() => {
        const f = current();
        const m = f && find(f, ref);
        if (!m) return { ok: false, error: 'That sketch is not in this session.' };
        if (m.state === 'queued') return { ok: true, id: idOf(f, m), number: m.number, state: 'queued' };
        backToQueue(m, 'sent again');
        m.rev = nextRev(m.rev);
        writeMeta(f, m); ring(m.rev); writeIndex(f);
        for (const w of [...waiters]) setImmediate(() => w.poke(true));
        return { ok: true, id: idOf(f, m), number: m.number, state: 'queued' };
      });
    },
    /** The user withdrew a sketch no chat has taken. */
    withdraw(ref) {
      if (readOnly()) throw new ReadOnlyError();
      return locked(() => {
        const f = current();
        const m = f && find(f, ref);
        if (!m) return { ok: false, error: 'That sketch is not in this session.' };
        if (m.state !== 'queued') return { ok: false, error: `Sketch ${m.number} is ${BUILT_IN_WORDS[m.state] ?? m.state} already.`, id: idOf(f, m), number: m.number, state: m.state };
        m.state = 'withdrawn';
        m.rev = nextRev(m.rev);
        writeMeta(f, m); ring(m.rev); writeIndex(f);
        return { ok: true, id: idOf(f, m), number: m.number, state: 'withdrawn' };
      });
    },
    touch,
    setClient,
    settings,
    folder: () => current()?.dir ?? null,
    base: () => (temp ? null : root),
    session: () => current()?.id ?? null,
    readOnly,
    /** Delete this session's folder and forget its sketches, for every copy. Numbers go on. Returns how many were cleared. */
    clear() {
      if (readOnly()) throw new ReadOnlyError();
      return locked(() => {
        const f = current();
        if (!f) return 0;
        const count = keptMetas(f, true).length;
        const top = numbersIn(join(f.dir, META)).at(-1) ?? 0;
        const n = readNumbers();
        writeJson(P.numbers, { ...n, last: Math.max(n.last, top) });
        retire(P.pointer);
        try { rmSync(f.dir, { recursive: true, force: true }); } catch { /* ignore */ }
        const r = nextRev();
        publishRev(r);
        ring(r);
        return count;
      });
    },
    /** The facts the browser is told. No briefs, no pictures. */
    status() {
      const f = current();
      const metas = f ? keptMetas(f) : [];
      const at = t();
      const { all, alive } = survey(false);
      const copies = all.map(c => ({
        copy: c.copy, client: c.client?.name ?? '', alive: alive.has(c.copy), waiting: c.copy === copy ? waiters.length : (c.waiting ?? 0),
        beatAt: c.beat ? iso(c.beat) : null, lastCallAt: c.at ? iso(c.at) : null, ...(typeof c.wait === 'number' ? { wait: c.wait } : {}),
      }));
      const waitersAll = copies.filter(c => c.alive).reduce((a, c) => a + c.waiting, 0);
      const lastCall = Math.max(mine.at, ...all.map(c => c.at || 0));
      const rev = Math.max(readNumbers().rev, ...metas.map(m => m.rev || 0), 0);
      const open = openSet();
      return {
        rev,
        agent: waitersAll > 0 ? 'waiting' : lastCall && Math.abs(at - lastCall) < RECENT_MS ? 'recent' : 'none',
        session: f?.id ?? null,
        waiters: waitersAll,
        lastCallAt: lastCall ? iso(lastCall) : null,
        copies,
        sketches: metas.map(s => ({
          id: idOf(f, s), number: s.number, at: s.at, page: s.page, pageKey: s.pageKey, state: s.state, open: open.has(s.state), rev: s.rev,
          ...(wordOf(s.state) ? { word: wordOf(s.state) } : {}),
          handed: handedOf(s), requeued: s.requeued ?? 0,
          ...((s.state === 'taken' || s.state === 'working') && s.takenBy ? { takenAt: s.takenAt, takenBy: { copy: s.takenBy.copy, client: s.takenBy.client ?? '', alive: alive.has(s.takenBy.copy) } } : {}),
          ...(s.reply ? { reply: { text: s.reply.text, at: s.reply.at } } : {}),
        })),
      };
    },
    /** Stop this copy: its waits end, its heartbeat file goes. The session stays. */
    close() {
      for (const w of [...waiters]) w.cut('closed');
      clearInterval(heart);
      closed = true;
      retire(join(P.copies, `${copy}.json`));
      if (temp) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } temps.delete(root); }
    },
  };
}
