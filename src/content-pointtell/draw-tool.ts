/**
 * Point and tell: the tool under the pointer. A press that moves a few pixels is a stroke (the brush pen
 * draws it, or the eraser takes the strokes it crosses); a press that does not is a click on an object
 * (a note on it). There is no switch between the two.
 *
 * Nothing here changes how a stroke looks. When it ends it is handed to ink-marks, which keeps it, reads it
 * quietly and opens the comment field beside where the pen lifted.
 */
import { Pen, packStroke } from '../lib/point-tell/ink-pen';
import type { PtMark, PtPoint } from '../lib/point-tell/types';
import { clearHover, clickAt, hoverAt } from './actions';
import { look, react } from './mascot';
import { SETTLE_MS, markRead } from './response';
import { INK_COLOR } from './ink-canvas';
import { commitStroke, eraseStrokes, visibleStrokes } from './ink-marks';
import { closeEditorKeeping, openInkMark } from './marks';
import type { PtPointer, PtTool } from './pointer';
import { pt } from './state';

const svgCursor = (svg: string, hot: number, fallback: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, ${fallback}`;

const PEN_CURSOR = svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="5.6" fill="#fff"/><circle cx="12" cy="12" r="4.4" fill="${INK_COLOR}" fill-opacity=".4" stroke="${INK_COLOR}" stroke-width="1.2"/></svg>`, 12, 'crosshair');
const ERASER_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="11" fill="rgba(255,255,255,.5)" stroke="#4a4f66" stroke-width="1.4" stroke-dasharray="3 2.5"/></svg>', 14, 'crosshair');

export const cursorFor = (): string => (pt.tool === 'eraser' ? ERASER_CURSOR : PEN_CURSOR);

/** How far from a stroke's line the eraser still takes it (px). */
const ERASE_SLOP = 8;

/** The field waits this long after the pen lifts, so a stroke that follows is never interrupted by it. */
export const FIELD_DELAY_MS = 600;
/** A mark of several strokes, or a box (the start of a sketch), waits longer: the next line of a table is likely coming. */
export const SKETCH_FIELD_DELAY_MS = 1600;
let fieldTimer = 0;
const sketching = (m: PtMark): boolean => (m.meaning?.kind === 'add' && (m.meaning.tab || m.meaning.page) ? false : (m.ink?.strokes.length ?? 0) >= 2 || m.meaning?.kind === 'add');

export function drawTool(openFor: (ids: string[]) => void): PtTool {
  let pen: Pen | null = null;
  let startedAt = 0;
  let last: PtPointer | null = null;
  let erased = new Set<string>();

  const eraseSegment = (a: PtPointer, b: PtPointer): void => {
    const keys = pt.ink?.hits(a.x, a.y, b.x, b.y, ERASE_SLOP) ?? [];
    let changed = false;
    for (const k of keys) if (!erased.has(k)) { erased.add(k); changed = true; }
    // The strokes vanish as the eraser crosses them; one undo step brings them all back.
    if (changed) pt.ink?.setStrokes(visibleStrokes().filter(s => !erased.has(s.key)));
  };

  const feed = (p: PtPointer): void => { pen?.move(p.x, p.y, p.t, p.pressure); };

  return {
    id: 'draw',
    cursor: cursorFor,
    hover: (p) => { look(p.cx, p.cy); hoverAt(p); },
    leave: () => { clearHover(); look(null); },

    click: (p) => {
      if (pt.tool === 'eraser') { erased = new Set(); eraseSegment(p, p); const k = [...erased]; erased = new Set(); eraseStrokes(k); return; }
      closeEditorKeeping();
      clickAt(p, openFor);
    },

    strokeStart: (buffered) => {
      const first = buffered[0];
      if (!first) return;
      clearHover();
      if (pt.tool === 'eraser') {
        erased = new Set();
        last = first;
        for (const p of buffered.slice(1)) { eraseSegment(last, p); last = p; }
        return;
      }
      // Starting the next stroke closes the comment field of the last one: its words and its mark stay.
      if (fieldTimer) { clearTimeout(fieldTimer); fieldTimer = 0; }
      closeEditorKeeping();
      if (!pt.ink) return;
      pen = new Pen();
      startedAt = first.t;
      pen.down(first.x, first.y, first.t, first.pressure, first.type);
      for (const p of buffered.slice(1)) feed(p);
      pt.ink.begin(pen);
      look(first.cx, first.cy);
    },

    strokeMove: (samples, predicted) => {
      if (pt.tool === 'eraser') {
        for (const p of samples) { if (last) eraseSegment(last, p); last = p; }
        look(samples[samples.length - 1].cx, samples[samples.length - 1].cy);
        return;
      }
      if (!pen || !pt.ink) return;
      for (const p of samples) feed(p);
      if (predicted.length) pen.setPred(predicted.map(p => ({ x: p.x, y: p.y })));
      pt.ink.invalidate();
      const tip = samples[samples.length - 1];
      look(tip.cx, tip.cy);
    },

    strokeEnd: (p) => {
      if (pt.tool === 'eraser') {
        const keys = [...erased];
        erased = new Set(); last = null;
        if (keys.length) eraseStrokes(keys); else pt.ink?.setStrokes(visibleStrokes());
        return;
      }
      const drawing = pen;
      pen = null;
      if (!drawing || !pt.ink) return;
      feed(p);
      const raw = drawing.path();
      const cps = drawing.up(p.t);
      const packed = packStroke(cps);
      pt.ink.end();
      const mark = commitStroke({
        stroke: { points: packed.points as PtPoint[], r: packed.r },
        raw: raw as PtPoint[],
        startedAt,
        endedAt: p.t,
      });
      react('blink');
      if (mark) {
        markRead(mark.n, sketching(mark) ? SKETCH_FIELD_DELAY_MS : SETTLE_MS);
        const lift: [number, number] = [raw[raw.length - 1][0], raw[raw.length - 1][1]];
        const gen = pt.gen;
        const sketch = sketching(mark);
        fieldTimer = window.setTimeout(() => { fieldTimer = 0; if (pt.active && pt.gen === gen && !pt.ink?.drawing) openInkMark(mark.n, lift); }, sketch ? SKETCH_FIELD_DELAY_MS : FIELD_DELAY_MS);
      }
      else pt.ink.setStrokes(visibleStrokes());
    },

    strokeCancel: () => {
      pen = null;
      if (fieldTimer) { clearTimeout(fieldTimer); fieldTimer = 0; }
      pt.ink?.end();
      erased = new Set(); last = null;
      pt.ink?.setStrokes(visibleStrokes());
    },
  };
}

