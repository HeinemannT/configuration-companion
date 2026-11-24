/**
 * Point and tell: marks made of ink. A finished stroke becomes a mark (or joins the one drawn just
 * before it), is read quietly (see lib/point-tell/ink-read), and is kept in the store with the object it
 * follows. Undo and redo work on marks and strokes; the eraser takes whole strokes.
 *
 * A mark's strokes are stored in page coordinates as drawn, with the box of the object they follow
 * (`ink.anchor`). What is shown is mapped from that box to the object's box as measured now, so the ink
 * follows the object when the layout shifts or the window is resized.
 */
import { arrowOf, pairMove } from '../lib/point-tell/gestures';
import { GROUP_MS, joinsGroup, readInk, type GroupState, type InkReading, type InkStroke } from '../lib/point-tell/ink-read';
import { hitTest, type Rect } from '../lib/point-tell/hit';
import type { PtAnchor, PtMark, PtPoint, PtStroke } from '../lib/point-tell/types';
import { addMark, markByNumber, setMarks } from './marks';
import { pt } from './state';
import type { InkStrokeIn } from './ink-canvas';
import { isSent } from '../lib/point-tell/sent-marks';

// ── Where a mark's ink is now ───────────────────────────────────────────────────────────────────

const targetRect = (id: string): Rect | null => {
  const s = pt.scene;
  if (!s) return null;
  // Ink drawn on the paper of a drawn tab follows the paper (its left edge and width) while it is shown.
  if (id.startsWith('paper:')) return s.paper && `paper:${s.paper.tabId}` === id ? { ...s.paper.rect, height: 1 } : null;
  return s.targets.find(t => t.id === id)?.rect ?? s.pills.find(t => t.id === id)?.rect ?? null;
};

/** Page-coordinate points of one stroke, mapped from the anchor's box at drawing time to its box now. */
function mapPoints(points: ReadonlyArray<PtPoint>, anchor: PtAnchor | undefined, now: Rect | null): Array<[number, number]> {
  if (!anchor || !now) return points.map(p => [p[0], p[1]]);
  const b = anchor.box;
  const same = Math.abs(now.left - b.left) < 0.5 && Math.abs(now.top - b.top) < 0.5 && Math.abs(now.width - b.width) < 0.5 && Math.abs(now.height - b.height) < 0.5;
  if (same) return points.map(p => [p[0], p[1]]);
  // The object moved, and may have been stretched (a window resize): the ink follows both, within reason.
  const kx = b.width >= 40 && now.width >= 8 ? Math.max(0.4, Math.min(2.5, now.width / b.width)) : 1;
  const ky = b.height >= 40 && now.height >= 8 ? Math.max(0.4, Math.min(2.5, now.height / b.height)) : 1;
  return points.map(p => [now.left + (p[0] - b.left) * kx, now.top + (p[1] - b.top) * ky]);
}

/** A mark's strokes where they are on the page now; null when the mark is not on the tab BMP shows. */
export function markStrokes(m: PtMark): Array<{ points: Array<[number, number]>; r?: number[] }> | null {
  const ink = m.ink;
  if (!ink) return null;
  const scene = pt.scene;
  if (ink.anchor) {
    const now = targetRect(ink.anchor.id);
    if (!now) return null;
    return ink.strokes.map(s => ({ points: mapPoints(s.points, ink.anchor, now), ...(s.r ? { r: s.r } : {}) }));
  }
  const tab = ink.place.tabId;
  if (tab && scene?.liveTabId && tab !== scene.liveTabId) return null;
  return ink.strokes.map(s => ({ points: mapPoints(s.points, undefined, null), ...(s.r ? { r: s.r } : {}) }));
}

export const strokeKey = (n: number, i: number): string => `${n}:${i}`;

/** Everything to paint, in the order the marks were made. */
export function visibleStrokes(): InkStrokeIn[] {
  const out: InkStrokeIn[] = [];
  for (const m of pt.marks) {
    const strokes = markStrokes(m);
    // Ink that went to Claude is quieter: the marks drawn since stand out.
    const quiet = isSent(m);
    strokes?.forEach((s, i) => out.push({ key: strokeKey(m.n, i), points: s.points, ...(s.r ? { r: s.r } : {}), ...(quiet ? { quiet } : {}) }));
  }
  return out;
}

/** The box of a mark's ink on the page now. */
export function markBox(m: PtMark): Rect | null {
  const strokes = markStrokes(m);
  if (!strokes?.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const s of strokes) for (const p of s.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/** Where the badge's tip points: the start of the mark's first stroke, and which way the stroke heads first. */
export function badgeStart(m: PtMark): { x: number; y: number; heading: number } | null {
  const first = markStrokes(m)?.[0];
  if (!first?.points.length) return null;
  const [x, y] = first.points[0];
  let heading = 0;
  for (const p of first.points) { if (Math.hypot(p[0] - x, p[1] - y) >= 14) { heading = Math.atan2(p[1] - y, p[0] - x); break; } }
  return { x, y, heading };
}

/** The last place the pen touched, for the comment field to sit beside. */
export function liftPoint(m: PtMark): [number, number] | null {
  const strokes = markStrokes(m);
  const last = strokes?.[strokes.length - 1];
  const p = last?.points[last.points.length - 1];
  return p ? [p[0], p[1]] : null;
}

// ── History ─────────────────────────────────────────────────────────────────────────────────────

interface Change { n: number; before: PtMark | null; after: PtMark | null }
interface Entry { changes: Change[]; next: [number, number] }
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
const HISTORY_MAX = 80;

export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;
export function resetHistory(): void { undoStack.length = 0; redoStack.length = 0; }

/** Apply changes by mark number; words typed since are kept when a mark is put back. */
function applyChanges(changes: Change[], dir: 'before' | 'after', next: number): void {
  let marks = pt.marks.slice();
  for (const c of changes) {
    const target = c[dir];
    const cur = marks.find(m => m.n === c.n);
    marks = marks.filter(m => m.n !== c.n);
    if (target) marks.push(cur ? { ...target, text: cur.text } : target);
  }
  marks.sort((a, b) => a.n - b.n);
  setMarks(marks, next);
}

function record(changes: Change[], next: [number, number]): void {
  undoStack.push({ changes, next });
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}

/** Undo the last mark, stroke or erase. The browser's own undo inside a text field is not touched. */
export function undo(): boolean {
  const e = undoStack.pop();
  if (!e) return false;
  if (pt.editor) pt.editor = null;
  applyChanges(e.changes, 'before', e.next[0]);
  redoStack.push(e);
  return true;
}

export function redo(): boolean {
  const e = redoStack.pop();
  if (!e) return false;
  if (pt.editor) pt.editor = null;
  applyChanges(e.changes, 'after', e.next[1]);
  undoStack.push(e);
  return true;
}

// ── Making and changing marks ───────────────────────────────────────────────────────────────────

/** What the pen just drew, as the tool hands it over. */
export interface FinishedStroke {
  stroke: PtStroke;
  /** The line as drawn, without the lift-off hairline: what the reader looks at. */
  raw: PtPoint[];
  startedAt: number;
  endedAt: number;
}

const rawOf = new WeakMap<PtStroke, PtPoint[]>();
/** Where a stroke starts and ends: a big arrowhead drawn after a pause joins a group at one of those. */
const endsOf = (raw: PtPoint[]): PtPoint[] => (raw.length ? [raw[0], raw[raw.length - 1]] : []);
let group: (GroupState & { n: number }) | null = null;

const boxOf = (strokes: ReadonlyArray<PtStroke>): Rect => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const s of strokes) for (const p of s.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
};

/** The mark's fields that come from reading its ink. */
function fromReading(r: InkReading, strokes: PtStroke[]): Pick<PtMark, 'targets' | 'meaning' | 'reading' | 'pointer' | 'arrow' | 'ink'> {
  const first = r.targets[0];
  const rect = first ? targetRect(first) : null;
  const paper = pt.scene?.paper;
  const anchor: PtAnchor | undefined = first && rect ? { id: first, box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
    : !first && paper && r.place.tabId === paper.tabId ? { id: `paper:${paper.tabId}`, box: { left: paper.rect.left, top: paper.rect.top, width: paper.rect.width, height: 1 } } : undefined;
  return {
    targets: r.targets,
    ...(r.meaning ? { meaning: r.meaning } : {}),
    ...(r.reading ? { reading: r.reading } : {}),
    ...(r.pointer ? { pointer: true as const } : {}),
    ...(r.arrow ? { arrow: r.arrow } : {}),
    ink: { strokes, place: r.place, ...(anchor ? { anchor } : {}) },
  };
}

const inkStrokes = (m: PtMark): InkStroke[] => (m.ink?.strokes ?? []).map(s => ({ points: rawOf.get(s) ?? s.points }));

function read(strokes: PtStroke[]): InkReading {
  const scene = pt.scene;
  if (!scene) return { kind: 'plain', targets: [], place: {} };
  return readInk(scene, strokes.map(s => ({ points: rawOf.get(s) ?? s.points })));
}

/**
 * An arrow from an object and a square drawn as two marks become one move (that object, that place and width,
 * both drawings kept). `cur` is the mark just made or changed; the arrow and the square may come in either
 * order. The square must carry no words. Returns the one mark and the other mark that was taken in, or null.
 */
function pairMarks(cur: PtMark): { merged: PtMark; other: PtMark } | null {
  const scene = pt.scene;
  if (!scene || !cur.ink) return null;
  for (let i = pt.marks.length - 1; i >= 0; i--) {
    const other = pt.marks[i];
    if (other.n === cur.n || !other.ink) continue;
    for (const [a, b] of [[cur, other], [other, cur]] as const) {
      if (b.meaning?.kind !== 'add' || b.text.trim()) continue;
      const ends = arrowOf(scene, inkStrokes(a));
      if (!ends) continue;
      const boxStrokes = inkStrokes(b);
      const paired = pairMove(scene, ends, readInk(scene, boxStrokes), boxStrokes);
      if (!paired) continue;
      const keep = cur.n < other.n ? cur : other;
      const strokes = [...keep.ink!.strokes, ...(keep === cur ? other : cur).ink!.strokes];
      const { meaning: _m, reading: _r, pointer: _p, arrow: _a, ...rest } = keep;
      return { merged: { ...rest, text: a.text, ...fromReading(paired, strokes) }, other };
    }
  }
  return null;
}

/** Record how `cur` came to be (`before`: what it was), taking in the pairing when there is one. Returns the mark that stands. */
function settle(cur: PtMark, before: PtMark | null, next: [number, number]): PtMark {
  const pair = pairMarks(cur);
  if (!pair) { record([{ n: cur.n, before, after: cur }], next); return cur; }
  const { merged, other } = pair;
  record([
    { n: cur.n, before, after: merged.n === cur.n ? merged : null },
    { n: other.n, before: other, after: merged.n === other.n ? merged : null },
  ], next);
  setMarks(pt.marks.filter(m => m.n !== (merged.n === cur.n ? other.n : cur.n)).map(m => (m.n === merged.n ? merged : m)), pt.next);
  group = null;
  return merged;
}

/**
 * A stroke ended. It joins the mark drawn just before it when it starts soon enough and close enough
 * (and no words were typed yet); otherwise it is a new mark. Either way the ink is read again as a whole.
 * Returns the mark.
 */
export function commitStroke(f: FinishedStroke): PtMark | null {
  rawOf.set(f.stroke, f.raw);
  const prev = group ? markByNumber(group.n) : undefined;
  const box = boxOf([f.stroke]);
  // Two marks drawn quickly side by side on different objects stay two: a stroke that does not cross the group's box and starts on another object is a new mark.
  const crosses = !!group && box.left <= group.box.left + group.box.width && box.left + box.width >= group.box.left && box.top <= group.box.top + group.box.height && box.top + box.height >= group.box.top;
  const startObj = pt.scene ? (hitTest(pt.scene.pills, f.raw[0][0], f.raw[0][1]) ?? hitTest(pt.scene.targets, f.raw[0][0], f.raw[0][1]))?.id : undefined;
  const sameObject = !prev?.targets[0] || !startObj || startObj === prev.targets[0] || (prev.targets.includes(startObj));
  if (group && prev?.ink && !prev.text.trim() && joinsGroup(group, box, f.startedAt) && (crosses || sameObject)) {
    const strokes = [...prev.ink.strokes, f.stroke];
    const { meaning: _m, reading: _r, pointer: _p, arrow: _a, ...rest } = prev;
    const next: PtMark = { ...rest, ...fromReading(read(strokes), strokes) };
    group = { n: prev.n, box: boxOf(next.ink!.strokes), endedAt: f.endedAt, ends: [...(group.ends ?? []), ...endsOf(f.raw)] };
    const stands = settle(next, prev, [pt.next, pt.next]);
    if (stands === next) setMarks(pt.marks.map(m => (m.n === prev.n ? next : m)), pt.next);
    return stands;
  }
  const strokes = [f.stroke];
  const before = pt.next;
  const mark = addMark({ text: '', ...fromReading(read(strokes), strokes) });
  if (!mark) return null;
  group = { n: mark.n, box, endedAt: f.endedAt, ends: endsOf(f.raw) };
  return settle(mark, null, [before, pt.next]);
}

/** A new stroke starts: the previous group stays open only for a short while (see GROUP_MS). */
export function groupOpenFor(startedAt: number): boolean { return !!group && startedAt - group.endedAt <= GROUP_MS; }
export function forgetGroup(): void { group = null; }

/** Drop what a mark was read as: it is then ink plus words. */
export function dropReading(n: number): void {
  const m = markByNumber(n);
  if (!m || !m.ink) return;
  const over = (m.ink.place.over ?? []).slice(0, 3);
  const { meaning: _meaning, reading: _reading, pointer: _pointer, arrow: _arrow, ...rest } = m;
  const next: PtMark = { ...rest, targets: over.length ? over : m.targets };
  // The ink follows the first object it still names (or nothing).
  const first = next.targets[0];
  const rect = first ? targetRect(first) : null;
  next.ink = { strokes: m.ink.strokes, place: m.ink.place, ...(first && rect ? { anchor: { id: first, box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } } } : {}) };
  record([{ n, before: m, after: next }], [pt.next, pt.next]);
  setMarks(pt.marks.map(x => (x.n === n ? next : x)), pt.next);
  if (group?.n === n) group = null;
}

/** Remove a mark (the field's trash can); undoable. */
export function removeMark(n: number): void {
  const m = markByNumber(n);
  if (!m) return;
  record([{ n, before: m, after: null }], [pt.next, pt.next]);
  setMarks(pt.marks.filter(x => x.n !== n), pt.next);
  if (group?.n === n) group = null;
}

/** The eraser took these strokes (keys from `strokeKey`). A mark left with no ink keeps its words as a plain note, or goes. */
export function eraseStrokes(keys: string[]): void {
  if (!keys.length) return;
  const byMark = new Map<number, Set<number>>();
  for (const k of keys) { const [n, i] = k.split(':').map(Number); (byMark.get(n) ?? byMark.set(n, new Set()).get(n)!).add(i); }
  const changes: Change[] = [];
  const marks: PtMark[] = [];
  for (const m of pt.marks) {
    const gone = byMark.get(m.n);
    if (!gone || !m.ink) { marks.push(m); continue; }
    const left = m.ink.strokes.filter((_, i) => !gone.has(i));
    if (left.length) {
      // What is left of the ink is read again.
      const { meaning: _m, reading: _r, pointer: _p, arrow: _a, ...rest } = m;
      const next: PtMark = { ...rest, ...fromReading(read(left), left) };
      changes.push({ n: m.n, before: m, after: next }); marks.push(next);
    } else if (m.text.trim()) {
      const { ink: _ink, meaning: _meaning, reading: _reading, pointer: _pointer, arrow: _arrow, ...rest } = m;
      const next: PtMark = { ...rest };
      changes.push({ n: m.n, before: m, after: next }); marks.push(next);
    } else changes.push({ n: m.n, before: m, after: null });
  }
  if (!changes.length) return;
  record(changes, [pt.next, pt.next]);
  setMarks(marks, pt.next);
  if (group && !markByNumber(group.n)) group = null;
}
