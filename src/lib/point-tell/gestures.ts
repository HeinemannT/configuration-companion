/**
 * Point and tell: the small rules that read one gesture each, kept apart from the reader that tries them.
 * Pure functions over a scene and the shapes of strokes (ink-features); each returns what it found or null,
 * so a rule is tested alone and a new gesture is one more function here.
 *
 *   struckThrough    a straight line across an object, both ends on it: crossed out
 *   crossOf          two straight strokes that cross each other (an X), and where
 *   pointerTarget    an arrow from empty space that ends on an object: about that object
 *   arrowOf          an arrow that starts on an object and ends elsewhere
 *   pairMove         such an arrow that ends inside a drawn square: put that object there, at that width
 *
 * When unsure each returns null: the reader then falls back to the weaker reading.
 */
import { findNode } from '../layout/model';
import { centre, contains, hitTest, type PtTarget } from './hit';
import { analyze, type Features } from './ink-features';
import { dist, meeting } from './ink-geom';
import type { InkReading, InkStroke } from './ink-read';
import { gridOfBox, inkBounds, resolvePlace, type PtScene } from './resolve';
import type { PtPoint } from './types';

const strip = (s: string): string => s.replace(/"/g, '');

/** The deepest object (a tab pill counts) under a point. */
export function objectAt(scene: PtScene, p: PtPoint): PtTarget | null {
  return hitTest(scene.pills, p[0], p[1]) ?? hitTest(scene.targets, p[0], p[1]);
}

// ── Crossed out ─────────────────────────────────────────────────────────────────────────────────

/** A straight line that starts and ends over one object and runs most of the way across it. */
export function struckThrough(scene: PtScene, F: Features): string | null {
  if (F.tap || F.wavy || F.closed || F.chord < 60 || F.chord / F.L < 0.85) return null;
  const [dx, dy] = [Math.abs(F.end[0] - F.start[0]), Math.abs(F.end[1] - F.start[1])];
  const mid: PtPoint = [(F.start[0] + F.end[0]) / 2, (F.start[1] + F.end[1]) / 2];
  const hits = scene.targets.filter(t => {
    const r = t.rect, pad = 10;
    const on = (p: PtPoint): boolean => contains({ left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }, p[0], p[1]);
    if (!on(F.start) || !on(F.end) || !contains(r, mid[0], mid[1])) return false;
    return Math.max(dx / Math.max(1, r.width), dy / Math.max(1, r.height)) >= 0.6;
  });
  hits.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
  return hits[0]?.id ?? null;
}

// ── A pointer ───────────────────────────────────────────────────────────────────────────────────

/** An arrow that starts on empty space and ends on an object: that object (a mark that is about it, no operation). */
export function pointerTarget(scene: PtScene, F: Features): PtTarget | null {
  if (!F.arrowish || objectAt(scene, F.S[0])) return null;
  return objectAt(scene, F.tip);
}

// ── An arrow into a drawn square ────────────────────────────────────────────────────────────────

export interface ArrowEnds { from: PtTarget; tip: PtPoint }

export interface ArrowParts {
  shaft: number;
  heads: number[];
  /** The shaft read from its tail to the point of the arrow, with that point as the tip. */
  F: Features;
}

const unit = (from: PtPoint, to: PtPoint): PtPoint => { const l = dist(from, to) || 1; return [(to[0] - from[0]) / l, (to[1] - from[1]) / l]; };

/**
 * Whether a short stroke is an arrowhead at `end` of a shaft that comes from `from`: it passes close to that
 * end, stays within a head's reach of it, and lies on the shaft's side (a head opens backwards, along the shaft).
 */
export function isHeadAt(h: Features, end: PtPoint, from: PtPoint): boolean {
  if (h.tap || h.L < 6 || h.L > 120 || !h.S.length) return false;
  const [ux, uy] = unit(end, from);
  let near = Infinity, reach = 0, back = 0;
  for (const p of h.S) {
    const d = dist(p, end);
    near = Math.min(near, d); reach = Math.max(reach, d);
    back += (p[0] - end[0]) * ux + (p[1] - end[1]) * uy;
  }
  return near <= 16 && reach <= 64 && back / h.S.length > 0.1 * reach;
}

/**
 * Which of the strokes are an arrow: the arrow-like shaft, and the short strokes that are its head (one V, two
 * barbs, drawn before or after the shaft, at either end of it). The head decides which way the arrow points; with
 * none, the way the shaft was drawn does. The tip is the point of the head, not the end of a barb.
 */
export function arrowParts(fs: Features[]): ArrowParts | null {
  let shaft = -1;
  fs.forEach((f, i) => { if (f.arrowish && (shaft < 0 || f.L > fs[shaft].L)) shaft = i; });
  if (shaft < 0) return null;
  const s = fs[shaft];
  const others = fs.map((f, i) => ({ f, i })).filter(x => x.i !== shaft && x.f.L <= 0.7 * s.L);
  const atTip = others.filter(x => isHeadAt(x.f, s.tip, s.start)).map(x => x.i);
  const atStart = others.filter(x => isHeadAt(x.f, s.start, s.tip)).map(x => x.i);
  const flip = atStart.length > atTip.length;
  const heads = (flip ? atStart : atTip).slice(0, 3);
  let F = s;
  if (flip) F = analyze([...s.S].reverse());
  if (!F.arrowish) return null;
  // The point of the head: the farthest point along the arrow's way, within reach of the shaft's end.
  const [ux, uy] = unit(F.start, F.tip);
  let tip = F.tip, best = (F.tip[0] - F.start[0]) * ux + (F.tip[1] - F.start[1]) * uy;
  for (const i of heads) for (const p of fs[i].S) {
    const pr = (p[0] - F.start[0]) * ux + (p[1] - F.start[1]) * uy;
    if (pr > best && dist(p, F.tip) <= 30) { best = pr; tip = p; }
  }
  if (tip !== F.tip) F = { ...F, tip };
  return { shaft, heads, F };
}

function endsOf(scene: PtScene, F: Features): ArrowEnds | null {
  const from = objectAt(scene, F.S[0]);
  if (!from || dist(F.start, F.tip) < 60 || contains(from.rect, F.tip[0], F.tip[1])) return null;
  return { from, tip: F.tip };
}

/** Strokes that are all of one arrow (a line, or a line with a head), starting on an object. */
export function arrowOf(scene: PtScene, strokes: ReadonlyArray<InkStroke>): ArrowEnds | null {
  const fs = strokes.map(s => analyze(s.points));
  const parts = arrowParts(fs);
  if (!parts || parts.heads.length + 1 !== fs.length) return null;
  return endsOf(scene, parts.F);
}

/** A group of strokes split into an arrow (starting on an object) and the rest; null when there is no such arrow or nothing else. */
export function splitArrow(scene: PtScene, strokes: ReadonlyArray<InkStroke>, fs: Features[]): { arrow: InkStroke[]; rest: InkStroke[]; ends: ArrowEnds } | null {
  const parts = arrowParts(fs);
  if (!parts) return null;
  const ends = endsOf(scene, parts.F);
  if (!ends) return null;
  const used = new Set([parts.shaft, ...parts.heads]);
  const rest = strokes.filter((_, i) => !used.has(i));
  if (!rest.length) return null;
  return { arrow: strokes.filter((_, i) => used.has(i)), rest, ends };
}

// ── A cross ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Two strokes that make an X (or a plus): both straight enough, each long enough, at a real angle to each other,
 * and meeting inside both (not at an end: a V, a T and an L are no cross). Strokes that only just miss each other
 * count; a person does not lift the pen exactly on the other line. Returns where they meet, and whether it is a
 * plus (one stroke upright, one across) rather than an X: a plus is the weaker reading of a cross.
 */
export function crossOf(a: Features, b: Features): { at: PtPoint; plus: boolean } | null {
  const ok = (f: Features): boolean => !f.tap && f.chord >= 20 && f.chord / f.L >= 0.75 && f.corners === 0;
  if (!ok(a) || !ok(b) || Math.min(a.L, b.L) < 0.15 * Math.max(a.L, b.L)) return null;
  const [ax, ay] = unit(a.start, a.end), [bx, by] = unit(b.start, b.end);
  if (Math.abs(ax * by - ay * bx) < 0.2) return null;
  const m = meeting(a.S, b.S, Math.min(6, 0.06 * Math.min(a.L, b.L)));
  if (!m || m.ta < 0.2 || m.ta > 0.8 || m.tb < 0.2 || m.tb > 0.8) return null;
  const tilt = (x: number, y: number): number => Math.min(Math.abs(Math.atan2(y, x)) % Math.PI, Math.PI - (Math.abs(Math.atan2(y, x)) % Math.PI));
  const ta = tilt(ax, ay), tb = tilt(bx, by), up = Math.PI / 2;
  const plus = (ta < 0.45 && Math.abs(tb - up) < 0.45) || (tb < 0.45 && Math.abs(ta - up) < 0.45);
  return { at: m.at, plus };
}

/**
 * An arrow that ends inside a square (a mark read as an add, with or without a widget kind) puts that
 * existing object there, at the square's width. Null when the arrow does not end in the square or the object
 * is already there.
 */
export function pairMove(scene: PtScene, ends: ArrowEnds, box: InkReading, boxStrokes: ReadonlyArray<InkStroke>): InkReading | null {
  if (box.kind !== 'add' || box.meaning?.kind !== 'add') return null;
  const rect = inkBounds(boxStrokes);
  if (!rect) return null;
  const pad = 10;
  if (!contains({ left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad }, ends.tip[0], ends.tip[1])) return null;
  const node = findNode(scene.model, ends.from.id)?.node;
  if (!node) return null;
  const mover = { id: node.id, kind: node.kind };
  let r = resolvePlace(scene, rect.left + 2, centre(rect)[1], mover, 'nearest');
  if (!r.ok) r = resolvePlace(scene, centre(rect)[0], centre(rect)[1], mover, 'nearest');
  if (!r.ok || r.unchanged) return null;
  const grid = gridOfBox(scene, rect, r, []);
  const words = `Move "${node.name}" ${r.words}${grid.cols ? `, about ${grid.cols} column${grid.cols === 1 ? '' : 's'} wide` : ''}`;
  return {
    kind: 'move',
    targets: [node.id],
    meaning: { kind: 'move', to: r.place, ...(grid.cols ? { columns: grid.cols } : {}), words },
    place: grid,
    reading: strip(words),
  };
}
