/**
 * Point and tell: where marks live. The page's sessionStorage, one entry per page (this browser tab,
 * gone when the tab closes, the same place Blueprint keeps its edit target and its resume note). Reading
 * is defensive: storage may be blocked, hold another version, or hold anything at all.
 */
import type { PtArrow, PtSide, PtCopySnapshot, PtDraft, PtGridPlace, PtInk, PtMark, PtMeaning, PtOp, PtRawPlace, PtWidgetKind, PtPlace, PtPoint, PtRefEntry, PtSent, PtSketchRef } from './types';

export const MARKS_KEY = 'crev_pt_marks:';
export const COPY_KEY = 'crev_pt_copy:';
export const STAGE_KEY = 'crev_pt_stage:';
export const STAGED_KEY = 'crev_pt_staged:';
/** A stash for "stage in Blueprint" is read once within this time, or dropped. */
export const STAGE_TTL_MS = 60_000;
const VERSION = 1;

export interface MarkSet { marks: PtMark[]; next: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function place(v: unknown): PtPlace | null {
  if (!isObj(v)) return null;
  if (str(v.before) && v.before) return { before: v.before };
  if (str(v.after) && v.after) return { after: v.after };
  if (str(v.into) && v.into) return { into: v.into };
  return null;
}

function meaning(v: unknown): PtMeaning | undefined {
  if (!isObj(v)) return undefined;
  const words = str(v.words) ? { words: v.words } : {};
  if (v.kind === 'move') { const to = place(v.to); return to ? { kind: 'move', to, ...(finite(v.columns) ? { columns: v.columns } : {}), ...words } : undefined; }
  if (v.kind === 'add') {
    const p = place(v.place);
    const widget: PtWidgetKind | undefined = v.widget === 'table' || v.widget === 'chart' || v.widget === 'button' || v.widget === 'text' ? v.widget : undefined;
    const types = widget && Array.isArray(v.types) && v.types.length && v.types.every(str) ? { types: v.types as string[] } : {};
    return p ? { kind: 'add', place: p, ...(finite(v.columns) ? { columns: v.columns } : {}), ...(widget ? { widget, ...types } : {}), ...(v.tab === true ? { tab: true as const } : {}), ...(v.page === true ? { page: true as const } : {}), ...words } : undefined;
  }
  // Marks kept by an earlier version say `delete` for what is now `crossed`.
  if (v.kind === 'crossed' || v.kind === 'delete') return { kind: 'crossed' };
  if (v.kind === 'change') return { kind: 'change' };
  return undefined;
}

function grid(v: unknown): PtGridPlace {
  if (!isObj(v)) return {};
  return {
    ...(str(v.tabId) ? { tabId: v.tabId } : {}),
    ...(str(v.containerId) ? { containerId: v.containerId } : {}),
    ...(finite(v.row) ? { row: v.row } : {}),
    ...(finite(v.col) ? { col: v.col } : {}),
    ...(finite(v.cols) ? { cols: v.cols } : {}),
    ...(Array.isArray(v.over) ? { over: v.over.filter(str) } : {}),
  };
}

function arrowOf(v: unknown): PtArrow | undefined {
  if (!isObj(v)) return undefined;
  const n = v.near, sides: PtSide[] = ['above', 'below', 'left of', 'right of'];
  const near = isObj(n) && str(n.id) && n.id && sides.includes(n.side as PtSide) ? { near: { id: n.id, side: n.side as PtSide } } : {};
  return { ...(str(v.from) && v.from ? { from: v.from } : {}), ...(str(v.to) && v.to ? { to: v.to } : {}), ...(isObj(v.end) ? { end: grid(v.end) } : {}), ...near };
}

function ink(v: unknown): PtInk | undefined {
  if (!isObj(v) || !Array.isArray(v.strokes)) return undefined;
  const strokes = v.strokes.flatMap(s => {
    if (!isObj(s) || !Array.isArray(s.points)) return [];
    const raw = s.points as unknown[];
    const points = raw.filter((p): p is PtPoint => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])).map(p => [p[0], p[1]] as PtPoint);
    // The radii go with the points: kept only when there is one for each.
    const r = Array.isArray(s.r) && s.r.length === raw.length && s.r.every(finite) ? (s.r as number[]) : null;
    return points.length ? [{ points, ...(r && points.length === raw.length ? { r } : {}) }] : [];
  });
  const a = v.anchor;
  const anchor = isObj(a) && str(a.id) && a.id && isObj(a.box) && finite(a.box.left) && finite(a.box.top) && finite(a.box.width) && finite(a.box.height)
    ? { id: a.id, box: { left: a.box.left, top: a.box.top, width: a.box.width, height: a.box.height } } : undefined;
  return strokes.length ? { strokes, place: grid(v.place), ...(anchor ? { anchor } : {}) } : undefined;
}

const posInt = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 1;
const sketchRef = (v: unknown): PtSketchRef | null => (isObj(v) && posInt(v.sketch) && finite(v.at)
  ? { sketch: v.sketch, at: v.at, ...(typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) ? { id: v.id } : {}) } : null);

function sentOf(v: unknown): PtSent | undefined {
  const ref = sketchRef(v);
  if (!ref || !isObj(v) || !posInt(v.k) || !str(v.sig)) return undefined;
  const a = v.answer, ar = sketchRef(a);
  const answer = ar && isObj(a) && str(a.text) ? { ...ar, text: a.text, ...(posInt(a.asks) ? { asks: a.asks } : {}) } : undefined;
  return { ...ref, k: v.k, sig: v.sig, ...(answer ? { answer } : {}) };
}

/** One stored mark, or null when it is not one. Unknown fields are dropped. */
export function decodeMark(v: unknown): PtMark | null {
  if (!isObj(v) || !finite(v.n) || !Number.isInteger(v.n) || v.n < 1) return null;
  const m: PtMark = {
    n: v.n,
    text: str(v.text) ? v.text : '',
    targets: Array.isArray(v.targets) ? v.targets.filter(str) : [],
    at: finite(v.at) ? v.at : 0,
  };
  const mean = meaning(v.meaning); if (mean) m.meaning = mean;
  if (str(v.reading) && v.reading) m.reading = v.reading;
  if (v.pointer === true) m.pointer = true;
  const arrow = arrowOf(v.arrow); if (arrow) m.arrow = arrow;
  const i = ink(v.ink); if (i) m.ink = i;
  if (v.staged === true) m.staged = true;
  const sent = sentOf(v.sent); if (sent) m.sent = sent;
  return m;
}

export function encodeMarks(set: MarkSet): string {
  return JSON.stringify({ v: VERSION, next: set.next, marks: set.marks });
}

/** The marks stored text holds; an empty set for anything unreadable or of another version. */
export function decodeMarks(raw: string | null): MarkSet {
  const empty: MarkSet = { marks: [], next: 1 };
  if (!raw) return empty;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!isObj(j) || j.v !== VERSION || !Array.isArray(j.marks)) return empty;
    const marks = j.marks.map(decodeMark).filter((m): m is PtMark => m !== null);
    const seen = new Set<number>();
    const unique = marks.filter(m => !seen.has(m.n) && seen.add(m.n));
    const top = unique.reduce((a, m) => Math.max(a, m.n), 0);
    return { marks: unique, next: Math.max(finite(j.next) ? Math.floor(j.next) : 1, top + 1) };
  } catch { return empty; }
}

function read(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string | null): boolean {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); return true; }
  catch { return false; }
}

/** The storage key of the marks of a page that does not exist yet, drawn while looking at `viewedRid`. */
export const newPageKey = (viewedRid: string): string => `new:${viewedRid}`;

export function loadMarks(pageRid: string): MarkSet { return decodeMarks(read(MARKS_KEY + pageRid)); }
/** False when the browser refused to store (blocked, full): the marks then live only in memory. */
export function saveMarks(pageRid: string, set: MarkSet): boolean {
  return write(MARKS_KEY + pageRid, set.marks.length ? encodeMarks(set) : null);
}

// ── The copy snapshot ───────────────────────────────────────────────────────────────────────────

function refEntry(v: unknown): PtRefEntry | null {
  if (!isObj(v) || !str(v.ref) || !str(v.id) || !str(v.className) || !str(v.name)) return null;
  if (v.kind !== 'tab' && v.kind !== 'container' && v.kind !== 'widget') return null;
  return { ref: v.ref, id: v.id, ...(str(v.rid) ? { rid: v.rid } : {}), kind: v.kind, className: v.className, name: v.name };
}

function draftOf(v: unknown): PtDraft | null {
  if (!isObj(v) || !str(v.ref) || !str(v.id) || !str(v.name)) return null;
  return { ref: v.ref, id: v.id, name: v.name, ...(str(v.anchor) ? { anchor: v.anchor } : {}), ...(v.before === true ? { before: true } : {}) };
}

const rawPlace = (v: unknown): PtRawPlace | undefined => {
  if (!isObj(v)) return undefined;
  const p: PtRawPlace = {};
  for (const k of ['before', 'after', 'into'] as const) if (str(v[k])) p[k] = v[k] as string;
  return Object.keys(p).length ? p : undefined;
};

/** An operation kept in a snapshot (what a mark says on its own). */
function opOf(v: unknown): PtOp | null {
  if (!isObj(v) || !Array.isArray(v.notes) || !v.notes.every(finite) || (v.op !== 'add' && v.op !== 'move' && v.op !== 'delete' && v.op !== 'change')) return null;
  const place = rawPlace(v.place), to = rawPlace(v.to);
  return {
    notes: v.notes as number[], op: v.op,
    ...(str(v.ref) ? { ref: v.ref } : {}), ...(str(v.type) ? { type: v.type } : {}), ...(str(v.name) ? { name: v.name } : {}), ...(str(v.as) ? { as: v.as } : {}),
    ...(place ? { place } : {}), ...(to ? { to } : {}), ...(isObj(v.properties) ? { properties: v.properties } : {}),
  };
}

export function decodeCopy(raw: string | null): PtCopySnapshot | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!isObj(j) || j.v !== VERSION || !finite(j.at) || !str(j.sig) || !Array.isArray(j.refs)) return null;
    const refs = j.refs.map(refEntry).filter((e): e is PtRefEntry => e !== null);
    const colors: Record<string, string> = {};
    if (isObj(j.colors)) for (const [k, v] of Object.entries(j.colors)) if (str(v)) colors[k] = v;
    const now: Record<string, Record<string, unknown>> = {};
    if (isObj(j.now)) for (const [k, v] of Object.entries(j.now)) if (isObj(v)) now[k] = v;
    const marks = Array.isArray(j.marks)
      ? j.marks.flatMap(m => (isObj(m) && finite(m.n) && str(m.text) && Array.isArray(m.targets) ? [{ n: m.n, text: m.text, targets: m.targets.filter(str) }] : []))
      : [];
    const drafts = Array.isArray(j.drafts) ? j.drafts.map(draftOf).filter((d): d is PtDraft => d !== null) : [];
    const direct = Array.isArray(j.direct) ? j.direct.map(opOf).filter((o): o is PtOp => o !== null) : [];
    return { at: j.at, sig: j.sig, scope: j.scope === 'instance' ? 'instance' : 'template', refs, colors, now, marks, ...(drafts.length ? { drafts } : {}), ...(direct.length ? { direct } : {}) };
  } catch { return null; }
}

export function loadCopy(pageRid: string): PtCopySnapshot | null { return decodeCopy(read(COPY_KEY + pageRid)); }
export function saveCopy(pageRid: string, snap: PtCopySnapshot): boolean { return write(COPY_KEY + pageRid, JSON.stringify({ v: VERSION, ...snap })); }
export function clearCopy(pageRid: string): void { write(COPY_KEY + pageRid, null); }

// ── The stage stash ─────────────────────────────────────────────────────────────────────────────
// Not used by the interface at present (down to the end of this file): Point and tell is one way. Kept for a later two-way channel.
// "Stage in Blueprint" leaves the page's mode and enters Blueprint's, which reads the answer from here once.

export interface StageStash { answer: string; snapshot: PtCopySnapshot; /** How many changes Point and tell judged ready: Blueprint says so when fewer survive its own load. */ ready: number }

export function stashStage(pageRid: string, stash: StageStash, now: number): boolean {
  return write(STAGE_KEY + pageRid, JSON.stringify({ v: VERSION, t: now, answer: stash.answer, ready: stash.ready, snapshot: stash.snapshot }));
}

/** The waiting stash, once: removed as it is read, dropped when older than the TTL. */
export function takeStage(pageRid: string, now: number): StageStash | null {
  const raw = read(STAGE_KEY + pageRid);
  write(STAGE_KEY + pageRid, null);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!isObj(j) || j.v !== VERSION || !finite(j.t) || now - j.t >= STAGE_TTL_MS || !str(j.answer)) return null;
    const snapshot = decodeCopy(JSON.stringify({ v: VERSION, ...(isObj(j.snapshot) ? j.snapshot : {}) }));
    return snapshot ? { answer: j.answer, snapshot, ready: finite(j.ready) ? j.ready : 0 } : null;
  } catch { return null; }
}

/** After a successful apply: the marks whose operations all landed are removed (marks with anything
 *  left over stay, no longer "staged"). Returns what remains. */
export function markNotesApplied(pageRid: string, applied: readonly number[], kept: readonly number[] = []): MarkSet {
  const set = loadMarks(pageRid);
  const done = new Set(applied);
  const keep = new Set(kept);
  const marks = set.marks
    .filter(m => !done.has(m.n) || keep.has(m.n))
    .map(m => { const { staged: _staged, ...rest } = m; return rest as PtMark; });
  const next = { marks, next: set.next };
  saveMarks(pageRid, next);
  return next;
}

// ── What was staged, until it is applied ────────────────────────────────────────────────────────
// Staged changes live in Blueprint's memory. Point and tell flags the notes behind them and remembers
// which notes an apply would finish (every operation staged) and which it would leave (something was
// refused, a question is open). A successful apply settles the notes; leaving Blueprint any other way
// clears the flags (the staged changes are gone).

export interface StagedRecord { applied: number[]; kept: number[] }

/** Flag the notes behind staged changes and remember which an apply finishes. */
export function recordStaged(pageRid: string, record: StagedRecord): void {
  const set = loadMarks(pageRid);
  const all = new Set([...record.applied, ...record.kept]);
  saveMarks(pageRid, { marks: set.marks.map(m => (all.has(m.n) ? { ...m, staged: true } : m)), next: set.next });
  write(STAGED_KEY + pageRid, JSON.stringify({ v: VERSION, ...record }));
}

function readStaged(pageRid: string): StagedRecord | null {
  const raw = read(STAGED_KEY + pageRid);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!isObj(j) || j.v !== VERSION || !Array.isArray(j.applied) || !Array.isArray(j.kept)) return null;
    return { applied: j.applied.filter(finite), kept: j.kept.filter(finite) };
  } catch { return null; }
}

/** The apply went through: the notes it finished are removed, the others stay as plain notes. */
export function finishStaged(pageRid: string, survived?: ReadonlySet<number>): MarkSet | null {
  const rec = readStaged(pageRid);
  write(STAGED_KEY + pageRid, null);
  if (!rec) return null;
  // A note whose changes were taken back before the apply was not finished by it.
  const gone = survived ? rec.applied.filter(n => !survived.has(n)) : [];
  return markNotesApplied(pageRid, rec.applied.filter(n => !gone.includes(n)), [...rec.kept, ...gone]);
}

/** The staged changes are gone (Blueprint was left without applying): the notes are plain notes again. */
export function clearStaged(pageRid: string): void {
  write(STAGED_KEY + pageRid, null);
  const set = loadMarks(pageRid);
  if (!set.marks.some(m => m.staged)) return;
  saveMarks(pageRid, { marks: set.marks.map(m => { const { staged: _staged, ...rest } = m; return rest as PtMark; }), next: set.next });
}
