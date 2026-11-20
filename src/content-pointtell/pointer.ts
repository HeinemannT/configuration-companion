/**
 * Point and tell: the layer that owns the pointer. A transparent surface covers the window, so the page
 * under it does not react while the mode is on; what the pointer means is up to the ACTIVE TOOL.
 *
 * One press is either a CLICK (it did not move more than a few pixels: a note on the object under it) or
 * a STROKE (it did). There is no switch between the two. A stroke hands the tool every sample the browser
 * has (coalesced events) and the browser's prediction of where the pen goes next. When the tool says a press
 * may HOLD (voice comments are on), a press that stays still long enough starts voice instead
 * (lib/point-tell/press-hold): it listens until the pointer goes up, is cancelled, or the window loses focus.
 *
 * The wheel scrolls the page (or the scroller under the pointer) as usual. With touch, one finger draws and
 * two fingers scroll the page: a second finger cancels the stroke the first one began.
 */
import { Press, STILL_PX } from '../lib/point-tell/press-hold';
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
  /** A press went down: whether staying still may start voice. True: the tool shows its quiet cue. */
  holdable?(p: PtPointer): boolean;
  /** The press moved, went up or was lost before the hold: the cue goes. */
  holdDisarm?(): void;
  /** The press stayed still: start voice there. False when it did not (the press then goes on as a click or a stroke). */
  holdStart?(p: PtPointer): boolean;
  /** A hold ended (up, cancelled, the window lost focus): voice stops and keeps what was heard. */
  holdEnd?(): void;
}

/** Pixels of movement before a press is a stroke and not a click (and no longer still enough to start voice). */
export const STROKE_THRESHOLD = STILL_PX;

let active: PtTool | null = null;
let press: { id: number; g: Press; buffer: PtPointer[] } | null = null;
let onBlur: (() => void) | null = null;
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
export const isStroking = (): boolean => press?.g.phase === 'stroke';

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

  /** The press is lost: a stroke is dropped, a hold ends (keeping what was heard), a charging cue goes. */
  const cancelPress = (): void => {
    const was = press;
    press = null;
    if (!was) return;
    const charging = was.g.charging;
    const phase = was.g.cancel();
    if (phase === 'stroke') active?.strokeCancel?.();
    else if (phase === 'held') active?.holdEnd?.();
    else if (charging) active?.holdDisarm?.();
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
      // A hold listens: the pointer may wander, nothing is drawn.
      if (press.g.phase === 'held') return;
      if (press.g.phase === 'press') {
        press.buffer.push(p);
        const charging = press.g.charging;
        if (press.g.move(e.clientX, e.clientY) === 'stroke') {
          if (charging) active.holdDisarm?.();
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
        cancelPress();
        touchScroll = true;
        e.preventDefault();
        return;
      }
    } else if (e.button !== 0) return;
    e.preventDefault(); // no focus change, no text selection under the surface
    if (press) cancelPress(); // a press whose up was lost is not left behind
    const down = toPointer(e);
    const holdable = !!active.holdable?.(down);
    const g: Press = new Press(e.clientX, e.clientY, {
      holdable,
      // Voice starts where the press went down (the pointer is still within a few pixels of it).
      onHold: () => (press?.g === g && active?.holdStart ? active.holdStart(down) : false),
    });
    press = { id: e.pointerId, g, buffer: [down] };
    try { s.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  });

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      const scrolling = touchScroll;
      if (!touches.size) touchScroll = false;
      if (scrolling) { try { s.releasePointerCapture(e.pointerId); } catch { /* released already */ } return; }
    }
    const mine = !!active && !!press && press.id === e.pointerId;
    if (mine && cancelled) cancelPress();
    // Taken before the capture is released: releasing may report the lost capture at once.
    const was = mine && !cancelled ? press : null;
    if (was) press = null;
    try { s.releasePointerCapture(e.pointerId); } catch { /* released already */ }
    if (!was || !active) return;
    const charging = was.g.charging;
    const kind = was.g.up();
    if (kind === 'held') { active.holdEnd?.(); return; }
    if (charging) active.holdDisarm?.();
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    const p = toPointer(e);
    if (kind === 'stroke') active.strokeEnd?.(p); else active.click?.(p);
  };
  s.addEventListener('pointerup', (e) => finish(e, false));
  s.addEventListener('pointercancel', (e) => finish(e, true));
  // A hold whose pointer capture is taken away (the browser took the pointer) ends like a cancel.
  s.addEventListener('lostpointercapture', (e) => { if (press?.id === e.pointerId && press.g.phase === 'held') finish(e, true); });
  s.addEventListener('pointerleave', (e) => {
    if (!press) { active?.leave?.(); return; }
    // Without capture, a hold that leaves the surface ends (with capture the surface keeps the pointer).
    if (press.id === e.pointerId && press.g.phase === 'held' && !s.hasPointerCapture(e.pointerId)) finish(e, true);
  });
  // The window lost focus (another window, a dialog): a hold ends and keeps its words, a charging press is dropped.
  if (onBlur) window.removeEventListener('blur', onBlur);
  onBlur = () => { if (press && press.g.phase !== 'stroke') cancelPress(); };
  window.addEventListener('blur', onBlur);
  s.addEventListener('wheel', (e) => { if (press && press.g.phase !== 'press') { e.preventDefault(); return; } forwardWheel(e, s); }, { passive: false });
  // The page's own click, double click and context menu must not reach what is under the surface.
  for (const type of ['click', 'dblclick', 'contextmenu', 'auxclick'] as const) s.addEventListener(type, (e) => e.stopPropagation());
  layer.appendChild(s);
  return s;
}

/** The cursor over the surface changes with the tool. */
export function setSurfaceCursor(cursor: string): void { if (surfaceEl) surfaceEl.style.cursor = cursor; }

/** Take the pointer away from the active tool (the mode is closing or the surface is rebuilt). */
export function releasePointer(): void {
  if (press?.g.phase === 'held') active?.holdEnd?.();
  else if (press?.g.charging) active?.holdDisarm?.();
  press?.g.cancel();
  if (onBlur) { window.removeEventListener('blur', onBlur); onBlur = null; }
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
