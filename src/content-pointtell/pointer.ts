/**
 * Point and tell: the layer that owns the pointer. A transparent surface covers the window, so the page
 * under it does not react while the mode is on; what the pointer means is up to the ACTIVE TOOL.
 *
 * One press is either a CLICK (it did not move more than a few pixels: a note on the object under it) or
 * a STROKE (it did). There is no switch between the two. A stroke hands the tool every sample the browser
 * has (coalesced events) and the browser's prediction of where the pen goes next.
 *
 * The wheel scrolls the page (or the scroller under the pointer) as usual. With touch, one finger draws and
 * two fingers scroll the page: a second finger cancels the stroke the first one began.
 */
import { TAB_PILL } from './measure';
import { pt } from './state';
import { placed, Z } from './view';

/** A pointer sample in the coordinates tools work in. */
export interface PtPointer {
  /** Document (page) coordinates: where a mark is stored. */
  x: number;
  y: number;
  /** Window coordinates, for elementFromPoint and the like. */
  cx: number;
  cy: number;
  alt: boolean;
  shift: boolean;
  /** Event time (ms, the same clock as performance.now()). */
  t: number;
  /** 0..1; 0.5 for a mouse while pressed. */
  pressure: number;
  /** 'mouse' | 'pen' | 'touch'. */
  type: string;
}

export interface PtTool {
  id: string;
  /** The CSS cursor over the surface. */
  cursor: () => string;
  /** The pointer moved with no button down. */
  hover?(p: PtPointer): void;
  /** A press moved past the threshold: a stroke began where it went down. `buffered` holds the samples since, the down point first. */
  strokeStart?(buffered: PtPointer[]): void;
  /** More samples of the stroke, and where the browser thinks the pen goes next. */
  strokeMove?(samples: PtPointer[], predicted: PtPointer[]): void;
  /** The button went up after a stroke. */
  strokeEnd?(p: PtPointer): void;
  /** The stroke was interrupted (a second finger, the pointer was lost): nothing is kept. */
  strokeCancel?(): void;
  /** The button went up without a stroke. */
  click?(p: PtPointer): void;
  /** The pointer left the window, or the tool was switched off. */
  leave?(): void;
}

/** Pixels of movement before a press is a stroke and not a click. */
export const STROKE_THRESHOLD = 4;

let active: PtTool | null = null;
let press: { id: number; x: number; y: number; stroke: boolean; buffer: PtPointer[] } | null = null;
let surfaceEl: HTMLElement | null = null;
const touches = new Map<number, { x: number; y: number }>();
let touchScroll = false;

const toPointer = (e: PointerEvent | MouseEvent): PtPointer => ({
  x: e.clientX + window.scrollX, y: e.clientY + window.scrollY, cx: e.clientX, cy: e.clientY, alt: e.altKey, shift: e.shiftKey,
  t: e.timeStamp,
  pressure: 'pressure' in e ? e.pressure : 0.5,
  type: 'pointerType' in e ? e.pointerType : 'mouse',
});

/** Whether a stroke is being drawn (the wheel waits for it to end). */
export const isStroking = (): boolean => !!press?.stroke;

/** The wheel goes to the page's own scroller under the surface when it can move that way, else the window. */
function forwardWheel(e: WheelEvent, surface: HTMLElement): void {
  const prev = surface.style.pointerEvents;
  surface.style.pointerEvents = 'none';
  let el = document.elementFromPoint(e.clientX, e.clientY);
  surface.style.pointerEvents = prev;
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const y = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const x = /auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const canY = y && (e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    const canX = x && (e.deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    if ((e.deltaY && canY) || (e.deltaX && canX)) { el.scrollBy(e.deltaX, e.deltaY); e.preventDefault(); return; }
  }
  // Otherwise the event goes on to the window, which scrolls the page.
}

/** Put the surface in the layer and give it to `tool`. */
export function installSurface(layer: HTMLElement, tool: PtTool): HTMLElement {
  const s = placed(document.createElement('div'), 'fixed', Z.surface);
  s.className = 'pt-surface';
  s.style.top = '0'; s.style.left = '0'; s.style.right = '0'; s.style.bottom = '0';
  s.style.pointerEvents = 'auto';
  s.style.touchAction = 'none';
  s.style.cursor = tool.cursor();
  active = tool;
  surfaceEl = s;

  const cancelStroke = (): void => {
    const was = press;
    press = null;
    if (was?.stroke) active?.strokeCancel?.();
  };

  s.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (e.pointerType === 'touch') {
      const prev = touches.get(e.pointerId);
      if (prev) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touchScroll) {
          // Two fingers move the page: the average of how far they went.
          window.scrollBy(-(e.clientX - prev.x) / touches.size, -(e.clientY - prev.y) / touches.size);
          return;
        }
      }
    }
    if (press && e.pointerId === press.id) {
      const p = toPointer(e);
      if (!press.stroke) {
        press.buffer.push(p);
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= STROKE_THRESHOLD) {
          press.stroke = true;
          active.strokeStart?.(press.buffer.slice());
          press.buffer = [];
        }
        return;
      }
      const samples = (e.getCoalescedEvents ? e.getCoalescedEvents() : []).map(toPointer);
      if (!samples.length) samples.push(p);
      const predicted = (e.getPredictedEvents ? e.getPredictedEvents() : []).map(toPointer);
      active.strokeMove?.(samples, predicted);
    } else if (!press && e.pointerType !== 'touch') active.hover?.(toPointer(e));
  });

  s.addEventListener('pointerdown', (e) => {
    if (!active) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size >= 2) {
        // A second finger: the stroke the first one began is dropped and the two fingers scroll.
        cancelStroke();
        touchScroll = true;
        e.preventDefault();
        return;
      }
    } else if (e.button !== 0) return;
    e.preventDefault(); // no focus change, no text selection under the surface
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, stroke: false, buffer: [toPointer(e)] };
    try { s.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  });

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    try { s.releasePointerCapture(e.pointerId); } catch { /* released already */ }
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      const scrolling = touchScroll;
      if (!touches.size) touchScroll = false;
      if (scrolling) return;
    }
    if (!active || !press || press.id !== e.pointerId) return;
    const was = press;
    press = null;
    if (cancelled) { if (was.stroke) active.strokeCancel?.(); return; }
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    const p = toPointer(e);
    if (was.stroke) active.strokeEnd?.(p); else active.click?.(p);
  };
  s.addEventListener('pointerup', (e) => finish(e, false));
  s.addEventListener('pointercancel', (e) => finish(e, true));
  s.addEventListener('pointerleave', () => { if (!press) active?.leave?.(); });
  s.addEventListener('wheel', (e) => { if (press?.stroke) { e.preventDefault(); return; } forwardWheel(e, s); }, { passive: false });
  // The page's own click, double click and context menu must not reach what is under the surface.
  for (const type of ['click', 'dblclick', 'contextmenu', 'auxclick'] as const) s.addEventListener(type, (e) => e.stopPropagation());
  layer.appendChild(s);
  return s;
}

/** The cursor over the surface changes with the tool. */
export function setSurfaceCursor(cursor: string): void { if (surfaceEl) surfaceEl.style.cursor = cursor; }

/** Take the pointer away from the active tool (the mode is closing or the surface is rebuilt). */
export function releasePointer(): void {
  active?.leave?.();
  active = null;
  press = null;
  surfaceEl = null;
  touches.clear();
  touchScroll = false;
}

/** BMP's own tab pill under the pointer, seen through the surface; null when there is none. */
export function nativeTabAt(cx: number, cy: number): HTMLElement | null {
  const surface = pt.surface;
  if (!surface) return null;
  const prev = surface.style.pointerEvents;
  surface.style.pointerEvents = 'none';
  const el = document.elementFromPoint(cx, cy);
  surface.style.pointerEvents = prev;
  const tab = el?.closest<HTMLElement>(TAB_PILL);
  return tab ? (tab.querySelector<HTMLElement>('a') ?? tab) : null;
}

/** Press a BMP element the way a hand would (the sequence Blueprint's own tab bar uses). */
export function pressNative(el: HTMLElement): void {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
    el.dispatchEvent(type.startsWith('pointer')
      ? new PointerEvent(type, { bubbles: true, cancelable: true, view: window, pointerId: 1 })
      : new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  }
}

/** Switch BMP to the tab with this name (the pill's own text). False when no such pill is on the page. */
export function pressTabNamed(name: string): boolean {
  const norm = (t: string): string => t.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const tab = [...document.querySelectorAll<HTMLElement>(TAB_PILL)].find(t => norm(t.textContent ?? '') === norm(name));
  if (!tab) return false;
  pressNative(tab.querySelector<HTMLElement>('a') ?? tab);
  return true;
}
