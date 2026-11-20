/**
 * Point and tell: the listener. While the microphone is held, a small copy of the product's mark rises from behind an
 * edge of the comment field, brows up and eyes on the words, and leaves when the listening is over. It is the same
 * drawing as the dock's mark (`richMarkSvg()`, styles/mark-moods.css), acted with the same kind of Web Animations
 * (mascot.ts), so there is one mascot; the dock's own mark stays calm meanwhile.
 *
 *   rises            a light spring from behind the field's edge (the field's box never changes: the listener is a
 *                    sibling that lies behind it and is clipped by it)
 *   listens          brows up, eyes wide, leaning toward the field, the eyes on the caret
 *   hears            hairline ripples leave its open side with the voice (level in, nothing when it is quiet)
 *   a phrase ends    a small nod; a loud word, a small start
 *   kept             a happy squint and a hop, then it sinks back
 *   Escape           a quick shake of the head, then it drops
 *   nothing heard    it looks puzzled for a moment, then leaves
 *
 * Only transforms and opacity move. The ripples are written once a frame by voice.ts while listening, and nothing
 * else runs. Under reduced motion it simply appears in a still pose and goes without moving.
 */
import { richMarkSvg } from '../lib/companion-mark';
import { listenerSpot, TUCK, type SpotRect } from '../lib/point-tell/listener-spot';
import { springEasing } from '../lib/point-tell/spring';
import { EASE, animate, reducedMotion } from './motion';
import { markStrokes } from './ink-marks';
import { pt } from './state';
import { Z, placed } from './view';

export type Leaving = 'kept' | 'discarded' | 'nothing' | 'short';

export interface Listener {
  /** One frame while listening: the voice level (0..1) and the time. */
  frame(level: number, now: number): void;
  /** The eyes rest on a window point (the caret), or in the middle. */
  gaze(at: { x: number; y: number } | null): void;
  /** A phrase ended. */
  nod(): void;
  /** A loud word. */
  startle(): void;
  /** The listening is over. */
  leave(how: Leaving): void;
  /** The middle of the listener in window coordinates (for the dock's mark to look at it). */
  center(): { x: number; y: number };
  /** Gone, at once. */
  remove(): void;
}

/** The listener's size and how far the ripples reach beyond it. */
const SIZE = 36;
const REACH = 46;
const REACH_X = 2.5, REACH_Y = 3, FULL_AT = 90;
const LEAN = -5;
/** The ripples: how many, the radius they start at and travel, how long they last (ms). */
const RIPPLES = 3, R0 = 21, TRAVEL = 15, LIFE = 580, SPAN = 0.74;

const scale = (x: number, y = x): string => `scale(${x},${y})`;
const t = (x: number, y: number): string => `translate(${x}px,${y}px)`;

/** Page coordinates of the sample points of the ink of every mark and the boxes of the number badges. */
function crowd(): { ink: Array<[number, number]>; avoid: SpotRect[] } {
  const ink: Array<[number, number]> = [];
  for (const m of pt.marks) {
    for (const s of markStrokes(m) ?? []) {
      let px = 1e9, py = 1e9;
      s.points.forEach((p, i) => { if (i === 0 || i === s.points.length - 1 || Math.hypot(p[0] - px, p[1] - py) >= 6) { ink.push([p[0], p[1]]); px = p[0]; py = p[1]; } });
    }
  }
  const avoid: SpotRect[] = [];
  pt.pinLayer?.querySelectorAll<HTMLElement>('.pt-badge').forEach(b => {
    const r = b.getBoundingClientRect();
    avoid.push({ left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height });
  });
  return { ink, avoid };
}

/** The listener for `card`, or null when no side of the field has room: it never covers ink or a badge. */
export function createListener(layer: HTMLElement, card: HTMLElement): Listener | null {
  const cardBox: SpotRect = { left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight };
  const { ink, avoid } = crowd();
  const spot = listenerSpot({
    card: cardBox, size: SIZE, reach: REACH,
    view: { left: window.scrollX + 4, top: window.scrollY + 4, right: window.scrollX + document.documentElement.clientWidth - 4, bottom: window.scrollY + window.innerHeight - 70 },
    ink, avoid,
  });
  if (!spot) return null;
  const top = spot.side === 'top';
  // Hidden: wholly behind the field. Shown: its box sits TUCK px behind the edge it comes out of.
  const hidden = (top ? 1 : -1) * (SIZE + 6);
  const still = reducedMotion();

  const host = placed(document.createElement('div'), 'absolute', String(Number(Z.field) - 1));
  host.className = 'pt-listener';
  host.setAttribute('aria-hidden', 'true');
  host.style.left = `${Math.round(spot.left)}px`;
  host.style.top = `${Math.round(top ? cardBox.top + TUCK - SIZE : cardBox.top + cardBox.height - TUCK)}px`;
  host.style.width = `${SIZE}px`; host.style.height = `${SIZE}px`;
  host.style.pointerEvents = 'none';
  if (!still) host.style.transform = `translateY(${hidden}px)`;

  const ns = 'http://www.w3.org/2000/svg';
  const rip = document.createElementNS(ns, 'svg');
  rip.setAttribute('class', 'pt-ripples');
  rip.setAttribute('width', '1'); rip.setAttribute('height', '1');
  rip.style.position = 'absolute'; rip.style.left = '50%'; rip.style.top = '50%'; rip.style.overflow = 'visible'; rip.style.pointerEvents = 'none';
  const arcs: SVGPathElement[] = [];
  for (let i = 0; i < RIPPLES; i++) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', `M${(Math.cos(SPAN)).toFixed(3)} ${(-Math.sin(SPAN)).toFixed(3)}A1 1 0 0 1 ${(Math.cos(SPAN)).toFixed(3)} ${Math.sin(SPAN).toFixed(3)}`);
    p.setAttribute('opacity', '0'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#8a3ffc'); p.setAttribute('stroke-width', '1'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('vector-effect', 'non-scaling-stroke');
    rip.appendChild(p); arcs.push(p);
  }
  const mark = document.createElement('div');
  mark.className = 'crev-mark pt-mascot pt-ls';
  mark.innerHTML = richMarkSvg();
  mark.style.width = `${SIZE}px`; mark.style.height = `${SIZE}px`; mark.style.display = 'block';
  host.append(rip, mark);
  layer.appendChild(host);

  const body = mark.querySelector<SVGElement>('.mk-body');
  const face = mark.querySelector<HTMLElement>('.mk-face');
  const look = mark.querySelector<HTMLElement>('.mark-look');
  const eyes = [...mark.querySelectorAll<HTMLElement>('.mk-eye')];
  const opens = [...mark.querySelectorAll<SVGElement>('.mk-open')];

  let anims: Animation[] = [];
  let timers: number[] = [];
  let leaving = false;
  let busy = 0;
  let gone = false;
  let lastSpawn = -1e9, prev = 0;
  const live: Array<{ t0: number; k: number }> = [];

  const run = (el: Element | null, kf: Keyframe[], o: KeyframeAnimationOptions): Animation | null => {
    const a = animate(el, kf, o);
    if (a) { a.finished.catch(() => {}); anims.push(a); }
    return a;
  };
  const later = (ms: number, fn: () => void): void => { timers.push(window.setTimeout(fn, ms)); };
  const shape = (s: 'op' | 'hp' | 'sq' | 'sh'): void => { for (const e of eyes) e.dataset.s = s; };
  const brows = (b: 'up' | 'ask' | null): void => { if (b) mark.dataset.b = b; else delete mark.dataset.b; };
  const sprung = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)') ? springEasing(0.05) : 'cubic-bezier(.2,1.05,.3,1.04)';

  // The pose it holds while listening: brows up, eyes a little wide, leaning toward the field.
  const lean = top ? LEAN : -LEAN;
  const listenPose = (): void => {
    brows('up');
    if (still) { if (body) body.style.transform = `rotate(${lean}deg)`; return; }
    for (const o of opens) run(o, [{ transform: scale(1) }, { transform: scale(1.16) }], { duration: 200, delay: 90, easing: EASE.out, fill: 'forwards' });
    run(body, [{ transform: 'none' }, { transform: `rotate(${lean}deg) translateY(-.4px)` }], { duration: 260, delay: 60, easing: EASE.out, fill: 'forwards' });
  };

  if (still) listenPose();
  else {
    run(host, [{ transform: `translateY(${hidden}px)` }, { transform: 'none' }], { duration: 400, easing: sprung, fill: 'forwards' });
    listenPose();
  }

  /** After `ms` it sinks back behind the field's edge and is removed. */
  const exit = (ms: number, easing = 'cubic-bezier(.5,0,.8,.4)'): void => {
    later(ms, () => {
      const out = animate(host, [{ transform: 'none' }, { transform: `translateY(${hidden}px)` }], { duration: 200, easing, fill: 'forwards' });
      if (out) { out.finished.then(() => l.remove(), () => l.remove()); } else l.remove();
    });
  };

  const l: Listener = {
    frame(level, now) {
      if (gone || leaving) return;
      // A ripple leaves when the voice comes up, and again now and then while it goes on.
      const rising = level > 0.18 && prev <= 0.18;
      if (live.length < RIPPLES && ((rising && now - lastSpawn > 120) || (level > 0.26 && now - lastSpawn > 220))) {
        live.push({ t0: now, k: Math.min(1, 0.6 + level * 0.5) });
        lastSpawn = now;
      }
      prev = level;
      for (let i = 0; i < RIPPLES; i++) {
        const r = live[i], p = arcs[i];
        if (!r) { if (p.getAttribute('opacity') !== '0') p.setAttribute('opacity', '0'); continue; }
        const u = (now - r.t0) / LIFE;
        if (u >= 1) { live.splice(i, 1); i--; p.setAttribute('opacity', '0'); continue; }
        const e = 1 - (1 - u) ** 3;
        p.setAttribute('transform', `rotate(${lean}) scale(${(R0 + TRAVEL * e).toFixed(2)})`);
        p.setAttribute('opacity', (0.7 * r.k * (1 - u) ** 1.7 * Math.min(1, u / 0.1)).toFixed(3));
      }
      // The listener swells a little with the voice.
      if (!still) mark.style.transform = `scale(${(1 + 0.03 * level).toFixed(3)})`;
    },
    gaze(at) {
      if (gone || !look) return;
      let x = 0, y = 0;
      if (at) {
        const r = mark.getBoundingClientRect();
        const dx = at.x - (r.left + r.width / 2), dy = at.y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const k = 1 - (1 - Math.min(1, d / FULL_AT)) ** 2;
        x = +((dx / d) * k * REACH_X).toFixed(2); y = +((dy / d) * k * REACH_Y).toFixed(2);
      }
      look.style.transform = t(x, y);
    },
    nod() {
      if (gone || leaving || busy > 0 || still) return;
      busy++;
      later(520, () => { busy--; });
      const dip = (y: number, sy: number): Keyframe => ({ transform: `translateY(${y}px) ${scale(1 + (1 - sy) / 2, sy)}` });
      run(body, [{ transform: 'none' }, dip(2.2, 0.95), { transform: 'translateY(-.3px)', offset: 0.5 }, dip(1.2, 0.97), { transform: 'none' }], { duration: 520, easing: EASE.inOut, composite: 'add' });
      run(face, [{ transform: t(0, 0) }, { transform: t(0, 1.6), offset: 0.28 }, { transform: t(0, -.3), offset: 0.5 }, { transform: t(0, 1), offset: 0.74 }, { transform: t(0, 0) }], { duration: 520, easing: EASE.inOut, composite: 'add' });
    },
    startle() {
      if (gone || leaving || still) return;
      for (const o of opens) run(o, [{ transform: scale(1) }, { transform: scale(1.22), offset: 0.2 }, { transform: scale(1.1), offset: 0.7 }, { transform: scale(1) }], { duration: 380, easing: EASE.out, composite: 'add' });
      run(body, [{ transform: 'none' }, { transform: `translateY(-1.1px) ${scale(1.04, 1.05)}`, offset: 0.2 }, { transform: 'none' }], { duration: 380, easing: EASE.out, composite: 'add' });
    },
    leave(how) {
      if (gone || leaving) return;
      leaving = true;
      for (const p of arcs) p.setAttribute('opacity', '0');
      mark.style.transform = '';
      if (how === 'short') { exit(0, 'cubic-bezier(.5,0,.9,.4)'); return; }
      if (how === 'kept') {
        shape('hp'); brows(null);
        run(body, [{ transform: `rotate(${lean}deg)` }, { transform: `translateY(1px) rotate(0deg) ${scale(1.04, 0.95)}`, offset: 0.2 }, { transform: `translateY(-2.4px) ${scale(0.98, 1.05)}`, offset: 0.5 }, { transform: `translateY(0) ${scale(1.02, 0.98)}`, offset: 0.76 }, { transform: 'none' }], { duration: 460, easing: EASE.out, fill: 'forwards' });
        exit(520);
        return;
      }
      if (how === 'discarded') {
        brows(null);
        for (const o of opens) run(o, [{ transform: scale(1.16) }, { transform: scale(1, 0.1), offset: 0.3 }, { transform: scale(1) }], { duration: 200, easing: EASE.inOut, fill: 'forwards' });
        run(body, [{ transform: `rotate(${lean}deg)` }, { transform: 'rotate(5deg)', offset: 0.22 }, { transform: 'rotate(-5deg)', offset: 0.5 }, { transform: 'rotate(2.5deg)', offset: 0.76 }, { transform: 'rotate(0)' }], { duration: 360, easing: EASE.inOut, fill: 'forwards' });
        exit(260, 'cubic-bezier(.5,0,.9,.35)');
        return;
      }
      // Nothing was recognised: puzzled for a moment (the dock's curious look), then it goes.
      brows('ask');
      if (look) look.style.transform = t(0.65, -0.8);
      for (const o of opens) run(o, [{ transform: scale(1.16) }, { transform: scale(1.22), offset: 0.3 }, { transform: scale(1.16) }], { duration: 900, easing: EASE.out, fill: 'forwards' });
      run(body, [{ transform: `rotate(${lean}deg)` }, { transform: 'rotate(-12deg)', offset: 0.22, easing: EASE.pop }, { transform: 'rotate(-11deg)', offset: 0.85 }, { transform: 'rotate(0)' }], { duration: 1000, fill: 'forwards' });
      exit(1000);
    },
    center() {
      const r = mark.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    remove() {
      if (gone) return;
      gone = true;
      anims.forEach(a => a.cancel());
      anims = [];
      timers.forEach(id => clearTimeout(id));
      timers = [];
      host.remove();
    },
  };
  l.gaze(null);
  return l;
}
