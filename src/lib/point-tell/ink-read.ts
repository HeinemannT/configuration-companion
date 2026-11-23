/**
 * Point and tell: what a drawing means, worked out quietly from what is under it. Pure functions over
 * a scene (the layout model plus the rectangles the page measured) and strokes in page coordinates.
 * Nothing here changes how a stroke looks: a stroke stays exactly as drawn, this only reads it.
 *
 *   loop around objects          the objects are the targets (one stroke, or two arcs; overshoot, a gap and hooks are fine)
 *   line or arrow from an object to a place   move (the place from `resolveArrow`); the head is a hook, a V, a W, a triangle
 *                                or one or two barbs, drawn with the line or apart from it, before or after (see `arrowParts`)
 *   rough box on empty space      add (the place from `resolveBox`)
 *   a sketch of a widget on empty space   add, with a widget kind (table, chart, button, text; see widget-read)
 *   an arrow from an object into a square you drew   move (the place and width of the square)
 *   an arrow from empty space onto an object   about that object (a select, like a loop)
 *   scratch-out, X (two strokes or one) or a line struck through an object   crossed out (not a delete: the words and the context say what it means)
 *   underline or squiggle under an object  change
 *   anything else                 plain ink, with the objects it touches
 *
 * When in doubt the answer is plain ink: a wrong "crossed out" is worse than no reading. A group of strokes
 * drawn close together in time and space is one mark and is read as a whole.
 */
import type { LModel } from '../layout/types';
import { findNode } from '../layout/model';
import { area, centre, contains, intersection, type Rect } from './hit';
import { contentBounds, inkBounds, inkPlace, objectsIn, resolveArrow, resolveBox, type PtScene } from './resolve';
import { readSketch } from './widget-read';
import { analyze, joinedLoop, pip, type Features } from './ink-features';
import { arrowParts, crossOf, objectAt, pairMove, pointerTarget, splitArrow, struckThrough } from './gestures';
import { dist } from './ink-geom';
import { tabReading } from './tab-read';
import { crumbReading } from './crumb-read';
import type { PtGridPlace, PtMeaning, PtPoint } from './types';

export interface InkStroke { points: PtPoint[] }

export type InkKind = 'plain' | 'select' | 'move' | 'add' | 'crossed' | 'change';

export interface InkReading {
  kind: InkKind;
  /** Object ids the mark is about; the first is the one the ink follows. */
  targets: string[];
  meaning?: PtMeaning;
  /** The one quiet line the page shows; absent for plain ink. */
  reading?: string;
  /** Read from an arrow that ends on an object (not a loop). */
  pointer?: true;
  place: PtGridPlace;
}

// ── Objects ─────────────────────────────────────────────────────────────────────────────────────

const isAncestor = (model: LModel, anc: string, id: string): boolean => {
  for (let p = findNode(model, id)?.parent; p; p = findNode(model, p.id)?.parent ?? null) if (p.id === anc) return true;
  return false;
};

const nameOf = (scene: PtScene, id: string): string => findNode(scene.model, id)?.node.name ?? id;
const nameList = (scene: PtScene, ids: string[]): string => (ids.length === 1 ? nameOf(scene, ids[0]) : `${ids.length} objects`);

/** The objects a stroke runs over, innermost first, at most three. */
function touched(scene: PtScene, F: Features): string[] {
  const n = F.S.length || 1;
  const share = new Map<string, number>();
  for (const p of F.S) {
    for (const t of scene.targets) if (contains({ left: t.rect.left - 2, top: t.rect.top - 2, width: t.rect.width + 4, height: t.rect.height + 4 }, p[0], p[1])) share.set(t.id, (share.get(t.id) ?? 0) + 1);
  }
  let c = [...share].map(([id, k]) => ({ id, s: k / n })).filter(x => x.s >= 0.2);
  c = c.filter(x => !c.some(y => y !== x && isAncestor(scene.model, x.id, y.id) && y.s >= 0.6 * x.s));
  c.sort((a, b) => b.s - a.s);
  return c.slice(0, 3).map(x => x.id);
}

// ── Readings ────────────────────────────────────────────────────────────────────────────────────

const strip = (s: string): string => s.replace(/"/g, '');

function columnsWords(row: number | undefined, col: number | undefined, cols: number | undefined): string {
  if (!row) return 'Add here';
  const c0 = col ?? 1, c1 = Math.min(6, c0 + Math.max(1, cols ?? 1) - 1);
  return `Add in row ${row}, ${c1 > c0 ? `columns ${c0}–${c1}` : `column ${c0}`}`;
}

const WIDGET_LABEL = { table: 'Table', chart: 'Chart', button: 'Button', text: 'Text' } as const;

/**
 * Strokes that sketch a widget (or, with an outline and nothing the reader is sure of, an empty box) on
 * empty grid: an add with the widget kind, its width and its place. Null when the strokes are not that, or
 * sit over existing objects.
 */
function sketchReading(scene: PtScene, fs: Features[]): InkReading | null {
  const sk = readSketch(fs, contentBounds(scene)?.width ?? 0);
  if (!sk || sk.box.width < 50 || sk.box.height < 24 || !emptyGrid(scene, sk.box) || objectsIn(scene, sk.box).length) return null;
  const r = resolveBox(scene, sk.box);
  if (!r.ok || r.kind !== 'place') return null;
  const w = sk.widget;
  if (!w) return { kind: 'add', targets: [], meaning: r.meaning, place: r.grid, reading: columnsWords(r.grid.row, r.grid.col, r.grid.cols) };
  const cols = r.grid.cols;
  const reading = `${WIDGET_LABEL[w.kind]}${cols ? `, about ${cols} column${cols === 1 ? '' : 's'} wide` : ''}${r.grid.row ? `, row ${r.grid.row}` : ''}`;
  return { kind: 'add', targets: [], meaning: { ...r.meaning, widget: w.kind, types: w.types }, place: r.grid, reading };
}

function plain(scene: PtScene, strokes: ReadonlyArray<InkStroke>, F?: Features): InkReading {
  const place = inkPlace(scene, strokes);
  const targets = F ? touched(scene, F) : (place.over ?? []).slice(0, 3);
  return { kind: 'plain', targets, place };
}

/** Whether a rectangle lies over empty grid: no widget takes more than a fifth of it. */
function emptyGrid(scene: PtScene, box: Rect): boolean {
  const a = area(box);
  return !scene.targets.some(t => t.kind === 'widget' && a > 0 && intersection(t.rect, box) / a > 0.2);
}

/** The object an underline or squiggle belongs to: it spans most of it and sits in its lower part or just below. */
function underTarget(scene: PtScene, F: Features): string | null {
  const bb = F.bbox;
  const my = F.S.reduce((s, p) => s + p[1], 0) / Math.max(1, F.S.length);
  const x0 = bb.left, x1 = bb.left + bb.width;
  const xov = (r: Rect): number => Math.max(0, Math.min(x1, r.left + r.width) - Math.max(x0, r.left)) / Math.max(1, bb.width);
  const pool = scene.targets.filter(t => t.kind === 'widget' && xov(t.rect) >= 0.6 && x0 >= t.rect.left - 14 && x1 <= t.rect.left + t.rect.width + 14);
  const hits = pool.filter(t => {
    const bottom = t.rect.top + t.rect.height;
    const low = my >= t.rect.top + t.rect.height * 0.55 && my <= bottom + 22;
    // The header of a tall widget (a table): the top fifth.
    const head = t.rect.height >= 120 && my >= t.rect.top && my <= t.rect.top + Math.max(34, t.rect.height * 0.2);
    return low || head;
  }).sort((a, b) => area(a.rect) - area(b.rect));
  return hits[0]?.id ?? null;
}

function crossedTarget(scene: PtScene, bb: Rect): string | null {
  let best: string | null = null, bs = 0;
  for (const t of scene.targets) {
    const ia = intersection(bb, t.rect);
    const inside = ia / Math.max(1, area(bb));
    const cover = ia / Math.max(1, area(t.rect));
    const wc = Math.min(bb.left + bb.width, t.rect.left + t.rect.width) - Math.max(bb.left, t.rect.left);
    const hc = Math.min(bb.top + bb.height, t.rect.top + t.rect.height) - Math.max(bb.top, t.rect.top);
    if (inside < 0.6) continue;
    if (!(cover >= 0.18 || Math.max(wc / t.rect.width, hc / t.rect.height) >= 0.6)) continue;
    const sc = (cover + 0.3) * inside + 1 / Math.sqrt(Math.max(1, area(t.rect))) + (t.kind === 'widget' ? 0.01 : 0);
    if (sc > bs) { bs = sc; best = t.id; }
  }
  return best;
}

/**
 * What an X is on. The classic reading first (the X covers much of one object); then an X that is small on a
 * big widget or tab (it sits wholly inside it and is no tiny scribble), and an X bigger than the object it was
 * drawn on (its crossing is on that object and it covers most of it).
 */
function crossedMark(scene: PtScene, bb: Rect, at: PtPoint, plus = false): string | null {
  const id = crossedTarget(scene, bb);
  if (id || plus) return id;
  const a = Math.max(1, area(bb));
  const pad = 3;
  const mid = centre(bb);
  const on = (r: Rect): boolean => [at, mid].some(p => contains({ left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }, p[0], p[1]));
  const pool = [...scene.pills, ...scene.targets.filter(t => t.kind === 'widget')].filter(t => on(t.rect));
  const fits = pool.filter(t => {
    const ia = intersection(bb, t.rect), small = Math.min(bb.width, bb.height) >= Math.min(26, 0.45 * Math.min(t.rect.width, t.rect.height)) && Math.max(bb.width, bb.height) >= 28;
    return (small && ia / a >= 0.85) || (ia / Math.max(1, area(t.rect)) >= 0.6 && ia / a >= 0.12);
  }).sort((x, y) => area(x.rect) - area(y.rect));
  return fits[0]?.id ?? null;
}

const withKind = (scene: PtScene, strokes: ReadonlyArray<InkStroke>, kind: InkKind, targets: string[], extra: Partial<InkReading>): InkReading => ({
  kind, targets, place: inkPlace(scene, strokes), ...extra,
});

/** One stroke. */
function readOne(scene: PtScene, strokes: ReadonlyArray<InkStroke>, F: Features): InkReading {
  if (F.tap || F.L < 40) return plain(scene, strokes, F);

  // An X drawn in one stroke.
  if (F.xmark && F.cross) {
    const id = crossedMark(scene, F.bbox, F.cross);
    return id ? withKind(scene, strokes, 'crossed', [id], { meaning: { kind: 'crossed' }, reading: `Crossed out ${nameOf(scene, id)}` }) : plain(scene, strokes, F);
  }

  if (F.closed) {
    const poly = F.S;
    const box = F.bbox;
    // A loop: the objects mostly inside it.
    let inside = scene.targets.filter(t => {
      let c = 0;
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (pip([t.rect.left + (t.rect.width * (i + 0.5)) / 5, t.rect.top + (t.rect.height * (j + 0.5)) / 5], poly)) c++;
      return c / 25 >= 0.72;
    });
    inside = inside.filter(t => !inside.some(o => o !== t && isAncestor(scene.model, o.id, t.id)));
    const pillsIn = scene.pills.filter(t => { const [cx, cy] = centre(t.rect); return pip([cx, cy], poly); });
    const ids = [...pillsIn, ...inside].map(t => t.id);
    if (ids.length && Math.min(box.width, box.height) >= 16) {
      const sorted = ids.slice(0, 6);
      return withKind(scene, strokes, 'select', sorted, { reading: nameList(scene, sorted) });
    }
    // A small rounded box on empty grid is a button.
    if (!ids.length && F.rectness >= 0.8 && box.width >= 50 && box.height >= 24 && emptyGrid(scene, box)) {
      const sk = sketchReading(scene, [F]);
      if (sk?.meaning?.kind === 'add' && sk.meaning.widget) return sk;
    }
    // A rough box on empty grid: something new goes here.
    if (!ids.length && F.corners >= 3 && F.rectness >= 0.72 && box.width >= 50 && box.height >= 34 && emptyGrid(scene, box)) {
      const r = resolveBox(scene, box);
      if (r.ok && r.kind === 'place') {
        return { kind: 'add', targets: [], meaning: r.meaning, place: r.grid, reading: columnsWords(r.grid.row, r.grid.col, r.grid.cols) };
      }
    }
    // A loop drawn inside one object: that object.
    if (!ids.length && Math.min(box.width, box.height) >= 16) {
      const only = scene.targets.filter(t => intersection(box, t.rect) / Math.max(1, area(box)) >= 0.8).sort((a, b) => area(a.rect) - area(b.rect))[0];
      if (only) return withKind(scene, strokes, 'select', [only.id], { reading: nameOf(scene, only.id) });
    }
    return plain(scene, strokes, F);
  }

  if (F.scribble && F.bbox.width >= 24 && F.bbox.height >= 10) {
    const id = crossedTarget(scene, F.bbox);
    if (id) return withKind(scene, strokes, 'crossed', [id], { meaning: { kind: 'crossed' }, reading: `Crossed out ${nameOf(scene, id)}` });
    return plain(scene, strokes, F);
  }

  const under = F.flat ? underTarget(scene, F) : null;
  const src = F.arrowish ? objectAt(scene, F.S[0]) : null;
  // A line that starts on an object and ends elsewhere moves it, unless it is an underline of that object.
  if (F.arrowish && src && dist(F.start, F.tip) >= 60 && !(under && under === src.id)) {
    if (!contains(src.rect, F.tip[0], F.tip[1])) {
      const r = resolveArrow(scene, src.id, F.tip[0], F.tip[1]);
      if (r.ok) {
        const reading = strip(r.meaning.words ?? `Move ${nameOf(scene, src.id)}`);
        return { kind: 'move', targets: [src.id], meaning: r.meaning, place: r.grid, reading };
      }
    }
    // Starts and ends on the same object: struck through, below.
    if (!contains(src.rect, F.tip[0], F.tip[1])) return plain(scene, strokes, F);
  }
  if (under) {
    return withKind(scene, strokes, 'change', [under], { meaning: { kind: 'change' }, reading: `Change ${nameOf(scene, under)}` });
  }
  const struck = struckThrough(scene, F);
  if (struck) return withKind(scene, strokes, 'crossed', [struck], { meaning: { kind: 'crossed' }, reading: `Crossed out ${nameOf(scene, struck)}` });
  const pointed = pointerTarget(scene, F);
  if (pointed) return withKind(scene, strokes, 'select', [pointed.id], { reading: nameOf(scene, pointed.id), pointer: true });
  return plain(scene, strokes, F);
}

/** Read the strokes of one mark. Never throws: anything unexpected is plain ink. */
export function readInk(scene: PtScene, strokes: ReadonlyArray<InkStroke>): InkReading {
  try {
    const list = strokes.filter(s => s.points.length > 0);
    if (!list.length) return { kind: 'plain', targets: [], place: {} };
    // A small shape past the last breadcrumb: a new page. On the tab row, past the last tab or in a gap: a new tab.
    const page = crumbReading(scene, list);
    if (page) return page;
    const tab = tabReading(scene, list);
    if (tab) return tab;
    if (list.length === 1) return readOne(scene, list, analyze(list[0].points));
    const fs = list.map(s => analyze(s.points));
    if (list.length === 2) {
      // A cross: two straight strokes that cross each other.
      const x = crossOf(fs[0], fs[1]);
      if (x) {
        const id = crossedMark(scene, inkBounds(list)!, x.at, x.plus);
        if (id) return withKind(scene, list, 'crossed', [id], { meaning: { kind: 'crossed' }, reading: `Crossed out ${nameOf(scene, id)}` });
        return plain(scene, list);
      }
      // A loop drawn in two arcs.
      const lp = joinedLoop(fs[0], fs[1]);
      if (lp) {
        const one = readOne(scene, list, lp);
        if (one.kind === 'select') return one;
      }
    }
    // An arrow from an object that ends inside a square drawn with it: that object goes there, at that width.
    const sp = splitArrow(scene, list, fs);
    if (sp) {
      const paired = pairMove(scene, sp.ends, readInk(scene, sp.rest), sp.rest);
      if (paired) return paired;
    }
    // An arrow drawn with separate head strokes: one long stroke, and a V or one or two barbs at one of its ends.
    if (list.length <= 4) {
      const ap = arrowParts(fs);
      if (ap && ap.heads.length > 0 && ap.heads.length + 1 === list.length) {
        const one = readOne(scene, [list[ap.shaft]], ap.F);
        if (one.kind === 'move' || one.kind === 'select') return { ...one, place: inkPlace(scene, list) };
      }
    }
    // A sketch of a widget on empty grid (a box with lines across, bars, a few wavy lines).
    const sk = sketchReading(scene, fs);
    if (sk) return sk;
    // Handwriting, a drawing of several parts: plain ink, with what it covers.
    return plain(scene, list);
  } catch {
    return { kind: 'plain', targets: [], place: {} };
  }
}

// ── Which strokes belong together ───────────────────────────────────────────────────────────────

/** Strokes this close in time belong to one mark when they are close in space too. */
export const GROUP_MS = 1500;
export const GROUP_GAP = 36;
/** A stroke drawn inside the box of a group (a line across a table sketch) may follow after a longer pause: a person draws a sketch calmly. */
export const GROUP_INSIDE_MS = 3500;

export interface GroupState { box: Rect; endedAt: number }

export function joinsGroup(group: GroupState, strokeBox: Rect, startedAt: number): boolean {
  const g = group.box;
  const cx = strokeBox.left + strokeBox.width / 2, cy = strokeBox.top + strokeBox.height / 2;
  const inside = g.width >= 60 && g.height >= 40 && cx >= g.left && cx <= g.left + g.width && cy >= g.top && cy <= g.top + g.height;
  const dx = Math.max(g.left - (strokeBox.left + strokeBox.width), strokeBox.left - (g.left + g.width), 0);
  const dy = Math.max(g.top - (strokeBox.top + strokeBox.height), strokeBox.top - (g.top + g.height), 0);
  const gap = Math.hypot(dx, dy);
  // The second stroke of an X: each stroke's middle lies within the other's box (also on a flat object, where the box is thin).
  const gcx = g.left + g.width / 2, gcy = g.top + g.height / 2;
  const across = Math.max(g.width, g.height) >= 20 && Math.max(strokeBox.width, strokeBox.height) >= 20
    && cx >= g.left && cx <= g.left + g.width && cy >= g.top && cy <= g.top + g.height
    && gcx >= strokeBox.left && gcx <= strokeBox.left + strokeBox.width && gcy >= strokeBox.top && gcy <= strokeBox.top + strokeBox.height;
  // The head of an arrow: a small stroke that touches the line, drawn after the line is done and the hand has gone back.
  const head = Math.max(strokeBox.width, strokeBox.height) <= 70 && gap <= 8 && Math.max(g.width, g.height) >= 50;
  if (startedAt - group.endedAt > (inside || across || head ? GROUP_INSIDE_MS : GROUP_MS)) return false;
  // Crossing or touching the group's box always joins; otherwise the stroke must start close by.
  // The margin grows with the size of what is drawn: handwriting spaces its letters by about their size.
  const size = Math.max(g.width, g.height, strokeBox.width, strokeBox.height);
  return gap <= Math.min(90, Math.max(GROUP_GAP, 0.8 * size));
}
