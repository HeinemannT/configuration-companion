/**
 * Keeps corner badges readable and clickable where they would collide.
 *
 * A badge sits on the top-left edge of its host's outline, half above the
 * line, with its sub-badges beside it on one rail (`anchor: 'left'`). Short
 * hosts (tabs, menu buttons, links) keep a tile on the top-right corner,
 * half outside (`anchor: 'right'`, `.crev-label--edge`). Nested widgets put
 * several badges on the same corner, a host scrolled half out of view takes
 * its badge with it, a sticky page header can cover a badge, and a host
 * that clips its overflow would cut the half above the line. One rule fixes
 * all of them, applied as an offset (`translate`) so the badge still belongs
 * to, and scrolls with, its host:
 *
 *  1. Pull down: a badge above the visible top of its host (viewport top,
 *     the bottom of a page element covering it, or the top of the area the
 *     host is clipped to) moves down to that edge, but never below its host.
 *  2. Keep inside the viewport (and the clip area) horizontally.
 *  3. Nudge, then stack: a badge that overlaps one already placed moves
 *     along its rail past it (left for a right-anchored badge when the
 *     overlap is a sliver, right past it for a left-anchored one while it
 *     stays on its host), else moves down below it.
 *
 * A new badge stays hidden (`crev-label--placing`, set by syncOverlays)
 * until the first pass has placed it, and that pass runs in the next frame
 * (`placeNewBadges`), so a badge appears once, at its final place, instead
 * of showing in its corner first and then jumping beside its text.
 *
 * Cost: one pass reads every badge rect, then writes only the offsets that
 * changed, so there is a single layout per pass and no read/write
 * interleaving. Passes run after the page settles (scroll end, resize,
 * badge changes), never per scroll event.
 */

import { readOutlineLook, writeOutlineLook, type OutlineLook } from './content-outline';
import type { BackgroundSample } from './lib/badge-look';

/** Badges that float in their host's corner. Page-header and inline-start
 *  labels sit in the text flow and are never moved. */
const FLOATING = '.crev-label:not(.crev-page-label):not(.crev-label--inline-start)';
/** Companion elements: never treated as page elements covering a badge. */
const OURS = '.crev-label, .crev-frame, #crev-tooltip, #crev-toast-container, .crev-eo-host, .crev-eo-snap-ghost, #crev-locate-spot, #crev-locate-flag';
const GAP = 2;
/** `.crev-label-text` max-width in content-overlay.css. */
const NAME_MAX_W = 160;
/** Up to this much horizontal overlap a badge is nudged left, not stacked. */
const NUDGE_MAX = 12;
/** Stacking steps per badge before it is left where it is. */
const MAX_STEPS = 6;
/** A fixed/sticky element taller than this share of the viewport is not a
 *  header (see pinnedBottom). */
const MAX_HEADER_SHARE = 0.4;
/** Pause after the last scroll/resize before a pass runs. */
const SETTLE_MS = 120;

export interface Box { top: number; left: number; bottom: number; right: number }
export interface BadgeInput {
  /** The badge rect without any offset of ours. */
  natural: Box;
  /** Its host's rect. */
  host: Box;
  /** The visible top at the badge: viewport top or the bottom of a page
   *  element covering the badge. */
  visibleTop: number;
  /** Small hosts only (tabs, links, buttons): the box of the host's own
   *  text, which the badge must not cover (kept TEXT_CLEARANCE away). */
  text?: Box;
  /** The page's own controls near the badge (buttons, links, inputs, the
   *  widget's pencil and kebab): the badge must not cover them. */
  controls?: readonly Box[];
  /** The area the host is clipped to (its nearest clipping ancestor and the
   *  viewport). A moved badge must stay inside it; a badge hanging above a
   *  clipping host's top is pulled inside. */
  clip?: Box;
  /** The corner the badge hangs from: 'left' (the badge on the top-left
   *  edge) or 'right' (a short host's corner tile). Fit and dot shrink
   *  toward it; the rail runs away from it. Default 'right'. */
  anchor?: Anchor;
  /** Width of the badge's name text as shown in full. Given, a badge on
   *  the left edge may shorten its name (ellipsis) to stay clear. */
  textW?: number;
  /** Badges in one tab strip share a group: when one of them must be a dot,
   *  all of them are, so the strip reads the same from tab to tab. */
  group?: number;
}
export type Anchor = 'left' | 'right';
/** fit: the badge shows its type tile only, to stay off text or controls.
 *  dot: no place fits even the tile, so it shrinks to a dot in the corner.
 *  hidden: the host is scrolled under a sticky header; no badge shows. */
/** squeeze: the name is cut to this width (ellipsis) so the badge stays in
 *  its corner, clear of a control or the edge of the visible area. */
export interface Offset { dx: number; dy: number; dot?: boolean; fit?: boolean; hidden?: boolean; squeeze?: number }
/** The shortest name worth showing; below it the badge is its tile. */
export const MIN_NAME_W = 44;

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const shift = (b: Box, dx: number, dy: number): Box => ({ top: b.top + dy, bottom: b.bottom + dy, left: b.left + dx, right: b.right + dx });
const inside = (a: Box, c: Box) => a.top >= c.top && a.bottom <= c.bottom && a.left >= c.left && a.right <= c.right;
const grow = (b: Box, by: number): Box => ({ top: b.top - by, bottom: b.bottom + by, left: b.left - by, right: b.right + by });

/** Size of a badge shown as its type tile only (crev-label--fit). */
export const FIT_W = 22;
export const FIT_H = 20;
/** Space kept between a badge and the text of the element it marks. */
export const TEXT_CLEARANCE = 4;

/** Where a badge goes so it covers neither obstacles (its host's text,
 *  grown by the clearance, and nearby page controls) nor others (badges
 *  already placed), staying inside clip. In order: where it is; beside
 *  the obstacles it hits; in its corner with a shorter name (`textW`
 *  given); as a tile in its own corner (a widget's badge,
 *  `host` given); below the obstacles (not for a small element with text);
 *  then as a tile only: where it is,
 *  above / right of / left of the text, left of / below the obstacles.
 *  A full badge moved sideways stays on its host (`host`, left to right):
 *  past the host's edge it would read as its neighbour's badge.
 *  Null: nothing fits. */
export function clearOf(natural: Box, obstacles: readonly Box[], clip: Box, others: readonly Box[] = [], text?: Box, anchor: Anchor = 'right', host?: Box, textW?: number): Offset | null {
  const free = (b: Box) => inside(b, clip) && !obstacles.some(o => overlaps(b, o)) && !others.some(o => overlaps(b, o));
  if (free(natural)) return { dx: 0, dy: 0 };
  const onHost = (b: Box) => !host || (b.left >= host.left && b.right <= host.right);
  const sideOf = (b: Box): Offset[] => {
    const hit = obstacles.filter(o => overlaps(b, o));
    if (hit.length === 0) return [];
    const left = Math.min(...hit.map(o => o.left));
    const right = Math.max(...hit.map(o => o.right));
    const bottom = Math.max(...hit.map(o => o.bottom));
    const before: Offset = { dx: left - GAP - b.right, dy: 0 };
    const after: Offset = { dx: right + GAP - b.left, dy: 0 };
    // Along the rail first (away from the anchor corner), then below.
    return [...(anchor === 'left' ? [after, before] : [before]), { dx: 0, dy: bottom + GAP - b.top }];
  };
  // A small element (with text) does not move its full badge away: it
  // shrinks it to the tile first, next to the text.
  const tile: Box = tileOf(natural, anchor);
  if (!text) {
    const side = sideOf(natural);
    // Sideways on the host first; then the tile in the badge's own corner
    // (it stays on the outline); only then the full badge below the
    // obstacles, inside the widget.
    for (const c of side) if (c.dx !== 0 && free(shift(natural, c.dx, c.dy)) && onHost(shift(natural, c.dx, c.dy))) return c;
    // In its corner with a shorter name, up to the first thing in the way.
    if (host && textW != null && anchor === 'left') {
      const inWay = [...obstacles, ...others].filter(o => overlaps(natural, o) && o.left > natural.left);
      if (inWay.length) {
        const over = natural.right - (Math.min(...inWay.map(o => o.left)) - GAP);
        const cut: Box = { ...natural, right: natural.right - over };
        if (over > 0 && textW - over >= MIN_NAME_W && free(cut)) return { dx: 0, dy: 0, squeeze: Math.floor(textW - over) };
      }
    }
    if (host && free(tile)) return { dx: 0, dy: 0, fit: true };
    for (const c of side) if (c.dx === 0 && free(shift(natural, c.dx, c.dy))) return c;
  }
  const tiles: Offset[] = [{ dx: 0, dy: 0 }];
  if (text) {
    const midY = (text.top + text.bottom) / 2 - FIT_H / 2 - tile.top;
    tiles.push(
      { dx: 0, dy: text.top - TEXT_CLEARANCE - tile.bottom },
      { dx: text.right + TEXT_CLEARANCE - tile.left, dy: midY },
      { dx: text.left - TEXT_CLEARANCE - tile.right, dy: midY },
    );
  }
  tiles.push(...sideOf(tile));
  for (const c of tiles) if (free(shift(tile, c.dx, c.dy))) return { ...c, fit: true };
  return null;
}

/** The tile-only form of a badge: it keeps its anchor corner. */
function tileOf(natural: Box, anchor: Anchor): Box {
  return anchor === 'left'
    ? { top: natural.top, bottom: natural.top + FIT_H, left: natural.left, right: natural.left + FIT_W }
    : { top: natural.top, bottom: natural.top + FIT_H, right: natural.right, left: natural.right - FIT_W };
}

/** Clear of one text box only (a tab's label). */
export function clearOfText(natural: Box, text: Box, clip: Box, others: readonly Box[] = [], anchor: Anchor = 'right'): Offset | null {
  return clearOf(natural, [grow(text, TEXT_CLEARANCE)], clip, others, text, anchor);
}

/** The area a badge must stay inside. A tab's badge (one in a strip,
 *  `group`) also stays within its own tab left to right: the neighbouring
 *  tab paints over, or the tab cuts off, whatever hangs past its edge. */
function clipOf(it: BadgeInput, viewportWidth: number): Box | undefined {
  if (it.group == null) return it.clip;
  const c = it.clip ?? { top: -Infinity, left: 0, bottom: Infinity, right: viewportWidth };
  return { ...c, left: Math.max(c.left, it.host.left), right: Math.min(c.right, it.host.right) };
}

/** Pure placement of a set of badges in one viewport (for tests). */
export function layoutBadges(items: readonly BadgeInput[], viewportWidth: number): Offset[] {
  // Top first; on one line, from the anchor corner outwards.
  const along = (it: BadgeInput) => (it.anchor === 'left' ? it.natural.left : -it.natural.right);
  const order = items.map((_, i) => i).sort((a, b) =>
    items[a].natural.top - items[b].natural.top || along(items[a]) - along(items[b]));
  const out: Offset[] = items.map(() => ({ dx: 0, dy: 0 }));
  /** Each badge's offset after steps 1 and 2: where a dot goes. */
  const baseOff: Array<{ dx: number; dy: number }> = items.map(() => ({ dx: 0, dy: 0 }));
  const placed: Box[] = [];
  const texts = items.map(it => (it.text ? grow(it.text, TEXT_CLEARANCE) : null));
  const clips = items.map(it => clipOf(it, viewportWidth));
  for (const i of order) {
    const { natural, host, visibleTop, text, controls } = items[i];
    const clip = clips[i];
    const anchor = items[i].anchor ?? 'right';
    const height = natural.bottom - natural.top;
    // Host scrolled under a sticky header: not even a tile fits below it.
    if (host.bottom - visibleTop < FIT_H) { out[i] = { dx: 0, dy: 0, hidden: true }; continue; }
    let dx = 0, dy = 0;
    // 1. Pull down under the visible top, or the top of the clip area (a
    //    host that clips would cut the half above the line), but stay on
    //    the host.
    const floor = Math.max(visibleTop, clip?.top ?? -Infinity);
    if (natural.top < floor) dy = Math.min(floor + GAP - natural.top, Math.max(0, host.bottom - height - natural.top));
    // 2. Horizontal viewport (and clip) edges.
    const minX = Math.max(GAP, (clip?.left ?? -Infinity) + GAP);
    const maxX = Math.min(viewportWidth - GAP, (clip?.right ?? Infinity) - GAP);
    if (natural.left + dx < minX) dx += minX - natural.left;
    // A badge on the left edge is not pulled left of its host: it would sit
    // on the neighbour. Too wide for the space, it is cut at the right.
    const leftStop = anchor === 'left' ? Math.max(minX, Math.min(host.left, natural.left)) : minX;
    if (natural.right + dx > maxX && natural.left + dx - (natural.right + dx - maxX) >= leftStop) dx -= natural.right + dx - maxX;
    let base = shift(natural, dx, dy);
    // Still past the right edge: a shorter name, when enough of it is left.
    let nameW = anchor === 'left' && !text ? items[i].textW : undefined;
    let squeeze: number | undefined;
    if (nameW != null && base.right > maxX && nameW - (base.right - maxX) >= MIN_NAME_W) {
      nameW = Math.floor(nameW - (base.right - maxX));
      squeeze = nameW;
      base = { ...base, right: maxX };
    }
    baseOff[i] = { dx: Math.round(dx), dy: Math.round(dy) };
    // 3. Text of small hosts (own and neighbours') and nearby page controls.
    const ownText = texts[i];
    const near = grow(base, 40);
    const neighbourTexts = texts.filter((t, j): t is Box => j !== i && !!t && overlaps(t, near));
    const obstacles = [...(ownText ? [ownText] : []), ...neighbourTexts, ...(controls ?? [])];
    if (obstacles.length > 0) {
      const area = clip ?? { top: 0, left: 0, bottom: Infinity, right: viewportWidth };
      const off = clearOf(base, obstacles, { ...area, top: Math.max(area.top, visibleTop) }, placed, text, anchor, host, nameW);
      if (off) {
        const cut = off.squeeze != null && nameW != null ? { ...base, right: base.right - (nameW - off.squeeze) } : base;
        placed.push(shift(off.fit ? tileOf(base, anchor) : cut, off.dx, off.dy));
        const name = off.fit ? undefined : off.squeeze ?? squeeze;
        out[i] = { dx: Math.round(dx + off.dx), dy: Math.round(dy + off.dy), ...(off.fit ? { fit: true } : {}), ...(name != null ? { squeeze: name } : {}) };
        continue;
      }
      if (text) {
        out[i] = base.top < visibleTop ? { dx: 0, dy: 0, hidden: true } : { dx: Math.round(dx), dy: Math.round(dy), dot: true };
        continue;
      }
    }
    // 4. Nudge, then stack.
    let box = base;
    for (let step = 0; step < MAX_STEPS; step++) {
      const hit = placed.find(p => overlaps(box, p));
      if (!hit) break;
      if (anchor === 'left') {
        // Along the rail: right past the badge it meets while that stays on
        // its host and in the viewport; else below it.
        const past = hit.right + GAP - box.left;
        if (past > 0 && box.right + past <= Math.min(host.right, maxX)) dx += past;
        else dy += hit.bottom + GAP - box.top;
      } else {
        const sliver = box.right - hit.left;
        if (sliver > 0 && sliver <= NUDGE_MAX && box.left - sliver - GAP >= GAP) {
          dx -= sliver + GAP;
        } else {
          dy += hit.bottom + GAP - box.top;
        }
      }
      box = { ...shift(natural, dx, dy), ...(squeeze != null ? { right: natural.left + dx + (base.right - base.left) } : {}) };
    }
    placed.push(box);
    out[i] = { dx: Math.round(dx), dy: Math.round(dy), ...(squeeze != null ? { squeeze } : {}) };
  }
  // 5. One dot in a tab strip makes the whole strip dots: no strip mixes
  //    tiles and dots. (A small host's badge is never cut by its clip area:
  //    step 3 places it inside, else makes it the dot.)
  const dotted = new Set(items.flatMap((it, i) => (it.group != null && out[i].dot ? [it.group] : [])));
  if (dotted.size) {
    items.forEach((it, i) => {
      if (it.group != null && dotted.has(it.group) && !out[i].dot && !out[i].hidden) out[i] = { ...baseOff[i], dot: true };
    });
  }
  return out;
}

function currentOffset(el: HTMLElement): Offset {
  return { dx: Number(el.dataset.crevDx) || 0, dy: Number(el.dataset.crevDy) || 0 };
}

function setOffset(el: HTMLElement, o: Offset): void {
  const dot = !!o.dot, fit = !!o.fit, hidden = !!o.hidden;
  if (el.classList.contains('crev-label--covered') !== hidden) el.classList.toggle('crev-label--covered', hidden);
  if (el.classList.contains('crev-label--dot') !== dot) el.classList.toggle('crev-label--dot', dot);
  if (el.classList.contains('crev-label--fit') !== fit) el.classList.toggle('crev-label--fit', fit);
  const name = o.squeeze != null && !dot && !fit && !hidden ? `${o.squeeze}px` : '';
  if (el.style.getPropertyValue('--crev-name-max') !== name) {
    if (name) el.style.setProperty('--crev-name-max', name); else el.style.removeProperty('--crev-name-max');
  }
  const cur = currentOffset(el);
  if (cur.dx === o.dx && cur.dy === o.dy) return;
  if (o.dx === 0 && o.dy === 0) {
    el.style.removeProperty('translate');
    delete el.dataset.crevDx;
    delete el.dataset.crevDy;
    el.classList.remove('crev-label--moved');
    return;
  }
  el.style.translate = `${o.dx}px ${o.dy}px`;
  el.dataset.crevDx = String(o.dx);
  el.dataset.crevDy = String(o.dy);
  el.classList.add('crev-label--moved');
}

/** The bottom edge of the fixed or sticky page element `el` belongs to
 *  (a sticky header, a pinned toolbar), or null. Cached per pass: many
 *  badges meet the same header. */
function pinnedBottom(el: Element, cache: Map<Element, number | null>): number | null {
  const seen: Element[] = [];
  let found: number | null = null;
  for (let a: Element | null = el, depth = 0; a && a !== document.body && depth < 10; a = a.parentElement, depth++) {
    const known = cache.get(a);
    if (known !== undefined) { found = known; break; }
    seen.push(a);
    const pos = getComputedStyle(a).position;
    if (pos === 'fixed' || pos === 'sticky') {
      // A header is a band along the top. A full-height fixed layer (a page
      // background, a drawer) is not, and must not push badges down.
      const r = a.getBoundingClientRect();
      found = r.height > 0 && r.height <= window.innerHeight * MAX_HEADER_SHARE ? r.bottom : null;
      break;
    }
  }
  for (const e of seen) cache.set(e, found);
  return found;
}

/** The visible top at a point near a badge's top: the viewport top, or the
 *  bottom of the fixed/sticky page elements painted over that point that do
 *  not belong to the badge's host. Stacked headers (a top bar, then a sticky
 *  tab strip under it) are followed down, up to three. */
function visibleTopAt(x: number, y: number, host: Element, cache: Map<Element, number | null>): number {
  let top = 0;
  for (let i = 0; i < 3; i++) {
    const probe = Math.max(y, top + 1);
    if (probe >= window.innerHeight) break;
    const first = document.elementsFromPoint(x, probe).find(e => !e.closest(OURS));
    if (!first || first === host || host.contains(first) || first.contains(host)) break;
    const bottom = pinnedBottom(first, cache);
    if (bottom == null || bottom <= top) break;
    top = bottom;
  }
  return top;
}

/** Hosts up to this tall are "small" (tabs, links, buttons, chips): their
 *  badge must not cover their text. */
const SMALL_HOST = 48;

/** The box of `host`'s own text (not our badges'), or undefined. */
function textBox(host: Element): Box | undefined {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let box: Box | undefined;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim() || n.parentElement?.closest('.crev-label')) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (!r.width || !r.height) continue;
      box = box
        ? { top: Math.min(box.top, r.top), left: Math.min(box.left, r.left), bottom: Math.max(box.bottom, r.bottom), right: Math.max(box.right, r.right) }
        : { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    }
  }
  return box;
}

/** The viewport, cut by the nearest ancestors of `host` that clip their
 *  content. Cached per pass by ancestor. */
function clipBox(host: Element, vw: number, vh: number, cache: Map<Element, Box>): Box {
  let box: Box = { top: 0, left: 0, bottom: vh, right: vw };
  for (let a: Element | null = host, depth = 0; a && a !== document.body && depth < 8; a = a.parentElement, depth++) {
    let c = cache.get(a);
    if (!c) {
      const cs = getComputedStyle(a);
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      const r = a.getBoundingClientRect();
      c = clips ? { top: r.top, left: r.left, bottom: r.bottom, right: r.right } : { top: -Infinity, left: -Infinity, bottom: Infinity, right: Infinity };
      cache.set(a, c);
    }
    box = { top: Math.max(box.top, c.top), left: Math.max(box.left, c.left), bottom: Math.min(box.bottom, c.bottom), right: Math.min(box.right, c.right) };
  }
  return box;
}

/** The page's own interactive elements inside the host near the badge: a
 *  badge must never sit on the widget's pencil, kebab or a button. */
const CONTROLS = 'button, [role="button"], a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const NEAR = 48;
function controlBoxes(host: Element, near: Box): Box[] {
  const area = grow(near, NEAR);
  const out: Box[] = [];
  for (const el of host.querySelectorAll(CONTROLS)) {
    if (el.closest(OURS)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // A control that is most of the widget (a whole clickable card) is not
    // an obstacle; the badge sits on it by design.
    if (r.width * r.height > 12_000) continue;
    const b: Box = { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    if (overlaps(b, area)) out.push(grow(b, GAP));
    if (out.length >= 16) break;
  }
  return out;
}

/** A BMP tab (tab set) or an ARIA tab (dom-scanner's ANY_TAB_SELECTOR). */
const TAB = '.corpo-tabSet__tab, [role="tab"]';
/** Levels above a tab searched for the strip that holds its siblings. */
const STRIP_DEPTH = 4;

/** The tab strip `host` belongs to, as a number shared by every badge of
 *  that strip (the nearest ancestor of its tab holding another tab), or
 *  undefined outside a strip. Cached per pass by the tab's parent. */
export function stripOf(host: Element, cache: Map<Element, number | null>): number | undefined {
  const tab = host.closest(TAB) ?? (host.querySelector(TAB) && host.querySelectorAll(TAB).length === 1 ? host : null);
  const from = tab?.parentElement;
  if (!from) return undefined;
  let id = cache.get(from);
  if (id === undefined) {
    id = null;
    for (let a: Element | null = from, depth = 0; a && a !== document.body && depth < STRIP_DEPTH; a = a.parentElement, depth++) {
      if (a.querySelectorAll(TAB).length > 1) {
        const known = cache.get(a);
        id = known ?? cache.size + 1;
        cache.set(a, id);
        break;
      }
    }
    cache.set(from, id);
  }
  return id ?? undefined;
}

/** A badge not placed yet: hidden (visibility only, so it still measures)
 *  until the first layout pass. */
export const PLACING_CLASS = 'crev-label--placing';

function revealPlaced(labels: readonly HTMLElement[]): void {
  for (const label of labels) if (label.classList.contains(PLACING_CLASS)) label.classList.remove(PLACING_CLASS);
}

/** QA switch: `<html data-crev-badge-layout="off">` turns the pass off and
 *  puts every badge back in its corner, for before/after comparisons. */
const isOff = () => document.documentElement.dataset.crevBadgeLayout === 'off';

/** A short host's corner tile hangs from the top-right corner; every other
 *  badge from the top-left edge. */
export function labelAnchor(label: Element): Anchor {
  return label.classList.contains('crev-label--edge') || label.classList.contains('crev-label--edge-inside') ? 'right' : 'left';
}

/** One read pass, then one write pass, over every floating badge in view. */
export function runBadgeLayout(): void {
  const labels = [...document.querySelectorAll<HTMLElement>(FLOATING)];
  if (labels.length === 0) return;
  if (isOff()) { for (const label of labels) setOffset(label, { dx: 0, dy: 0 }); revealPlaced(labels); return; }
  const vw = window.innerWidth, vh = window.innerHeight;
  const inputs: BadgeInput[] = [];
  const targets: HTMLElement[] = [];
  const reset: HTMLElement[] = [];
  const pinned = new Map<Element, number | null>();
  const clips = new Map<Element, Box>();
  const sizes: Array<[HTMLElement, number, number]> = [];
  const looks: Array<[HTMLElement, OutlineLook | null]> = [];
  const lookCache = new Map<Element, BackgroundSample>();
  const strips = new Map<Element, number | null>();
  /** Badges of tabs outside the viewport, with their strip. */
  const offscreen: Array<[HTMLElement, number]> = [];
  // Read pass.
  for (const label of labels) {
    const host = label.parentElement;
    if (!host) continue;
    // Nesting and backdrop of the outline (content-outline.ts): reads only.
    looks.push([label, readOutlineLook(label, host, lookCache)]);
    const r = label.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { reset.push(label); continue; }
    const { dx, dy } = currentOffset(label);
    const anchor = labelAnchor(label);
    // A dot is measured at the badge's full size (kept from when it was
    // shown in full), anchored at the same corner.
    const dotted = label.classList.contains('crev-label--dot') || label.classList.contains('crev-label--fit');
    // A covered badge is still laid out (visibility only), so it measures in full.
    // A shortened name is measured back to its full width.
    const nameEl = dotted ? null : label.querySelector<HTMLElement>(':scope > .crev-stub .crev-label-text');
    const shownW = nameEl ? nameEl.getBoundingClientRect().width : 0;
    const textW = nameEl && shownW > 0 ? Math.min(nameEl.scrollWidth, NAME_MAX_W) : undefined;
    const w = dotted ? Number(label.dataset.crevFullW) || r.width : r.width + (textW != null ? Math.max(0, textW - shownW) : 0);
    const ht = dotted ? Number(label.dataset.crevFullH) || r.height : r.height;
    if (!dotted) sizes.push([label, Math.round(w), Math.round(r.height)]);
    const natural: Box = anchor === 'left'
      ? { top: r.top - dy, bottom: r.top - dy + ht, left: r.left - dx, right: r.left - dx + w }
      : { top: r.top - dy, bottom: r.top - dy + ht, left: r.right - dx - w, right: r.right - dx };
    const h = host.getBoundingClientRect();
    if (h.bottom < 0 || h.top > vh || h.right < 0 || h.left > vw) {
      // A tab scrolled out of its strip takes the strip's form (see below).
      const group = h.height <= SMALL_HOST && textBox(host) ? stripOf(host, strips) : undefined;
      if (group != null) offscreen.push([label, group]); else reset.push(label);
      continue;
    }
    const probeX = Math.min(vw - 1, Math.max(0, (natural.left + natural.right) / 2));
    const probeY = Math.max(0, natural.top + 1);
    const small = h.height <= SMALL_HOST;
    const text = small ? textBox(host) : undefined;
    const controls = controlBoxes(host, natural);
    const group = text ? stripOf(host, strips) : undefined;
    inputs.push({
      natural, host: h, anchor,
      ...(textW != null ? { textW } : {}),
      ...(group != null ? { group } : {}),
      visibleTop: probeY < vh ? visibleTopAt(probeX, probeY, host, pinned) : 0,
      ...(text ? { text } : {}),
      ...(controls.length ? { controls } : {}),
      // Always: a badge half above a clipping host's top is pulled inside.
      clip: clipBox(host, vw, vh, clips),
    });
    targets.push(label);
  }
  const offsets = layoutBadges(inputs, vw);
  // Write pass.
  for (const [label, look] of looks) writeOutlineLook(label, look);
  for (const [label, w, h] of sizes) {
    if (label.dataset.crevFullW !== String(w)) label.dataset.crevFullW = String(w);
    if (label.dataset.crevFullH !== String(h)) label.dataset.crevFullH = String(h);
  }
  for (const label of reset) setOffset(label, { dx: 0, dy: 0 });
  // All tabs of a strip use one form, in view or not: a dot when the strip's
  // visible tabs are dots, else in full.
  const dotted = new Set(inputs.flatMap((it, i) => (it.group != null && offsets[i].dot ? [it.group] : [])));
  for (const [label, group] of offscreen) setOffset(label, { dx: 0, dy: 0, ...(dotted.has(group) ? { dot: true } : {}) });
  targets.forEach((label, i) => setOffset(label, offsets[i]));
  // In the same write as their offsets: the first paint shows them placed.
  revealPlaced(labels);
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let frame = 0;

/** Run a pass once the page has settled (`delay` 0: in the next frame,
 *  before it paints). Repeated calls coalesce. */
export function scheduleBadgeLayout(delay = SETTLE_MS): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  const inFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; runBadgeLayout(); });
  };
  if (delay <= 0) { inFrame(); return; }
  settleTimer = setTimeout(() => { settleTimer = null; inFrame(); }, delay);
}

/** After badges were added or changed their content: place them in the next
 *  frame, before it paints, when a new badge waits hidden for its place or
 *  `changed` says a badge's size changed; else after the page settles. */
export function placeNewBadges(changed = false): void {
  scheduleBadgeLayout(changed || document.querySelector(`.${PLACING_CLASS}`) ? 0 : SETTLE_MS);
}

/** Re-run the layout after scrolls (any scroll container) and resizes.
 *  Passive listeners that never stop the page's own handling. */
export function watchBadgeLayout(signal: AbortSignal): void {
  const onChange = () => scheduleBadgeLayout();
  document.addEventListener('scroll', onChange, { capture: true, passive: true, signal });
  window.addEventListener('resize', onChange, { passive: true, signal });
  signal.addEventListener('abort', () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
  }, { once: true });
}
