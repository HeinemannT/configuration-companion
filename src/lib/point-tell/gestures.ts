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
import { clamp, dist, dp, meeting } from './ink-geom';
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
  /** The head has the shape of one (straight barbs from a point, opening backwards; see `bigHeadAt`), not only a short stroke near the end. */
  shaped?: true;
}

const unit = (from: PtPoint, to: PtPoint): PtPoint => { const l = dist(from, to) || 1; return [(to[0] - from[0]) / l, (to[1] - from[1]) / l]; };

/**
 * Whether a short stroke is an arrowhead at `end` of a shaft that comes from `from`: it passes close to that
 * end, stays within a head's reach of it, and lies on the shaft's side (a head opens backwards, along the shaft).
 * That is a small head (barbs up to about 60 px); with the shaft's length and the way it arrives at `end`, a
 * head of any size is judged too (`bigHeadAt`).
 */
export function isHeadAt(h: Features, end: PtPoint, from: PtPoint, shaft?: { len: number; way: PtPoint }): boolean {
  if (h.tap || h.L < 6 || !h.S.length) return false;
  if (h.L <= 120 && smallHeadAt(h, end, from)) return true;
  return !!shaft && bigHeadAt(h.S, h.L, end, shaft.way, shaft.len) > 0;
}

function smallHeadAt(h: Features, end: PtPoint, from: PtPoint): boolean {
  const [ux, uy] = unit(end, from);
  let near = Infinity, reach = 0, back = 0;
  for (const p of h.S) {
    const d = dist(p, end);
    near = Math.min(near, d); reach = Math.max(reach, d);
    back += (p[0] - end[0]) * ux + (p[1] - end[1]) * uy;
  }
  return near <= 16 && reach <= 64 && back / h.S.length > 0.1 * reach;
}

/** Whether point p lies in triangle a b c, grown by a fifth about its middle. */
function inTriangle(p: PtPoint, a: PtPoint, b: PtPoint, c: PtPoint): boolean {
  const m: PtPoint = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  const g = (q: PtPoint): PtPoint => [m[0] + (q[0] - m[0]) * 1.2, m[1] + (q[1] - m[1]) * 1.2];
  const [A, B, C] = [g(a), g(b), g(c)];
  const s = (u: PtPoint, v: PtPoint): number => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const d1 = s(A, B), d2 = s(B, C), d3 = s(C, A);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * A head of any size at `end` of a shaft `len` px long that arrives there going `way` (a unit vector from the
 * shaft's last stretch: on a curved shaft the chord points elsewhere). The head is one or two straight barbs
 * from its point: one barb, a V, two barbs drawn apart, or a hook or a V drawn on from the shaft. Every corner
 * of it is at the point or at the end of a barb, every barb runs back along the shaft and out to one side, and
 * a V has a barb on each side. Its point may sit past the end of the shaft (a big V drawn afterwards), with the
 * shaft ending close to it or inside the V. Returns the head's size (its longest barb), or 0 when it is no head.
 */
export function bigHeadAt(hS: PtPoint[], hL: number, end: PtPoint, way: PtPoint, len: number): number {
  if (hS.length < 2) return 0;
  const bx = -way[0], by = -way[1];
  let point = hS[0], ahead = -Infinity, near = Infinity;
  for (const p of hS) {
    const a = (p[0] - end[0]) * way[0] + (p[1] - end[1]) * way[1];
    if (a > ahead) { ahead = a; point = p; }
    near = Math.min(near, dist(p, end));
  }
  let extent = 0;
  for (const p of hS) extent = Math.max(extent, dist(p, point));
  if (extent < 12 || extent > clamp(0.5 * len, 64, 240)) return 0;
  if (ahead < -Math.max(8, 0.2 * extent) || ahead > 0.9 * extent + 10) return 0;
  const V = dp(hS, Math.max(3, 0.12 * extent));
  if (V.length > 6 || hL > (V.length - 1) * 1.25 * extent + 12) return 0;
  // Corners at the point or at a barb's end, and nothing between: a bowl (a P, a 9) has corners all along it.
  const atPoint = (q: PtPoint): boolean => dist(q, point) <= 0.25 * extent;
  const barbs: Array<{ q: PtPoint; side: number; a: number; back: number }> = [];
  for (const q of V) {
    if (atPoint(q)) continue;
    if (dist(q, point) < 0.35 * extent) return 0;
    // Each barb runs back along the shaft, within about 60 degrees of it.
    const [qx, qy] = unit(point, q);
    const back = qx * bx + qy * by;
    if (back < 0.5) return 0;
    barbs.push({ q, side: qx * by - qy * bx, a: Math.atan2(qy, qx), back });
  }
  for (let i = 1; i < V.length; i++) if (atPoint(V[i - 1]) === atPoint(V[i])) return 0;
  if (!barbs.length) return 0;
  // One barb alone stands out to one side by 12 to 45 degrees (a wider one is the bar of a 7); a V has a barb on
  // each side, or one along the shaft and one well out (opening by 25 degrees or more): a line going on is no head.
  const left = barbs.reduce((m, b) => (b.side < m.side ? b : m)), right = barbs.reduce((m, b) => (b.side > m.side ? b : m));
  const two = left !== right;
  let open = Math.abs(left.a - right.a);
  if (open > Math.PI) open = 2 * Math.PI - open;
  if (two ? open < 0.4 || Math.max(-left.side, right.side) < 0.2 : Math.abs(left.side) < 0.2 || left.back < 0.7) return 0;
  // The shaft ends at the head: close to it, or inside the V.
  const inside = two && inTriangle(end, left.q, point, right.q);
  if (!(inside || near <= (two ? Math.max(16, 0.3 * extent) : Math.max(12, 0.15 * extent)))) return 0;
  return extent;
}

/**
 * Several strokes as one head (two barbs drawn apart): joined into one line that goes out along the first barb,
 * through the point and back along the second, so `bigHeadAt` reads them as a V. `way` says which end is the point.
 */
export function joinedHead(parts: PtPoint[][], way: PtPoint): PtPoint[] {
  if (parts.length === 1) return parts[0];
  const ahead = (p: PtPoint): number => p[0] * way[0] + p[1] * way[1];
  // The first barb ends at the point, the second starts there.
  const toPoint = (P: PtPoint[]): PtPoint[] => (ahead(P[P.length - 1]) >= ahead(P[0]) ? P : [...P].reverse());
  return [...toPoint(parts[0]), ...[...toPoint(parts[1])].reverse()];
}

/** The point `d` px along a stroke from index `i`, toward its start (`back`) or toward its end. */
function along(S: PtPoint[], i: number, back: boolean, d: number): PtPoint {
  const step = back ? -1 : 1;
  let acc = 0;
  for (let k = i; k + step >= 0 && k + step < S.length; k += step) {
    acc += dist(S[k], S[k + step]);
    if (acc >= d) return S[k + step];
  }
  return S[back ? 0 : S.length - 1];
}

/** Which way a stroke runs into its point at index `i`: from its last stretch before it (`back`), or, at its start, from the stretch after it. */
function wayInto(S: PtPoint[], i: number, back: boolean, len: number): PtPoint {
  return unit(along(S, i, back, clamp(0.15 * len, 15, 80)), S[i]);
}

/** A stroke that can be the shaft of an arrow once a head is at one of its ends: long, open, no squiggle or scribble. */
const shaftLike = (f: Features): boolean => !f.tap && !f.closed && !f.wavy && !f.scribble && !f.xmark && f.chord >= 50 && f.L >= 60;

/**
 * Which of the strokes are an arrow: the shaft, and the short strokes that are its head (one V, two barbs,
 * drawn before or after the shaft, at either end of it). The head decides which way the arrow points; with
 * none, the way the shaft was drawn does. The tip is the point of the head, not the end of a barb.
 *
 * A straight-ish (arrow-like) shaft is an arrow alone. A curved one (a C, an S, a U-turn) is an arrow only with a
 * head at one of its real ends: the head is the evidence, and the tip is past that end, not at the farthest point.
 */
export function arrowParts(fs: Features[]): ArrowParts | null {
  const order = fs.map((_, i) => i).filter(i => fs[i].arrowish || shaftLike(fs[i])).sort((a, b) => fs[b].L - fs[a].L);
  let plainShaft: ArrowParts | null = null;
  for (const shaft of order) {
    const s = fs[shaft], S = s.S, last = S.length - 1;
    // Its ends: for an arrow-like stroke its tip (a hook drawn with it lies past that) and its start; else its real ends.
    const ti = s.arrowish ? Math.max(0, S.indexOf(s.tip)) : last;
    const tipEnd = S[ti];
    const toTip = { len: s.L, way: wayInto(S, ti, true, s.L) }, toStart = { len: s.L, way: wayInto(S, 0, false, s.L) };
    const others = fs.map((f, i) => ({ f, i })).filter(x => x.i !== shaft && x.f.L <= 0.9 * s.L);
    const headAt = (f: Features, end: PtPoint, from: PtPoint, big: { len: number; way: PtPoint }): boolean =>
      (s.arrowish && f.L <= 0.7 * s.L && f.L <= 120 && !f.tap && f.L >= 6 && smallHeadAt(f, end, from)) || (!f.tap && bigHeadAt(f.S, f.L, end, big.way, big.len) > 0);
    // The strokes that are a head at one end: each alone, or two barbs drawn apart that together are a V.
    const headsAt = (end: PtPoint, from: PtPoint, big: { len: number; way: PtPoint }): number[] => {
      const one = others.filter(x => headAt(x.f, end, from, big)).map(x => x.i);
      const rest = others.filter(x => !one.includes(x.i) && !x.f.tap && x.f.L <= 0.6 * s.L);
      const pool = [...others.filter(x => one.includes(x.i)), ...rest];
      for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) {
        const A = pool[a], B = pool[b];
        if (one.includes(A.i) && one.includes(B.i)) continue;
        if (bigHeadAt(joinedHead([A.f.S, B.f.S], big.way), A.f.L + B.f.L, end, big.way, big.len) > 0) return [...new Set([...one, A.i, B.i])];
      }
      return one;
    };
    const atTip = headsAt(tipEnd, s.start, toTip);
    const atStart = headsAt(s.start, tipEnd, toStart);
    if (!atTip.length && !atStart.length) {
      if (s.arrowish && !plainShaft) plainShaft = { shaft, heads: [], F: s };
      continue;
    }
    const flip = atStart.length > atTip.length;
    const heads = (flip ? atStart : atTip).slice(0, 3);
    let F: Features;
    if (s.arrowish) {
      F = flip ? analyze([...S].reverse()) : s;
      if (!F.arrowish) continue;
    } else {
      const P = flip ? [...S].reverse() : S;
      F = analyze(P);
      F = { ...F, tip: F.S[F.S.length - 1] };
    }
    // The point of the head: the farthest point along the arrow's way, within reach of the shaft's end.
    const way = s.arrowish ? unit(F.start, F.tip) : (flip ? toStart.way : toTip.way);
    const end = F.tip;
    const endWay = flip ? toStart.way : toTip.way;
    let size = 0;
    for (const i of heads) size = Math.max(size, bigHeadAt(fs[i].S, fs[i].L, end, endWay, s.L));
    if (heads.length >= 2) size = Math.max(size, bigHeadAt(joinedHead([fs[heads[0]].S, fs[heads[1]].S], endWay), fs[heads[0]].L + fs[heads[1]].L, end, endWay, s.L));
    const reach = Math.max(30, 0.95 * size);
    let tip = F.tip, best = 0;
    for (const i of heads) for (const p of fs[i].S) {
      const pr = (p[0] - end[0]) * way[0] + (p[1] - end[1]) * way[1];
      if (pr > best && dist(p, end) <= reach) { best = pr; tip = p; }
    }
    if (tip !== F.tip) F = { ...F, tip };
    return { shaft, heads, F, ...(size > 0 ? { shaped: true as const } : {}) };
  }
  return plainShaft;
}

/**
 * One stroke that is a curved shaft with its head drawn on in the same stroke (a hook, or a V): the stroke read
 * from its start to the point of the head, or null. The head is what follows a sharp turn near the end; the
 * shaft before it must be open (no loop, at most about two thirds of a turn round) and no squiggle.
 */
export function curvedArrow(F: Features): Features | null {
  // (The whole stroke may read as a scribble: a V drawn on adds sharp turns. The shaft before it may not.)
  if (F.tap || F.closed || F.wavy || F.xmark || F.arrowish || F.L < 120) return null;
  const S = F.S, K = 4;
  for (let i = S.length - 1 - K; i >= K; i--) {
    const v1x = S[i][0] - S[i - K][0], v1y = S[i][1] - S[i - K][1], v2x = S[i + K][0] - S[i][0], v2y = S[i + K][1] - S[i][1];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 6 || l2 < 6 || Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) < 1.3) continue;
    const shaftPts = S.slice(0, i + 1), rest = S.slice(i);
    const sh = analyze(shaftPts);
    if (sh.L < 0.6 * F.L) break;
    if (!shaftLike(sh) || Math.abs(sh.turn) > 4.2 || sh.chord / sh.L < 0.2) continue;
    let rl = 0;
    for (let k = 1; k < rest.length; k++) rl += dist(rest[k - 1], rest[k]);
    // A head drawn on is smaller than the shaft by some way: a triangle in one stroke is two sides and a third, no arrow.
    const size = bigHeadAt(rest, rl, S[i], wayInto(shaftPts, shaftPts.length - 1, true, sh.L), sh.L);
    if (size > 0 && size <= 0.35 * sh.L) return { ...sh, tip: S[i] };
  }
  return null;
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
