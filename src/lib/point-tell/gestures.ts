/**
 * Point and tell: the small rules that read one gesture each, kept apart from the reader that tries them.
 * Pure functions over a scene and the shapes of strokes (ink-features); each returns what it found or null,
 * so a rule is tested alone and a new gesture is one more function here.
 *
 *   struckThrough    a straight line across an object, both ends on it: crossed out
 *   pointerTarget    an arrow from empty space that ends on an object: about that object
 *   arrowOf          an arrow that starts on an object and ends elsewhere
 *   pairMove         such an arrow that ends inside a drawn square: put that object there, at that width
 *
 * When unsure each returns null: the reader then falls back to the weaker reading.
 */
import { findNode } from '../layout/model';
import { centre, contains, hitTest, type PtTarget } from './hit';
import { analyze, type Features } from './ink-features';
import { dist } from './ink-geom';
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

/** Which of the strokes are an arrow: the arrow-like shaft, and the short strokes at its ends that are its head. */
function arrowParts(fs: Features[]): { shaft: number; heads: number[] } | null {
  let shaft = -1;
  fs.forEach((f, i) => { if (f.arrowish && (shaft < 0 || f.L > fs[shaft].L)) shaft = i; });
  if (shaft < 0) return null;
  const s = fs[shaft];
  const near = (p: PtPoint): number => Math.min(dist(p, s.end), dist(p, s.start));
  const heads = fs.flatMap((f, i) => (i !== shaft && f.L <= 70 && f.L <= 0.6 * s.L && (near(f.S[0] ?? s.end) <= 28 || near(f.S[f.S.length - 1] ?? s.end) <= 28) ? [i] : []));
  return { shaft, heads: heads.slice(0, 2) };
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
  return endsOf(scene, fs[parts.shaft]);
}

/** A group of strokes split into an arrow (starting on an object) and the rest; null when there is no such arrow or nothing else. */
export function splitArrow(scene: PtScene, strokes: ReadonlyArray<InkStroke>, fs: Features[]): { arrow: InkStroke[]; rest: InkStroke[]; ends: ArrowEnds } | null {
  const parts = arrowParts(fs);
  if (!parts) return null;
  const ends = endsOf(scene, fs[parts.shaft]);
  if (!ends) return null;
  const used = new Set([parts.shaft, ...parts.heads]);
  const rest = strokes.filter((_, i) => !used.has(i));
  if (!rest.length) return null;
  return { arrow: strokes.filter((_, i) => used.has(i)), rest, ends };
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
