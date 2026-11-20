/**
 * Point and tell: the number badges. Each mark has one, shaped like a drop of ink whose tip points at the
 * mark: at the start of its stroke, or, for a note on an object, at the object's top right corner.
 * Hovering a badge shows the mark's words; a click opens its field. Badges of marks whose object is on
 * another tab are not drawn (the dock's list takes you there). A new badge grows from its tip.
 */
import { shownNumbers } from '../lib/point-tell/numbering';
import { freshMarks, groupView, isCorrection, isSent, viewWord, type GroupView } from '../lib/point-tell/sent-marks';
import { isNews } from '../lib/claude-link';
import { correctionLead } from '../lib/point-tell/brief';
import type { PtMark } from '../lib/point-tell/types';
import { linkView, markSeen, sent } from './sent';
import { syncSentButton } from './dock';
import { badgeStart, markBox } from './ink-marks';
import { EASE, MS, animate } from './motion';
import { pt } from './state';
import { Z, placed } from './view';

const R = 10.5;
const DIST = R * 1.62;
/** The badge's box: a 40 x 40 square centred on the circle. */
const BOX = 40;
const C = BOX / 2;

/** Numbers that already had a badge: only a new one animates. */
const known = new Set<number>();
export function resetBadges(): void { known.clear(); pulsed.clear(); }

/** When a badge last pulsed: the pins are drawn again whenever anything changes, and a pulse in progress carries on in the new element. */
const pulsed = new Map<number, number>();
const PULSE_KF: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.5)', offset: 0.4 }, { transform: 'scale(1)' }];

function playPulse(badge: Element | null, elapsed = 0): void {
  const svg = badge?.querySelector('svg');
  const a = animate(svg, PULSE_KF, { duration: MS.pulse, easing: EASE.out, delay: -elapsed });
  if (a) a.onfinish = () => a.cancel();
}

/** The badge of mark `n` pulses once (a tag has just landed in it). */
export function pulseBadge(n: number): void {
  pulsed.set(n, performance.now());
  playPulse(badgeEl(n));
}

export const badgeEl = (n: number): HTMLElement | null => pt.pinLayer?.querySelector<HTMLElement>(`.pt-badge[data-n="${n}"]`) ?? null;

/** The centre of a badge's circle in page coordinates, or null when the mark has no badge on this tab. */
export function badgeCenter(n: number): { x: number; y: number } | null {
  const b = badgeEl(n);
  if (!b) return null;
  return { x: parseFloat(b.style.left) + C, y: parseFloat(b.style.top) + C };
}

export function markRect(m: PtMark): { left: number; top: number; width: number; height: number } | null {
  const ink = markBox(m);
  if (ink) return ink;
  const targets = pt.scene?.targets ?? [];
  for (const id of m.targets) {
    const t = targets.find(x => x.id === id) ?? pt.scene?.pills.find(x => x.id === id);
    if (t) return t.rect;
  }
  return null;
}

/** The drop as SVG: a circle with a point toward `angle` (from the circle's centre to the tip). */
function dropPath(angle: number): string {
  const phi = Math.acos(R / DIST);
  const tip = [C + DIST * Math.cos(angle), C + DIST * Math.sin(angle)];
  const p1 = [C + R * Math.cos(angle + phi), C + R * Math.sin(angle + phi)];
  const p2 = [C + R * Math.cos(angle - phi), C + R * Math.sin(angle - phi)];
  const f = (v: number): string => v.toFixed(2);
  return `M${f(tip[0])} ${f(tip[1])}L${f(p1[0])} ${f(p1[1])}A${R} ${R} 0 1 1 ${f(p2[0])} ${f(p2[1])}Z`;
}

/** Where a mark's badge points: the tip's page position and the angle from the circle to it. */
function anchorOf(m: PtMark, perObject: Map<string, number>): { x: number; y: number; angle: number } | null {
  const start = badgeStart(m);
  if (start) {
    let angle = start.heading;
    // Never hang off the left or top of the page.
    if (start.x - DIST * Math.cos(angle) < 12 && Math.cos(angle) > 0) angle = Math.PI - angle;
    if (start.y - DIST * Math.sin(angle) < 12 && Math.sin(angle) > 0) angle = -angle;
    return { x: start.x, y: start.y, angle };
  }
  const rect = markRect(m);
  if (!rect) return null;
  const key = m.targets[0] ?? 'page';
  const k = perObject.get(key) ?? 0;
  perObject.set(key, k + 1);
  // An object that reaches the right edge of the page keeps its badge inside the page (no sideways scrolling).
  const right = window.scrollX + document.documentElement.clientWidth - (BOX - C + DIST * Math.SQRT1_2) - 2;
  return { x: Math.min(rect.left + rect.width, right) - k * 26, y: rect.top, angle: (3 * Math.PI) / 4 };
}

/** The small state on a sent mark's badge: where it sits (away from the tip) and what it shows. */
function pipSvg(v: GroupView, tipAngle: number, news: boolean): string {
  const status = v.status;
  // The user has to act (no chat, nobody on it, not listed): a quiet exclamation mark.
  const need = !!v.attention;
  if (status === 'unknown' && !need) return '';
  const near = (a: number, b: number): boolean => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.9;
  const a = near(tipAngle, -Math.PI / 4) ? (-3 * Math.PI) / 4 : -Math.PI / 4;
  const x = C + (R + 1.5) * Math.cos(a), y = C + (R + 1.5) * Math.sin(a);
  const f = (v: number): string => v.toFixed(2);
  const kind = need ? 'need' : status === 'taken' || status === 'working' || status === 'answered' ? 'busy' : status;
  const glyph = need ? `<text class="pt-pip-t" x="${f(x)}" y="${f(y + 2.6)}" text-anchor="middle">!</text>`
    : status === 'done' ? `<path class="pt-pip-g" d="M${f(x - 2.4)} ${f(y + 0.1)}l1.6 1.6 3.1-3.3"/>`
    : status === 'question' ? `<text class="pt-pip-t" x="${f(x)}" y="${f(y + 2.6)}" text-anchor="middle">?</text>`
      : status === 'cannot' ? `<text class="pt-pip-t" x="${f(x)}" y="${f(y + 2.6)}" text-anchor="middle">!</text>` : '';
  return `<g class="pt-pip pt-pip-${kind}${news ? ' pt-pip-news' : ''}"><circle cx="${f(x)}" cy="${f(y)}" r="5.6"/>${glyph}</g>`;
}

/** The words a sent mark's badge shows on hover: its state, its sketch, and Claude's sentence. */
function sentTip(v: GroupView, k: number): HTMLElement {
  const tip = document.createElement('span');
  tip.className = 'pt-tip-badge pt-tip-sent';
  const head = document.createElement('span');
  head.className = 'pt-tip-head';
  const state = document.createElement('b');
  state.textContent = viewWord(v);
  head.append(state, document.createTextNode(` · Sketch ${v.sketch}, mark ${k}`));
  tip.appendChild(head);
  if (v.reply && v.status !== 'answered') {
    const words = document.createElement('span');
    words.className = 'pt-tip-reply';
    words.textContent = v.reply;
    tip.appendChild(words);
  }
  return tip;
}

/** The view of every sent mark's sketch, by mark number. */
export function sentViews(): Map<number, GroupView> {
  const out = new Map<number, GroupView>();
  const link = linkView();
  for (const m of pt.marks) if (m.sent && isSent(m)) out.set(m.n, groupView(m.sent, sent.rows, link));
  return out;
}

export function renderPins(onOpen: (n: number) => void, onReply: (n: number) => void = onOpen): void {
  const layer = pt.layer;
  if (!layer) return;
  pt.pinLayer?.remove();
  pt.pinLayer = null;
  if (!pt.marks.length) return;
  const wrap = placed(document.createElement('div'), 'absolute', Z.pins);
  wrap.className = 'pt-pins';
  wrap.style.left = '0'; wrap.style.top = '0'; wrap.style.width = '0'; wrap.style.height = '0';
  wrap.style.pointerEvents = 'none';
  const perObject = new Map<string, number>();
  // New marks are numbered as the next sketch will number them; sent ones keep their number in their sketch.
  const numbers = shownNumbers(freshMarks(pt.marks));
  const views = sentViews();
  const r = pt.reply;
  const openSketch = !r ? null : 'n' in r ? pt.marks.find(x => x.n === r.n)?.sent?.sketch ?? null : r.sketch;
  for (const m of pt.marks) {
    // A page note has no place: its number sits in the list.
    if (!m.ink && !m.targets.length) continue;
    const at = anchorOf(m, perObject);
    if (!at) continue;
    const badge = placed(document.createElement('button'), 'absolute', Z.pins);
    badge.type = 'button';
    const view = views.get(m.n);
    const num = view && m.sent ? m.sent.k : numbers.get(m.n);
    // A reply that is open in its card is being read.
    const news = !!view?.row && isNews(view.row, sent.seen) && view.sketch !== openSketch;
    badge.className = 'pt-badge' + (known.has(m.n) ? '' : ' pt-pop') + (view ? ` pt-sent pt-st-${view.status}` : '');
    badge.dataset.n = String(m.n);
    if (view) badge.dataset.sketch = String(view.sketch);
    badge.style.left = `${at.x - C - DIST * Math.cos(at.angle)}px`;
    badge.style.top = `${at.y - C - DIST * Math.sin(at.angle)}px`;
    badge.style.width = `${BOX}px`; badge.style.height = `${BOX}px`;
    badge.style.pointerEvents = 'none';
    badge.style.transformOrigin = `${C + DIST * Math.cos(at.angle)}px ${C + DIST * Math.sin(at.angle)}px`;
    const words = m.text || m.reading || '';
    const fix = !view && isCorrection(m) && m.sent ? correctionLead(m.sent) : '';
    badge.setAttribute('aria-label', view && m.sent ? `Sketch ${view.sketch}, mark ${m.sent.k}: ${viewWord(view)}` : `${num !== undefined ? `Mark ${num}` : 'Page'}${fix ? `, ${fix.toLowerCase()}` : ''}${words ? `: ${words}` : ''}`);
    badge.innerHTML = `<svg viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}" aria-hidden="true"><path class="pt-drop" d="${dropPath(at.angle)}"/><text x="${C}" y="${C + 4}" text-anchor="middle">${num ?? ''}</text>${view ? pipSvg(view, at.angle, news) : ''}</svg>`;
    const hit = badge.querySelector('.pt-drop') as SVGElement;
    hit.style.pointerEvents = 'all';
    if (view && m.sent) {
      const tip = sentTip(view, m.sent.k);
      tip.style.position = 'absolute';
      tip.style.left = `${BOX - 4}px`;
      tip.style.top = `${C - 10}px`;
      tip.style.pointerEvents = 'none';
      badge.appendChild(tip);
    } else if (words || fix) {
      const tip = document.createElement('span');
      tip.className = 'pt-tip-badge';
      tip.textContent = fix ? `${fix}${words ? `: ${words}` : ''}` : words;
      tip.style.position = 'absolute';
      tip.style.left = `${BOX - 4}px`;
      tip.style.top = `${C - 10}px`;
      tip.style.pointerEvents = 'none';
      badge.appendChild(tip);
    }
    // The words show while the pointer is on the drop (the button itself is click-through).
    // A sent mark's sketch-mates light up with it; looking at a reply counts as reading it.
    const kin = (on: boolean): void => { if (view) wrap.querySelectorAll(`.pt-badge[data-sketch="${view.sketch}"]`).forEach(b => b.classList.toggle('pt-kin', on)); };
    hit.addEventListener('pointerenter', () => {
      kin(true);
      // The reply of this mark is open beside it: the card says it already.
      const open = pt.reply && 'n' in pt.reply && pt.reply.n === m.n;
      if (!open) { badge.classList.add('pt-tip-on'); flipTip(badge); } if (news && view?.row) { markSeen([view.row]); badge.querySelector('.pt-pip')?.classList.remove('pt-pip-news'); syncSentButton(); } });
    hit.addEventListener('pointerleave', () => { badge.classList.remove('pt-tip-on'); kin(false); });
    badge.addEventListener('click', (e) => { e.stopPropagation(); (view ? onReply : onOpen)(m.n); });
    // The press must not start a stroke or move the focus out of the open field.
    badge.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.appendChild(badge);
    known.add(m.n);
    const at0 = pulsed.get(m.n);
    if (at0 !== undefined) { const el = performance.now() - at0; if (el < MS.pulse) playPulse(badge, el); else pulsed.delete(m.n); }
  }
  layer.appendChild(wrap);
  pt.pinLayer = wrap;
}

/** A tip that would run past the right edge of the window opens to the left of the badge instead. */
function flipTip(badge: HTMLElement): void {
  const tip = badge.querySelector<HTMLElement>('.pt-tip-badge');
  if (!tip) return;
  tip.style.left = `${BOX - 4}px`;
  const room = document.documentElement.clientWidth - 8;
  if (tip.getBoundingClientRect().right > room) tip.style.left = `${4 - tip.offsetWidth}px`;
}

/** Make a badge stand out for a moment (after the list took you to it). */
export function flashPin(n: number): void {
  const pin = pt.pinLayer?.querySelector<HTMLElement>(`.pt-badge[data-n="${n}"]`);
  if (!pin) return;
  pin.classList.add('pt-flash');
  setTimeout(() => pin.classList.remove('pt-flash'), 1400);
}
