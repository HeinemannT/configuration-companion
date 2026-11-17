/**
 * The outline of a marked object in Inspect mode: one `.crev-frame` child
 * per marked host, drawn over the host without touching the page's own
 * borders, outline or pseudo-elements (BMP renders some content with its
 * own ::after). The frame never takes pointer events.
 *
 *  - At rest: corner ticks in a darker tone of the type colour (lib/
 *    badge-look.ts tickColor, readable on white). On hover or focus of the
 *    element or its badge: the full outline, about 1.5px, and a faint tint.
 *  - Nesting: containers dashed and 3px outside, widgets solid, parts short
 *    thin ticks (no dot); hovering an element lights its ancestors' ticks (all
 *    CSS, content-overlay.css, via :has()).
 *  - Dark and image backgrounds: a white keyline and a soft halo.
 *
 * Classification and background detection are reads done inside the badge
 * layout pass (content-badge-layout.ts), which writes the classes after all
 * reads: no layout thrash, no per-frame work. The backdrop is computed once
 * per host and kept on the frame.
 *
 * Critical layout of the frame (position, z-index, pointer-events) is set
 * inline here, so a broken stylesheet cannot drop it into page flow.
 */

import { classifyBackdrop, isChartType, nestingLevel, samplePaints, tickColor, type Backdrop, type BackgroundSample, type NestingLevel } from './lib/badge-look';

export const FRAME_CLASS = 'crev-frame';
/** Below the badge (10000), above the host's own content. */
export const FRAME_Z_INDEX = '9999';

/** The frame of `host`, if it has one. */
export function frameOf(host: Element): HTMLElement | null {
  for (const c of host.children) if (c instanceof HTMLElement && c.classList.contains(FRAME_CLASS)) return c;
  return null;
}

/** Add (or find) the frame of a marked host. */
export function ensureFrame(host: HTMLElement): HTMLElement {
  const found = frameOf(host);
  if (found) return found;
  const f = document.createElement('span');
  f.className = FRAME_CLASS;
  f.setAttribute('aria-hidden', 'true');
  f.style.position = 'absolute';
  f.style.zIndex = FRAME_Z_INDEX;
  f.style.pointerEvents = 'none';
  host.appendChild(f);
  return f;
}

export function removeFrame(host: Element): void {
  frameOf(host)?.remove();
}

/** The host's colours: the type colour (badge, hover tint) and the tick
 *  tone that reads on white. */
export function setOutlineColor(host: HTMLElement, color: string, type?: string): void {
  host.style.setProperty('--crev-color', color);
  host.style.setProperty('--crev-tick', tickColor(color));
  const f = frameOf(host);
  if (f) {
    if (type) f.dataset.crevType = type;
    else delete f.dataset.crevType;
  }
}

export function clearOutlineColor(host: HTMLElement): void {
  host.style.removeProperty('--crev-color');
  host.style.removeProperty('--crev-tick');
}

export interface OutlineLook {
  level: NestingLevel;
  backdrop: Backdrop;
  /** The backdrop is final (the type is known): keep it on the frame. */
  keep: boolean;
}

const MAX_WALK = 12;

function sample(el: Element, cache: Map<Element, BackgroundSample>): BackgroundSample {
  let s = cache.get(el);
  if (!s) {
    const cs = getComputedStyle(el);
    s = { color: cs.backgroundColor, image: cs.backgroundImage };
    cache.set(el, s);
  }
  return s;
}

/** A picture, canvas or chart drawing that covers most of the host. */
function holdsMedia(host: Element): boolean {
  const media = host.querySelector('img, canvas, video, svg.highcharts-root, .highcharts-container');
  if (!media) return false;
  const m = media.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return h.width > 0 && h.height > 0 && m.width * m.height >= 0.5 * h.width * h.height;
}

/** Reads only (styles, a rect or two): what the outline of `label`'s host
 *  looks like. `cache` is shared by one layout pass. */
export function readOutlineLook(label: HTMLElement, host: HTMLElement, cache: Map<Element, BackgroundSample>): OutlineLook | null {
  const frame = frameOf(host);
  if (!frame) return null;
  const type = frame.dataset.crevType;
  const level = nestingLevel({
    type,
    hasMarkedChild: !!host.querySelector('.crev-outline'),
    height: host.offsetHeight,
    inline: host.tagName === 'A' || label.classList.contains('crev-edit-field-label')
      || label.classList.contains('crev-label--edge') || label.classList.contains('crev-label--edge-inside'),
  });
  const kept = frame.dataset.crevBg as Backdrop | undefined;
  if (kept) return { level, backdrop: kept, keep: true };
  const samples: BackgroundSample[] = [];
  for (let a: Element | null = host, i = 0; a && i < MAX_WALK; a = a.parentElement, i++) {
    const s = sample(a, cache);
    samples.push(s);
    // Stop at the first ancestor that paints: it decides.
    if (samplePaints(s)) break;
  }
  const backdrop = classifyBackdrop(samples, isChartType(type) || holdsMedia(host));
  return { level, backdrop, keep: !!type };
}

const LEVEL_CLASS: Record<NestingLevel, string> = { container: 'crev-frame--container', widget: 'crev-frame--widget', part: 'crev-frame--part' };

function toggle(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Writes only: the classes for `look`, changed ones only. */
export function writeOutlineLook(label: HTMLElement, look: OutlineLook | null): void {
  const host = label.parentElement;
  const frame = host ? frameOf(host) : null;
  if (!frame || !look) return;
  for (const [lvl, cls] of Object.entries(LEVEL_CLASS)) toggle(frame, cls, lvl === look.level);
  for (const el of [frame, label]) {
    toggle(el, 'crev-on-dark', look.backdrop === 'dark');
    toggle(el, 'crev-on-image', look.backdrop === 'image');
  }
  if (look.keep && frame.dataset.crevBg !== look.backdrop) frame.dataset.crevBg = look.backdrop;
}
