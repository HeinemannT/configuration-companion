/**
 * Point and tell: the response tag. When a mark has been read, a small tag in the badge's style says what it was
 * understood as, in one or two words ("Move", "Table", "2 objects"), just outside the corner of what the mark is
 * about. It stays about a second, then flies into the mark's number badge, which pulses once. Nothing else on the
 * page moves and the ink is untouched. Tags are made when needed and are gone from the page when done: none exists
 * at rest. Only transform and opacity animate. Under reduced motion a tag appears and fades in place.
 *
 * Several marks in quick succession: a new tag sends the ones still waiting on their way at once, is placed clear
 * of the other tags, the badges, the comment field and the dock, and a tag whose object moved or left the tab
 * (or a tab that was hidden) is taken away cleanly.
 */
import { findNode } from '../lib/layout/model';
import { tagSpec, type TagIcon } from '../lib/point-tell/tag-words';
import { markBox } from './ink-marks';
import { markByNumber } from './marks';
import { EASE, MS, animate, fade, reducedMotion } from './motion';
import { badgeCenter, pulseBadge } from './pins';
import { pt } from './state';
import { Z, placed } from './view';

const ICONS: Record<TagIcon, string> = {
  move: '<path d="M5 12h13M13 7l5 5-5 5"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  change: '<path d="M4 20h4l11-11-4-4L4 16z"/>',
  crossed: '<path d="M6 6l12 12M18 6L6 18"/>',
  objects: '<circle cx="12" cy="12" r="7"/>',
  note: '<path d="M4 15c3-6 6-6 8-2s5 4 8-2"/>',
};

const H = 20;
const GAP = 4;

interface Box { l: number; t: number; w: number; h: number }
interface Live { n: number; el: HTMLElement; word: string; box: Box; anchor: string; phase: 'in' | 'hold' | 'fly' | 'out'; hold: number; anims: Animation[] }

const live = new Map<number, Live>();
/** What each mark was last told as: a stroke that follows and keeps the same reading (the second stroke of an X) is not announced again. */
const told = new Map<number, string>();
const pending = new Map<number, number>();

const hit = (a: Box, b: Box): boolean => a.l < b.l + b.w && b.l < a.l + a.w && a.t < b.t + b.h && b.t < a.t + a.h;
const inflate = (b: Box, by: number): Box => ({ l: b.l - by, t: b.t - by, w: b.w + 2 * by, h: b.h + 2 * by });
const pageBox = (r: DOMRect): Box => ({ l: r.left + window.scrollX, t: r.top + window.scrollY, w: r.width, h: r.height });

function targetRect(id: string): Box | null {
  const s = pt.scene;
  const r = s?.targets.find(t => t.id === id)?.rect ?? s?.pills.find(t => t.id === id)?.rect;
  return r ? { l: r.left, t: r.top, w: r.width, h: r.height } : null;
}

/** What the tag sits at the corner of: the mark's ink and, unless it is an add, its first object. */
function anchorBox(n: number): Box | null {
  const m = markByNumber(n);
  if (!m) return null;
  const ink = markBox(m);
  const parts: Box[] = [];
  if (ink) parts.push({ l: ink.left, t: ink.top, w: ink.width, h: ink.height });
  if (m.meaning?.kind !== 'add' && m.targets[0]) { const r = targetRect(m.targets[0]); if (r) parts.push(r); }
  if (!parts.length) return null;
  const l = Math.min(...parts.map(p => p.l)), t = Math.min(...parts.map(p => p.t));
  return { l, t, w: Math.max(...parts.map(p => p.l + p.w)) - l, h: Math.max(...parts.map(p => p.t + p.h)) - t };
}

/** Everything a tag must stay clear of, in page coordinates. */
function obstacles(): Box[] {
  const out: Box[] = [];
  for (const el of [pt.fieldEl, pt.dock, pt.panelEl]) if (el?.isConnected) out.push(inflate(pageBox(el.getBoundingClientRect()), GAP));
  pt.pinLayer?.querySelectorAll('.pt-drop').forEach(d => out.push(pageBox(d.getBoundingClientRect())));
  for (const l of live.values()) out.push(inflate(l.box, GAP));
  return out;
}

function place(a: Box, w: number): Box {
  const vx0 = window.scrollX + 6, vx1 = window.scrollX + document.documentElement.clientWidth - 6;
  const x = (v: number): number => Math.round(Math.max(vx0, Math.min(vx1 - w, v)));
  const y = (v: number): number => Math.round(Math.max(window.scrollY + 6, v));
  const right = a.l + a.w, bottom = a.t + a.h;
  const cands: Array<[number, number]> = [
    [right - w, a.t - H - 4], [a.l, a.t - H - 4], [right + 8, a.t], [right - w, bottom + 6], [right - w - 8, a.t + 8],
  ];
  const wall = obstacles();
  const free = (b: Box): boolean => !wall.some(o => hit(b, o));
  for (const [cx, cy] of cands) { const b = { l: x(cx), t: y(cy), w, h: H }; if (free(b)) return b; }
  // Everything is taken: climb above the first place until it is clear.
  let b = { l: x(cands[0][0]), t: y(cands[0][1]), w, h: H };
  for (let i = 0; i < 6 && !free(b); i++) b = { ...b, t: y(b.t - H - GAP) };
  return b;
}

function build(word: string, icon: TagIcon): HTMLElement {
  const el = placed(document.createElement('div'), 'absolute', Z.tag);
  el.className = 'pt-resp';
  el.style.pointerEvents = 'none';
  el.style.left = '0'; el.style.top = '0';
  el.style.visibility = 'hidden';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon]}</svg>`;
  const text = document.createElement('span');
  text.textContent = word;
  el.appendChild(text);
  return el;
}

function remove(l: Live): void {
  clearTimeout(l.hold);
  l.anims.forEach(a => a.cancel());
  l.el.remove();
  if (live.get(l.n) === l) live.delete(l.n);
}

/** Take a tag away without a jump: it fades where it is. */
function dismiss(l: Live): void {
  if (l.phase === 'out') return;
  l.phase = 'out';
  clearTimeout(l.hold);
  const was = l.anims.slice();
  const a = fade(l.el, +getComputedStyle(l.el).opacity || 1, 0, 120);
  was.forEach(x => x.cancel());
  l.anims = [];
  if (a) { l.anims.push(a); a.onfinish = () => remove(l); } else remove(l);
}

function fly(l: Live): void {
  if (l.phase === 'fly' || l.phase === 'out') return;
  clearTimeout(l.hold);
  l.anims.forEach(a => a.cancel());
  l.anims = [];
  const dest = badgeCenter(l.n);
  if (!dest || reducedMotion()) {
    // No badge to fly to on this tab, or no motion wanted: fade where it stands.
    l.phase = 'out';
    const a = fade(l.el, 1, 0, MS.tagFade);
    if (a) { l.anims.push(a); a.onfinish = () => remove(l); } else remove(l);
    return;
  }
  l.phase = 'fly';
  const bx = dest.x - (l.box.l + l.box.w / 2), by = dest.y - (l.box.t + l.box.h / 2);
  l.el.style.willChange = 'transform, opacity';
  const a = animate(l.el, [
    { opacity: 1, transform: 'none' },
    { opacity: 0.9, transform: `translate(${bx * 0.7}px,${by * 0.7}px) scale(.55)`, offset: 0.7 },
    { opacity: 0, transform: `translate(${bx}px,${by}px) scale(.3)` },
  ], { duration: MS.tagFly, easing: EASE.fly, fill: 'forwards' });
  if (!a) { remove(l); return; }
  l.anims.push(a);
  a.onfinish = () => { const n = l.n; remove(l); pulseBadge(n); };
}

/** Show the tag of mark `n` now (nothing for a mark that says nothing). Returns whether one is showing. */
export function showTag(n: number): boolean {
  const layer = pt.layer;
  const m = markByNumber(n);
  if (!layer || !pt.active || !m) return false;
  const spec = tagSpec(m, id => (pt.model ? findNode(pt.model, id)?.node.className : undefined));
  if (!spec) return false;
  const old = live.get(n);
  if (old?.word === spec.word && old.phase !== 'out') return true;
  if (!old && told.get(n) === spec.word) return false;
  if (old) remove(old);
  const a = anchorBox(n);
  if (!a) return false;
  // Out of the window: nobody would see it.
  if (a.t + a.h < window.scrollY || a.t > window.scrollY + window.innerHeight || a.l + a.w < window.scrollX || a.l > window.scrollX + window.innerWidth) return false;
  // Tags still waiting go on their way: they never pile up.
  for (const o of live.values()) if (o.phase === 'in' || o.phase === 'hold') fly(o);

  const el = build(spec.word, spec.icon);
  layer.appendChild(el);
  const box = place(a, Math.ceil(el.getBoundingClientRect().width));
  el.style.left = `${box.l}px`; el.style.top = `${box.t}px`;
  el.style.visibility = '';
  told.set(n, spec.word);
  const l: Live = { n, el, word: spec.word, box, anchor: sig(a), phase: 'in', hold: 0, anims: [] };
  live.set(n, l);
  const hold = reducedMotion() ? MS.tagStill : MS.tagHold;
  if (reducedMotion()) {
    const f = fade(el, 0, 1, MS.tagIn);
    if (f) l.anims.push(f);
  } else {
    el.style.willChange = 'transform, opacity';
    const f = animate(el, [{ opacity: 0, transform: 'translateY(4px) scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: MS.tagIn, easing: EASE.out });
    if (f) { l.anims.push(f); f.onfinish = () => { el.style.willChange = ''; l.anims = l.anims.filter(x => x !== f); }; }
  }
  l.phase = 'hold';
  l.hold = window.setTimeout(() => fly(l), hold);
  return true;
}

const sig = (b: Box): string => `${Math.round(b.l)},${Math.round(b.t)},${Math.round(b.w)},${Math.round(b.h)}`;

/** Show the tag of mark `n` after `ms` (a stroke that follows, joining the mark, starts the wait again). */
export function scheduleTag(n: number, ms: number, then?: () => void): void {
  const prev = pending.get(n);
  if (prev) clearTimeout(prev);
  const gen = pt.gen;
  pending.set(n, window.setTimeout(() => {
    pending.delete(n);
    if (!pt.active || pt.gen !== gen) return;
    showTag(n);
    then?.();
  }, ms));
}

/** The page was measured again or a mark changed: a tag whose object moved, or whose mark or object left the tab, goes. */
export function revalidateTags(): void {
  for (const l of [...live.values()]) {
    const a = anchorBox(l.n);
    if (!a || sig(a) !== l.anchor || !badgeCenter(l.n)) dismiss(l);
  }
}

/** Every tag and every wait for one is gone (leaving, Clear, the tab hidden). */
export function clearTags(): void {
  told.clear();
  pending.forEach(t => clearTimeout(t));
  pending.clear();
  for (const l of [...live.values()]) remove(l);
}
