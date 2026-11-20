/**
 * Point and tell: the dock's mark, alive. One small state machine drives it: a reaction has a priority, a
 * stronger one replaces a weaker one (an equal one replaces too), never two play at once, and each ends back at
 * rest. At rest the eyes follow the pointer wherever it is on the page: a pointer move schedules one frame, the
 * frame sets one transform, and a short CSS ease carries the eyes there. Nothing runs while the pointer is still:
 * no frame loop, no looping animation (dozing is a still pose with a small z). A reaction is a handful of
 * Web Animations on transform and opacity that exist only while it plays; the eyes go back to the pointer after it.
 *
 *   event                         reaction   priority
 *   a stroke ends                 blink      1
 *   the page is ready             look       2
 *   waiting on the server         reading    3   (held until the wait is over)
 *   ink was not understood        curious    3
 *   a comment is saved            pleased    4
 *   Copy for AI                   nod        4
 *   a mark is read as crossed out wince      5
 *   Clear is confirmed            dizzy      6
 *   the next input after a doze   wake       7
 *   no input for DOZE_MS          doze       (a pose, not a reaction)
 *
 * The markup is `richMarkSvg()` and the look is styles/mark-moods.css; under prefers-reduced-motion the
 * reactions show still poses and nothing moves.
 */
import { EASE, animate, reducedMotion } from './motion';
import { pt } from './state';

export type Reaction = 'blink' | 'look' | 'curious' | 'pleased' | 'nod' | 'wince' | 'dizzy';
type Name = Reaction | 'reading' | 'wake' | 'listen';

const PRIORITY: Record<Name, number> = { blink: 1, look: 2, reading: 3, listen: 3, curious: 3, pleased: 4, nod: 4, wince: 5, dizzy: 6, wake: 7 };
/** Quiet for this long and the mark dozes. */
export const DOZE_MS = 25_000;
/** A wait shorter than this shows no reading (a flicker is worse than none); once shown it stays at least READ_MIN_MS. */
const READ_AFTER_MS = 200;
const READ_MIN_MS = 700;
const TAU = Math.PI * 2;
/** The eyes move this much (px of the 28 unit mark) per unit of a pupil offset. */
const GAIN = 1.3;
/**
 * How far the eyes travel toward the pointer, in units of the 28 unit mark (the dock shows it 40 px wide, so 1.43 px a
 * unit). The opening of the face is a ring of inner radius 6.5 around (15, 14); the pupils are 2 units wide at
 * x = 13 and 18. Sideways 2.5 puts the left pupil on the ring's inner edge; up and down 3 keeps both inside it.
 */
const REACH_X = 2.5;
const REACH_Y = 3;
/** The pointer this far from the face (px) or further: the eyes are all the way there. Nearer, they go part of the way. */
const FULL_AT = 90;
/** The pointer rested this long (ms): the eyes settle with one small movement. */
const REST_MS = 220;

interface Parts { host: HTMLElement; body: Element; face: HTMLElement; look: HTMLElement | null; eyes: HTMLElement[]; opens: Element[]; dizzies: Element[] }

let parts: Parts | null = null;
let current: Name | null = null;
let dozing = false;
let holds = 0;
let readSince = 0;
let anims: Animation[] = [];
let timers: number[] = [];
let lastInput = 0;
let dozeTimer = 0;
let idleTimer = 0;
let readTimer = 0;
/** Whether something keeps the mark awake besides the pen (the microphone). */
let busy: () => boolean = () => false;
/** Where the microphone's field is (window coordinates), while it listens. */
let listenAt: { cx: number; cy: number } | null = null;
/** The small listener is out beside the field: the dock's mark only looks that way and stays calm. */
let listenCalm = false;

function bind(): Parts | null {
  const host = pt.dock?.querySelector<HTMLElement>('[data-role="mascot"]');
  const body = host?.querySelector('.mk-body'), face = host?.querySelector<HTMLElement>('.mk-face');
  if (!host || !body || !face) return null;
  if (parts?.host !== host) {
    cancelAll();
    parts = {
      host, body, face, look: host.querySelector<HTMLElement>('.mark-look'),
      eyes: [...host.querySelectorAll<HTMLElement>('.mk-eye')], opens: [...host.querySelectorAll('.mk-open')], dizzies: [...host.querySelectorAll('.mk-dizzy')],
    };
    current = null; dozing = false;
    // The dock was drawn again (the page finished loading) while a wait goes on: the reading goes on.
    if (holds > 0) later(0, () => start('reading'));
  }
  return parts;
}

function cancelAll(): void {
  anims.forEach(a => a.cancel());
  anims = [];
  timers.forEach(t => clearTimeout(t));
  timers = [];
}

const later = (ms: number, fn: () => void): void => { timers.push(window.setTimeout(fn, ms)); };
const run = (el: Element | null | undefined, kf: Keyframe[], o: KeyframeAnimationOptions): Animation | null => {
  const a = animate(el, kf, o);
  if (a) { a.finished?.catch(() => {}); anims.push(a); }
  return a;
};
const t = (x: number, y: number): string => `translate(${x}px,${y}px)`;

const shape = (p: Parts, s: 'op' | 'sh' | 'hp' | 'sq' | 'dz'): void => { for (const e of p.eyes) e.dataset.s = s; };
const brows = (p: Parts, b: 'up' | 'wince' | 'ask' | null): void => { if (b) p.host.dataset.b = b; else delete p.host.dataset.b; };
const pupil = (p: Parts, x: number, y: number): void => { p.face.style.transform = t(+(x * GAIN).toFixed(2), +(y * GAIN).toFixed(2)); };

/** Everything back to the open, still face. */
function reset(p: Parts): void {
  cancelAll();
  shape(p, 'op');
  brows(p, null);
  p.face.style.removeProperty('transform');
  p.body.removeAttribute('data-pose');
  current = null;
  dozing = false;
  requestFollow();
}

/** Play out `ms`, then rest (and go back to reading when the wait is still on). */
function end(p: Parts, ms: number): void {
  later(ms, () => { reset(p); if (holds > 0) start('reading'); });
}

const scale = (x: number, y = x): string => `scale(${x},${y})`;

function start(name: Name): void {
  const p = bind();
  if (!p) return;
  if (!dozing && current && PRIORITY[current] > PRIORITY[name]) return;
  reset(p);
  current = name;
  requestFollow();
  switch (name) {
    case 'look': {
      const n = 12;
      const kf = Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * TAU - Math.PI / 2; return { transform: t(+(Math.cos(a) * 1.05 * GAIN).toFixed(2), +(Math.sin(a) * 1.25 * GAIN).toFixed(2)) }; });
      run(p.face, kf, { duration: 1000, easing: 'linear' });
      end(p, 1050);
      break;
    }
    case 'wince': {
      pupil(p, 0, 0); shape(p, 'sq'); brows(p, 'wince');
      const xs = [0, -0.8, 0.8, -0.6, 0.5, -0.2, 0];
      run(p.body, xs.map((x, i) => ({ transform: `translateX(${x}px) ${i === 0 || i === 6 ? scale(1) : scale(0.96, 1.03)}` })), { duration: 340, easing: 'linear' });
      end(p, 560);
      break;
    }
    case 'curious': {
      pupil(p, 0.5, -0.6); brows(p, 'ask');
      for (const o of p.opens) run(o, [{ transform: scale(1) }, { transform: scale(1.16), offset: 0.25 }, { transform: scale(1.16), offset: 0.8 }, { transform: scale(1) }], { duration: 1000, easing: EASE.out });
      run(p.body, [{ transform: 'rotate(0)' }, { transform: 'rotate(-13deg)', offset: 0.22, easing: EASE.pop }, { transform: 'rotate(-12deg)', offset: 0.8 }, { transform: 'rotate(0)' }], { duration: 1000 });
      end(p, 1000);
      break;
    }
    case 'pleased': {
      shape(p, 'hp');
      run(p.body, [{ transform: 'none' }, { transform: `translateY(1px) ${scale(1.05, 0.93)}`, offset: 0.18 }, { transform: `translateY(-3.2px) ${scale(0.97, 1.06)}`, offset: 0.45 }, { transform: `translateY(0) ${scale(1.03, 0.97)}`, offset: 0.7 }, { transform: 'none' }], { duration: 480, easing: EASE.out });
      end(p, 800);
      break;
    }
    case 'listen': {
      // Its own pose: eyes wide, brows up, leaning toward the field; held until the listening ends.
      const dx = listenAt ? listenAt.cx - (p.host.getBoundingClientRect().left + 14) : 0, dy = listenAt ? listenAt.cy - (p.host.getBoundingClientRect().top + 14) : 0;
      const d = Math.hypot(dx, dy) || 1;
      if (listenCalm) {
        // The small listener does the listening: this mark only turns its eyes to the field, a little wider, still.
        pupil(p, (dx / d) * 1, (dy / d) * 0.7);
        for (const o of p.opens) run(o, [{ transform: scale(1) }, { transform: scale(1.08) }], { duration: 260, easing: EASE.out, fill: 'forwards' });
        break;
      }
      brows(p, 'up'); pupil(p, (dx / d) * 1.2, (dy / d) * 0.8);
      for (const o of p.opens) run(o, [{ transform: scale(1) }, { transform: scale(1.3) }], { duration: 180, easing: EASE.pop, fill: 'forwards' });
      run(p.body, [{ transform: 'none' }, { transform: 'rotate(-7deg) translateY(-.6px)' }], { duration: 220, easing: EASE.out, fill: 'forwards' });
      break;
    }
    case 'reading': {
      readSince = performance.now();
      // Four quick looks, left and right, again and again while the wait lasts.
      const y = +(0.5 * GAIN).toFixed(2), l = t(-1 * GAIN, y), r = t(GAIN, y);
      run(p.face, [{ transform: l, offset: 0, easing: 'steps(1, jump-end)' }, { transform: r, offset: 0.25, easing: 'steps(1, jump-end)' }, { transform: l, offset: 0.5, easing: 'steps(1, jump-end)' }, { transform: r, offset: 0.75, easing: 'steps(1, jump-end)' }, { transform: l, offset: 1 }], { duration: 920, iterations: Infinity });
      break;
    }
    case 'dizzy': {
      shape(p, 'dz');
      for (const d of p.dizzies) run(d, [{ transform: 'rotate(0)' }, { transform: 'rotate(-720deg)' }], { duration: 1300, easing: EASE.spin });
      run(p.body, [0, 7, -6, 4, -2.5, 1, 0].map(r => ({ transform: `rotate(${r}deg)` })), { duration: 1300, easing: EASE.out });
      end(p, 1350);
      break;
    }
    case 'nod': {
      pupil(p, 0, 1);
      const dip = (y: number, sy: number): Keyframe => ({ transform: `translateY(${y}px) rotate(${y > 2 ? 4 : 2}deg) ${scale(1 + (1 - sy) / 2, sy)}` });
      run(p.body, [{ transform: 'none' }, dip(4, 0.92), { transform: 'translateY(-.6px)', offset: 0.45 }, dip(2.6, 0.95), { transform: 'none' }], { duration: 640, easing: EASE.inOut });
      run(p.face, [{ transform: t(0, 0) }, { transform: t(0, 2.4), offset: 0.25 }, { transform: t(0, -0.4), offset: 0.45 }, { transform: t(0, 1.6), offset: 0.72 }, { transform: t(0, 0) }], { duration: 640, easing: EASE.inOut, composite: 'add' });
      end(p, 680);
      break;
    }
    case 'wake': {
      brows(p, 'up'); pupil(p, 0, -0.3);
      for (const o of p.opens) run(o, [{ transform: scale(0.4, 0.2) }, { transform: scale(1.28), offset: 0.25 }, { transform: scale(1.2), offset: 0.7 }, { transform: scale(1) }], { duration: 520, easing: EASE.out });
      run(p.body, [{ transform: 'translateY(.5px) rotate(5deg)' }, { transform: `translateY(-3px) ${scale(1.05, 0.97)}`, offset: 0.22, easing: 'ease-in' }, { transform: `translateY(0) ${scale(0.98, 1.02)}`, offset: 0.5 }, { transform: 'none' }], { duration: 480 });
      end(p, 560);
      break;
    }
    case 'blink': break;
  }
}

/** React to something that happened. */
export function react(name: Reaction): void {
  const p = bind();
  if (!p) return;
  if (name === 'blink') {
    if (current || dozing) return;
    for (const o of p.opens) run(o, [{ transform: scale(1) }, { transform: scale(1, 0.08), offset: 0.45 }, { transform: scale(1) }], { duration: 150, easing: EASE.inOut });
    return;
  }
  start(name);
}

/** The microphone is on (or off): the mark listens, a pose of its own, toward the comment field (`calm`: the small listener listens, this mark only looks). */
export function listenPose(on: boolean, cx = 0, cy = 0, calm = false): void {
  const p = bind();
  if (!p) return;
  if (on) { listenAt = { cx, cy }; listenCalm = calm; noteInput(); start('listen'); return; }
  listenAt = null; listenCalm = false;
  if (current === 'listen') { reset(p); if (holds > 0) start('reading'); }
}

// ── Waiting on the server ───────────────────────────────────────────────────────────────────────

/** The mark reads while something waits on the server. Call the result when the wait is over; several waits overlap. */
export function holdReading(): () => void {
  holds++;
  if (holds === 1) readTimer = window.setTimeout(() => { readTimer = 0; if (holds > 0 && !current) start('reading'); }, READ_AFTER_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds > 0) return;
    if (readTimer) { clearTimeout(readTimer); readTimer = 0; }
    const p = parts;
    if (p && current === 'reading') {
      const rest = Math.max(0, READ_MIN_MS - (performance.now() - readSince));
      later(rest, () => { if (current === 'reading') reset(p); });
    }
  };
}

// ── Dozing ──────────────────────────────────────────────────────────────────────────────────────

function doze(p: Parts): void {
  reset(p);
  dozing = true;
  requestFollow();
  pupil(p, 0, 0.7);
  if (reducedMotion()) shape(p, 'sh');
  else {
    for (const o of p.opens) run(o, [{ transform: scale(1) }, { transform: scale(1, 0.55), offset: 0.3 }, { transform: scale(1, 0.7), offset: 0.5 }, { transform: scale(1, 0.2) }], { duration: 700, easing: 'ease-in', fill: 'forwards' });
    later(700, () => { if (dozing) { shape(p, 'sh'); anims.forEach(a => a.cancel()); anims = []; } });
  }
  p.body.setAttribute('data-pose', 'doze');
}

function armDoze(ms = DOZE_MS): void {
  if (dozeTimer) clearTimeout(dozeTimer);
  dozeTimer = window.setTimeout(() => {
    dozeTimer = 0;
    if (!pt.active) return;
    const idle = performance.now() - lastInput;
    if (idle < DOZE_MS) { armDoze(DOZE_MS - idle); return; }
    const p = bind();
    // Not while something is going on: a reaction, a wait, the pen on the page, the microphone.
    if (!p || current || dozing || holds > 0 || pt.ink?.drawing || busy()) { if (p && !dozing) armDoze(5000); return; }
    doze(p);
  }, ms);
}

/** The user did something (moved the pen, pressed a button, typed): the countdown starts again, and a dozing mark wakes. */
export function noteInput(): void {
  lastInput = performance.now();
  if (dozing) { start('wake'); armDoze(); }
}

// ── The eyes ────────────────────────────────────────────────────────────────────────────────────

let lookTo: { cx: number; cy: number } | null = null;
let lookRaf = 0;
let restTimer = 0;
/** What the eyes are showing now (mark units): the settle goes back to it. */
let shown = { x: 0, y: 0 };

/** Where the eyes want to be: toward the pointer when the mark is at rest, the middle during a reaction, a doze or when motion is off. */
function wanted(p: Parts): { x: number; y: number } {
  if (current || dozing || !lookTo || reducedMotion()) return { x: 0, y: 0 };
  const r = p.host.getBoundingClientRect();
  const dx = lookTo.cx - (r.left + r.width / 2), dy = lookTo.cy - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy) || 1;
  // Quick to rise: a pointer a short way off already turns the eyes most of the way.
  const k = 1 - (1 - Math.min(1, d / FULL_AT)) ** 2;
  return { x: +((dx / d) * k * REACH_X).toFixed(2), y: +((dy / d) * k * REACH_Y).toFixed(2) };
}

/** One frame: put the eyes where they want to be. The ease is the stylesheet's (a short transition on the eyes' group). */
function follow(): void {
  lookRaf = 0;
  const p = bind();
  if (!p?.look) return;
  const w = wanted(p);
  if (w.x === shown.x && w.y === shown.y) return;
  shown = w;
  p.look.style.transform = `translate(${w.x}px,${w.y}px)`;
  armRest();
}

function requestFollow(): void {
  if (!lookRaf) lookRaf = requestAnimationFrame(follow);
}

/** The pointer stopped: after a moment the eyes settle with one small movement past the spot and back. Nothing else runs. */
function armRest(): void {
  if (restTimer) clearTimeout(restTimer);
  restTimer = window.setTimeout(() => {
    restTimer = 0;
    const p = parts;
    if (!p || current || dozing || reducedMotion() || (!shown.x && !shown.y)) return;
    const d = Math.hypot(shown.x, shown.y) || 1;
    const over = 0.4;
    run(p.face, [{ transform: t(0, 0) }, { transform: t(+(shown.x / d * over).toFixed(2), +(shown.y / d * over).toFixed(2)), offset: 0.4 }, { transform: t(0, 0) }], { duration: 360, easing: EASE.out, composite: 'add' });
  }, REST_MS);
}

/** The eyes look toward a window point (the pointer), or rest. */
export function look(cx: number | null, cy = 0): void {
  lookTo = cx === null ? null : { cx, cy };
  if (cx !== null) noteInput();
  requestFollow();
}

let onMove: ((e: PointerEvent) => void) | null = null;

// ── Life cycle ──────────────────────────────────────────────────────────────────────────────────

function armBlink(): void {
  idleTimer = window.setTimeout(() => {
    idleTimer = 0;
    if (!pt.active) return;
    if (!document.hidden) react('blink');
    armBlink();
  }, 2800 + Math.random() * 3400);
}

/** The mode is on and the dock is there: the countdown to dozing and the now-and-then blink begin. */
export function startMascot(isBusy: () => boolean): void {
  busy = isBusy;
  // The eyes follow the pointer anywhere on the page, not only over the drawing surface.
  if (!onMove) { onMove = (e) => look(e.clientX, e.clientY); window.addEventListener('pointermove', onMove, { capture: true, passive: true }); }
  lastInput = performance.now();
  if (!dozeTimer) armDoze();
  if (!idleTimer) armBlink();
}

/** Leaving: nothing may fire after the layer is gone. */
export function stopMascot(): void {
  cancelAll();
  for (const id of [dozeTimer, idleTimer, readTimer, restTimer]) if (id) clearTimeout(id);
  dozeTimer = idleTimer = readTimer = restTimer = 0;
  if (lookRaf) cancelAnimationFrame(lookRaf);
  if (onMove) { window.removeEventListener('pointermove', onMove, true); onMove = null; }
  lookRaf = 0; lookTo = null; shown = { x: 0, y: 0 };
  parts = null; current = null; dozing = false; holds = 0;
}
