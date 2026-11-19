/**
 * Point and tell: a page drawn past the last breadcrumb. The same small shapes as a drawn tab (an arch, a small
 * closed loop or box, a small plus) on the breadcrumb row, to the right of the last crumb, are a new page. Pure.
 * The name comes from the words typed after; the parent is offered on the card, not decided here.
 */
import { analyze } from './ink-features';
import { isArch, isLoop, isPlus } from './tab-read';
import { contains, type Rect } from './hit';
import type { InkReading, InkStroke } from './ink-read';
import { inkBounds, type PtScene } from './resolve';

/** The reading of strokes drawn past the last crumb, or null when they are not a new page. */
export function crumbReading(scene: PtScene, strokes: ReadonlyArray<InkStroke>): InkReading | null {
  const row = scene.crumbRow;
  if (!row || strokes.length < 1 || strokes.length > 3) return null;
  const box = inkBounds(strokes);
  if (!box) return null;
  const rect = row.rect;
  const band: Rect = { left: rect.left - 6, top: rect.top - 14, width: rect.width + 6, height: rect.height + 28 };
  const pts = strokes.flatMap(s => s.points);
  if (pts.filter(p => contains(band, p[0], p[1])).length / pts.length < 0.85) return null;
  if (box.width < (strokes.length === 2 ? 10 : 28) || box.width > 240 || box.height < 10 || box.height > rect.height + 28) return null;
  const fs = strokes.map(s => analyze(s.points));
  const shaped = strokes.length === 1 ? isArch(fs[0], box) || isLoop(fs[0], box) : isPlus(fs, box);
  if (!shaped) return null;
  const words = `New page under ${row.parent ?? 'this page'}`;
  return { kind: 'add', targets: [], meaning: { kind: 'add', page: true, place: { into: 'draft:page' }, words }, place: {}, reading: words };
}
