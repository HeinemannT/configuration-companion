/**
 * Point and tell: the quiet cue of a still press while voice comments are on. A thin violet ring around the
 * press, shown only once the press has lasted HOLD_CUE_DELAY_MS (a click never sees it), that closes around the
 * point until HOLD_TO_TALK_MS. When voice starts it widens a little and fades, as the listener rises at the field;
 * when the press moves or goes up first it simply fades. Only opacity and transform move, with the shared curves;
 * under reduced motion nothing is shown (the listening look itself says that voice started).
 */
import { HOLD_CUE_DELAY_MS, HOLD_TO_TALK_MS } from '../lib/point-tell/press-hold';
import { EASE, MS, animate, reducedMotion } from './motion';
import { pt } from './state';
import { Z, placed } from './view';

const R = 13;
const C = 2 * Math.PI * R;
let cue: { el: HTMLElement; ring: SVGCircleElement } | null = null;

/** Show the cue at window point (cx, cy); it starts after the delay. */
export function armCue(cx: number, cy: number): void {
  dropCue();
  const layer = pt.layer;
  if (!layer || reducedMotion()) return;
  const size = 2 * (R + 3);
  const el = placed(document.createElement('div'), 'fixed', Z.label);
  el.className = 'pt-hold-cue';
  el.style.left = `${cx - size / 2}px`; el.style.top = `${cy - size / 2}px`;
  el.style.width = `${size}px`; el.style.height = `${size}px`;
  el.style.pointerEvents = 'none';
  el.style.opacity = '0';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${R}" fill="rgba(138,63,252,.07)" stroke="#8a3ffc" stroke-width="2" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  const ring = el.querySelector('circle')!;
  layer.appendChild(el);
  cue = { el, ring };
  const run = HOLD_TO_TALK_MS - HOLD_CUE_DELAY_MS;
  animate(el, [{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1)' }], { duration: MS.tagIn, delay: HOLD_CUE_DELAY_MS, easing: EASE.out, fill: 'forwards' });
  animate(ring, [{ strokeDashoffset: C }, { strokeDashoffset: 0 }], { duration: run, delay: HOLD_CUE_DELAY_MS, easing: 'linear', fill: 'forwards' });
}

/** Voice started: the ring widens and fades. */
export function flipCue(): void {
  const c = cue;
  cue = null;
  if (!c) return;
  const a = animate(c.el, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: MS.pop, easing: EASE.out, fill: 'forwards' });
  if (a) a.onfinish = () => c.el.remove(); else c.el.remove();
}

/** The press moved or went up before the time: the cue goes. */
export function dropCue(): void {
  const c = cue;
  cue = null;
  if (!c) return;
  const shown = Number(getComputedStyle(c.el).opacity) || 0;
  if (shown < 0.05) { c.el.remove(); return; }
  const a = animate(c.el, [{ opacity: shown }, { opacity: 0 }], { duration: 120, easing: EASE.out, fill: 'forwards' });
  if (a) a.onfinish = () => c.el.remove(); else c.el.remove();
}
