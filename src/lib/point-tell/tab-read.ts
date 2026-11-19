/**
 * Point and tell: a tab drawn on the tab row. Pure: reads strokes against the measured tab row and the real
 * pills (plus the tabs drawn before). A small tab shape (an arch standing on the row), a small closed loop or box,
 * or a small plus, past the last tab or in a gap between two tabs, is a new tab beside its left neighbour. A flat
 * line is never a tab (it is an underline, or plain ink); a loop round a tab is "this tab"; an arrow from a tab is not a
 * tab shape and stays a move. When unsure the answer is null and the reader falls back to what it read before.
 */
import { findNode } from '../layout/model';
import { area, centre, contains, intersection, type Rect } from './hit';
import { analyze, type Features } from './ink-features';
import type { InkReading, InkStroke } from './ink-read';
import { inkBounds, type PtScene } from './resolve';
import type { PtPoint } from './types';

/** How far above and below the row's pills a tab stroke may stray (px). */
const BAND = 14;

const nameOf = (scene: PtScene, id: string): string => findNode(scene.model, id)?.node.name ?? id;

function median(xs: number[]): number { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; }

/** An arch standing on the row: starts and ends low, a flat top between, open at the bottom. */
export function isArch(F: Features, box: Rect): boolean {
  if (F.tap || F.closed || box.height < 14 || box.width < 28 || F.wavy || F.scribble) return false;
  const low = box.top + box.height * 0.5;
  if (F.start[1] < low || F.end[1] < low) return false;
  if (Math.abs(F.start[0] - F.end[0]) < 0.5 * box.width) return false;
  const topBand = box.top + box.height * 0.3;
  return F.S.filter(p => p[1] <= topBand).length / F.S.length >= 0.28;
}

/** A small closed loop or rough box. */
export function isLoop(F: Features, box: Rect): boolean {
  if (F.tap || box.height < 14 || box.width < 28) return false;
  return F.closed || (F.corners >= 3 && F.rectness >= 0.6 && F.closure < 0.4);
}

function segCross(a: PtPoint, b: PtPoint, c: PtPoint, d: PtPoint): boolean {
  const o = (p: PtPoint, q: PtPoint, r: PtPoint): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Two short straight strokes that cross: a plus. */
export function isPlus(fs: Features[], box: Rect): boolean {
  if (fs.length !== 2 || box.width > 44 || box.height > 44 || box.width < 10 || box.height < 10) return false;
  const straight = (f: Features): boolean => !f.tap && f.chord / f.L >= 0.8;
  return straight(fs[0]) && straight(fs[1]) && segCross(fs[0].start, fs[0].end, fs[1].start, fs[1].end);
}

/** The reading of strokes drawn on the tab row, or null when they are not a new tab. */
export function tabReading(scene: PtScene, strokes: ReadonlyArray<InkStroke>): InkReading | null {
  const row = scene.tabRow?.rect;
  if (!row || strokes.length < 1 || strokes.length > 3) return null;
  const pills = scene.pills.slice().sort((a, b) => a.rect.left - b.rect.left);
  // A tab row with no tabs is the paper page's: the first tab goes into the page.
  if (!pills.length && scene.paperPage !== true) return null;
  const box = inkBounds(strokes);
  if (!box) return null;
  const H = median(pills.map(p => p.rect.height)) || row.height || 30;
  if (box.width < (strokes.length === 2 ? 10 : 28) || box.width > 240 || box.height > 1.8 * H || box.height < 10) return null;
  const band: Rect = { left: row.left - BAND, top: row.top - BAND, width: row.width + 2 * BAND, height: row.height + 2 * BAND };
  const pts = strokes.flatMap(s => s.points);
  if (pts.filter(p => contains(band, p[0], p[1])).length / pts.length < 0.85) return null;
  // Not a loop round a tab, and little overlap with the tabs it sits among (a tab shape drawn into a narrow gap may touch its neighbours).
  if (pills.some(p => contains(box, ...centre(p.rect)))) return null;
  const overlap = pills.reduce((s, p) => s + Math.max(0, Math.min(box.left + box.width, p.rect.left + p.rect.width) - Math.max(box.left, p.rect.left)), 0);
  if (overlap > 0.35 * box.width || pills.some(p => intersection(p.rect, box) > 0.3 * area(box))) return null;

  const fs = strokes.map(s => analyze(s.points));
  const shaped = strokes.length === 1 ? isArch(fs[0], box) || isLoop(fs[0], box) : isPlus(fs, box);
  if (!shaped) return null;
  // Beside the tab to its left; left of the first tab it goes before it.
  const cx = box.left + box.width / 2;
  const leftOf = pills.filter(p => p.rect.left + p.rect.width <= cx + 4);
  const anchor = leftOf[leftOf.length - 1];
  if (!pills.length) return { kind: 'add', targets: [], meaning: { kind: 'add', tab: true, place: { into: 'draft:page' }, words: 'the first tab of the page' }, place: {}, reading: 'Add the first tab' };
  const place = anchor ? { after: anchor.id } : { before: pills[0].id };
  const target = anchor ?? pills[0];
  const words = `${anchor ? 'after' : 'before'} tab "${nameOf(scene, target.id)}"`;
  const reading = `Add tab ${anchor ? 'after' : 'before'} ${nameOf(scene, target.id)}`;
  return { kind: 'add', targets: [], meaning: { kind: 'add', tab: true, place, words }, place: {}, reading };
}
