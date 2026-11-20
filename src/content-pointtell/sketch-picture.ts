/**
 * Point and tell: a picture Companion draws itself, for a Send when the browser gives no screenshot. It is a
 * wireframe of the window: every object of the layout as a box where it is on the screen, with its type and name,
 * and inside it what the page visibly shows there (headings, labels, button captions, field boxes, a table's header
 * and first rows, charts and images by their title), in quiet greys. The user's ink goes on top, then the number
 * badges: a mark on an object has its badge inside that object's box (or beside it on a short line), and the object
 * is outlined; ink keeps its own place. It shows layout and marks, not BMP's own pixels, and says so at the bottom.
 * Only the live page is read; nothing is fetched and no permission is needed.
 */
import { findNode } from '../lib/layout/model';
import type { PtTarget } from '../lib/point-tell/hit';
import { getTypeAbbr, getTypeColor } from '../lib/type-registry';
import { ridElementMap } from '../content-blueprint/geometry';
import { badgeStart } from './ink-marks';
import { badgeCenter, markRect } from './pins';
import { currentPageName } from './measure';
import { pt } from './state';
import { domGeo, outermostElements, readWidget, wireBudget, type WireItem } from './wireframe';

const VIOLET = '#8a3ffc';

export interface DrawnBox { id: string; name: string; type: string; x: number; y: number; w: number; h: number }

/** The boxes to draw: targets in window coordinates, largest first so nested ones sit on top, those off screen left out. */
export function boxesFor(targets: readonly PtTarget[], labelOf: (id: string) => { name: string; type: string }, scroll: { x: number; y: number }, view: { w: number; h: number }): DrawnBox[] {
  return targets
    .map(t => ({ t, x: t.rect.left - scroll.x, y: t.rect.top - scroll.y, w: t.rect.width, h: t.rect.height }))
    .filter(b => b.w >= 8 && b.h >= 8 && b.x < view.w && b.y < view.h && b.x + b.w > 0 && b.y + b.h > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .map(b => ({ id: b.t.id, ...labelOf(b.t.id), x: b.x, y: b.y, w: b.w, h: b.h }));
}

/** Text that fits `width`: whole, or cut at a word with an ellipsis; nothing when less than a few characters would be left. */
function clip(g: CanvasRenderingContext2D, text: string, width: number): string {
  if (width <= 4) return '';
  if (g.measureText(text).width <= width) return text;
  return cutWords(text, n => g.measureText(`${text.slice(0, n)}…`).width <= width);
}

/** The words of `text` that fit (by `fits(characters)`), with an ellipsis; '' when fewer than 6 characters fit. */
export function cutWords(text: string, fits: (n: number) => boolean, least = 6): string {
  let lo = 0, hi = text.length;
  // Binary search for the longest start that fits with the ellipsis.
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1; }
  if (lo < least) return '';
  const space = text.lastIndexOf(' ', lo);
  const end = space >= least && text[lo] !== ' ' ? space : lo;
  return `${text.slice(0, end).trimEnd().replace(/[,;:·\-–]$/, '')}…`;
}

/** A number badge in the picture: the mark's number in the sketch and where its circle goes (window coordinates). */
export interface BadgeSpot { label: string; x: number; y: number }

/**
 * Badges that would cover each other (two ink marks starting at one place) are moved apart, to the left first and
 * then to the right, so that every number can be read. The first keeps its place. `gap` is the distance between centres.
 */
export function spreadBadges(spots: readonly BadgeSpot[], width: number, gap = 24, taken: readonly BadgeSpot[] = []): BadgeSpot[] {
  const out: BadgeSpot[] = [];
  const clear = (x: number, y: number): boolean => [...taken, ...out].every(o => Math.hypot(o.x - x, o.y - y) >= gap);
  for (const s of spots) {
    let at = { x: s.x, y: s.y };
    for (let i = 1; !clear(at.x, at.y) && i < 40; i++) {
      const step = Math.ceil(i / 2) * gap * (i % 2 ? -1 : 1);
      const x = s.x + step;
      if (x >= 12 && x <= width - 12) at = { x, y: s.y };
    }
    out.push({ label: s.label, ...at });
  }
  return out;
}

export interface Box { x: number; y: number; w: number; h: number }
/** A badge to place: on an object (its box, window coordinates), or at the start of ink. */
export type BadgeAsk = { label: string; object: string; box: Box } | { label: string; at: { x: number; y: number } };
/** A placed badge; `leader` is the point on the object's edge a short line goes to, when the badge sits outside it. */
export interface PlacedBadge { label: string; x: number; y: number; object?: string; leader?: { x: number; y: number } }

/** Badge radius in the picture, the room around it, and the distance between the centres of badges in a row. */
export const BADGE_R = 10;
const PAD = 3;
const STEP = BADGE_R * 2 + 3;

const contains = (o: Box, b: Box): boolean => o.x <= b.x + 0.5 && o.y <= b.y + 0.5 && o.x + o.w >= b.x + b.w - 0.5 && o.y + o.h >= b.y + b.h - 0.5;
const hitsCircle = (o: Box, x: number, y: number, r: number): boolean => {
  const nx = Math.max(o.x, Math.min(x, o.x + o.w)), ny = Math.max(o.y, Math.min(y, o.y + o.h));
  // Strictly inside the circle: a box that only touches it does not count.
  return Math.hypot(nx - x, ny - y) < r - 0.5;
};
/** The point on a box's edge nearest to (x, y). */
export function edgePoint(b: Box, x: number, y: number): { x: number; y: number } {
  const cx = Math.max(b.x, Math.min(x, b.x + b.w)), cy = Math.max(b.y, Math.min(y, b.y + b.h));
  return { x: cx, y: cy };
}

/**
 * Where the badges go. A mark on an object has its badge inside the object's box, in a corner (top right first, then
 * bottom right, bottom left, top left; each moved along its edge, up to the middle, when something is in the way), with the object's other badges beside it in reading order (in rows when the
 * box is narrow). A corner is taken only where the badges cover no object the box holds and none of `soft` (the
 * buttons, fields and pictures drawn inside). When no corner is free, the badges go just outside the box (right,
 * left, below, above), on a short line to it, where they touch no other object. Ink keeps its place (badges on one
 * spot move apart). `others` are every box drawn; `holds(outer, inner)` says one object holds another (by the
 * layout; by the boxes when not given).
 */
export function placeBadges(asks: readonly BadgeAsk[], others: readonly (Box & { id: string })[], view: { w: number; h: number }, holds?: (outer: string, inner: string) => boolean, soft: readonly Box[] = []): PlacedBadge[] {
  const out: PlacedBadge[] = [];
  const groups = new Map<string, { box: Box; labels: string[] }>();
  const ink: BadgeSpot[] = [];
  for (const a of asks) {
    if ('at' in a) { ink.push({ label: a.label, x: a.at.x, y: a.at.y }); continue; }
    const g = groups.get(a.object) ?? { box: a.box, labels: [] };
    g.labels.push(a.label);
    groups.set(a.object, g);
  }
  const R = BADGE_R;
  // A badge may sit on its own box and on what holds that box; never on what the box holds, never on a neighbour.
  const free = (id: string, box: Box, x: number, y: number): boolean => {
    if (x - R < 1 || y - R < 1 || x + R > view.w - 1 || y + R > view.h - 1) return false;
    if (out.some(p => Math.hypot(p.x - x, p.y - y) < STEP - 0.5)) return false;
    return others.every(o => o.id === id || (holds ? holds(o.id, id) : contains(o, box)) || !hitsCircle(o, x, y, R + 2));
  };

  for (const [id, { box, labels }] of groups) {
    const n = labels.length;
    const cols = Math.max(1, Math.floor((box.w - 2 * PAD) / STEP));
    const rowsNeeded = Math.ceil(n / cols);
    // In the top right corner, in reading order: the first number on the left of its row.
    // A corner, moved `k` steps along its edge toward the middle (past a button in the corner, say).
    const corner = (right: boolean, top: boolean, k: number) => (i: number): { x: number; y: number } => {
      const row = Math.floor(i / cols), inRow = Math.min(cols, n - row * cols), col = i % cols;
      const x = right ? box.x + box.w - PAD - R - (inRow - 1 - col + k) * STEP : box.x + PAD + R + (col + k) * STEP;
      const y = top ? box.y + PAD + R + row * STEP : box.y + box.h - PAD - R - (rowsNeeded - 1 - row) * STEP;
      return { x, y };
    };
    const fits = box.w >= 2 * R + 2 * PAD && box.h >= rowsNeeded * STEP + 2 * PAD - 3;
    const clearOfSoft = (p: { x: number; y: number }): boolean => soft.every(s => !contains(box, s) || !hitsCircle(s, p.x, p.y, R + 1));
    const slide = Math.max(0, Math.floor((box.w / 2 - Math.min(n, cols) * STEP) / STEP));
    const candidates = ([[true, true], [true, false], [false, false], [false, true]] as const)
      .flatMap(([right, top]) => Array.from({ length: slide + 1 }, (_, k) => corner(right, top, k)));
    const inside = fits ? candidates.find(f => labels.every((_, i) => { const p = f(i); return free(id, box, p.x, p.y) && clearOfSoft(p); })) : undefined;
    if (inside) {
      labels.forEach((label, i) => out.push({ label, ...inside(i), object: id }));
      continue;
    }
    // Beside the box, on a short line.
    const GAP = 8;
    const sides: Array<(i: number) => { x: number; y: number }> = [
      i => ({ x: box.x + box.w + GAP + R + i * STEP, y: box.y + Math.min(box.h / 2, 14) }),
      i => ({ x: box.x - GAP - R - (n - 1 - i) * STEP, y: box.y + Math.min(box.h / 2, 14) }),
      i => ({ x: box.x + box.w - R - (n - 1 - i) * STEP, y: box.y + box.h + GAP + R }),
      i => ({ x: box.x + box.w - R - (n - 1 - i) * STEP, y: box.y - GAP - R }),
    ];
    const side = sides.find(f => labels.every((_, i) => { const p = f(i); return free(id, box, p.x, p.y); }));
    if (side) {
      labels.forEach((label, i) => {
        const p = side(i);
        // One line from the badge nearest the box.
        const near = side === sides[0] ? i === 0 : i === n - 1;
        out.push({ label, ...p, object: id, ...(near ? { leader: edgePoint(box, p.x, p.y) } : {}) });
      });
      continue;
    }
    // Nowhere free: in the middle of the box, which is then unmistakably the one it marks.
    const cx = box.x + box.w / 2 - ((n - 1) * STEP) / 2, cy = box.y + box.h / 2;
    labels.forEach((label, i) => out.push({ label, x: Math.min(view.w - R, Math.max(R, cx + i * STEP)), y: Math.min(view.h - R, Math.max(R, cy)), object: id }));
  }
  for (const s of spreadBadges(ink, view.w, STEP, out)) out.push({ label: s.label, x: s.x, y: s.y });
  return out;
}

/** Where the picture starts: just above the first thing it shows (the page's own header above it stays out). */
export function contentTop(tops: readonly number[], height: number): number {
  const visible = tops.filter(t => Number.isFinite(t) && t < height);
  if (!visible.length) return 0;
  return Math.max(0, Math.min(height - 40, Math.floor(Math.min(...visible)) - 14));
}

/** An object's label: its name, or its ID when it has none of its own. */
export const boxName = (name: string | undefined, id: string): string => (name && name !== id ? name : `ID ${id}`);

const BAND = 40;
const FOOT = 22;
const FONT = "system-ui, 'Segoe UI', sans-serif";
/** The greys of what a widget holds: body text, strong text, lines, fills. */
const INK = { text: '#6b7380', strong: '#3d434c', line: '#c3c9d1', fill: '#f2f4f7', faint: '#9aa1ab', box: '#cfd4db' };

/** How long the last drawing took, and what it read: for checks on big pages. */
export const lastDraw = { ms: 0, items: 0, cut: false };

/** The page's elements of the boxes (widgets only; containers have none of their own). */
function elementsOf(boxes: readonly DrawnBox[]): Element[] {
  const model = pt.model;
  if (!model) return [];
  const byRid = ridElementMap();
  const reverse = new Map(Object.entries(pt.links).map(([rid, id]) => [id, rid]));
  const els: Element[] = [];
  for (const b of boxes) {
    const n = findNode(model, b.id)?.node;
    if (!n || n.kind !== 'widget') continue;
    const rid = reverse.get(n.id) ?? n.rid;
    const el = rid ? byRid.get(rid) : undefined;
    if (el) els.push(el);
  }
  return els;
}

function drawItem(g: CanvasRenderingContext2D, it: WireItem): void {
  switch (it.k) {
    case 'head':
      g.fillStyle = INK.fill; g.fillRect(it.x, it.y, it.w, it.h);
      g.fillStyle = INK.line; g.fillRect(it.x, it.y + it.h - 1, it.w, 1);
      return;
    case 'field':
      g.fillStyle = '#ffffff'; g.strokeStyle = INK.line; g.lineWidth = 1;
      g.beginPath(); g.roundRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1, 3); g.fill(); g.stroke();
      return;
    case 'button': {
      g.fillStyle = '#fafbfc'; g.strokeStyle = '#aab1bb'; g.lineWidth = 1;
      g.beginPath(); g.roundRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1, Math.min(6, it.h / 2)); g.fill(); g.stroke();
      if (!it.text) return;
      g.fillStyle = INK.strong; g.font = `500 ${Math.max(9, Math.min(12, it.h - 8))}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(clip(g, it.text, it.w - 8), it.x + it.w / 2, it.y + it.h / 2 + 0.5);
      g.textAlign = 'left'; g.textBaseline = 'top';
      return;
    }
    case 'media': {
      g.fillStyle = '#f6f7f9'; g.strokeStyle = INK.box; g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.beginPath(); g.rect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1); g.fill(); g.stroke();
      g.setLineDash([]);
      g.fillStyle = INK.faint; g.font = `italic 11px ${FONT}`; g.textBaseline = 'top';
      const words = `${it.what === 'chart' ? 'Chart' : 'Image'}${it.text ? `: ${it.text}` : ''}`;
      g.fillText(clip(g, words, it.w - 10), it.x + 5, it.y + 9);
      return;
    }
    case 'more':
      g.fillStyle = INK.faint; g.font = `italic 11px ${FONT}`; g.textBaseline = 'top';
      g.fillText(clip(g, it.text, it.w), it.x, it.y);
      return;
    case 'text': {
      let size = Math.max(8, Math.min(it.size, it.h * 0.95));
      g.fillStyle = it.strong ? INK.strong : INK.text;
      g.font = `${it.strong ? 600 : 400} ${size}px ${FONT}`;
      // The picture's font is not the page's: a little wider text is drawn a little smaller rather than cut.
      const wide = g.measureText(it.text).width;
      if (wide > it.w + 2) { size = Math.max(8, size * Math.max(0.8, (it.w + 2) / wide)); g.font = `${it.strong ? 600 : 400} ${size}px ${FONT}`; }
      g.textBaseline = 'middle';
      g.fillText(clip(g, it.text, it.w + 2), it.x, it.y + it.h / 2 + 0.5);
      g.textBaseline = 'top';
    }
  }
}

/**
 * A PNG of the window as a wireframe with the marks, or null when there is nothing to draw it from. A band at the
 * top names the page; the tabs are drawn with their names (the shown one marked); the empty top of the window is
 * left out. Only the badges in `numbers` (the marks of this sketch, by internal number, with their number in it)
 * are drawn: marks sent before are on the page as faint ink only.
 */
export async function drawnPicture(numbers: ReadonlyMap<number, number>): Promise<Blob | null> {
  const scene = pt.scene, model = pt.model;
  if (!scene || !model) return null;
  const t0 = performance.now();
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const scroll = { x: window.scrollX, y: window.scrollY };
  const label = (id: string): { name: string; type: string } => {
    const n = findNode(model, id)?.node;
    return { name: boxName(n?.name, id), type: n?.kind === 'tab' ? '' : n?.className || '' };
  };
  const boxes = boxesFor(scene.targets, label, scroll, { w, h });
  const pills = boxesFor(scene.pills, label, scroll, { w, h }).sort((a, b) => a.x - b.x);

  // What the widgets show, read once per outermost widget.
  const geo = domGeo();
  const budget = wireBudget(geo);
  const items: WireItem[] = [];
  const view = { x: 0, y: 0, w, h };
  for (const el of outermostElements(elementsOf(boxes))) {
    items.push(...readWidget(el, view, geo, budget));
    if (budget.cut || budget.items <= 0) break;
  }

  // The badges: on an object, inside its box; at the start of ink, where the page shows them.
  const asks: BadgeAsk[] = [];
  for (const m of pt.marks) {
    const k = numbers.get(m.n);
    if (k === undefined) continue;
    const start = badgeStart(m);
    if (!start && m.targets.length) {
      const id = m.targets[0];
      const box = boxes.find(b => b.id === id) ?? pills.find(p => p.id === id);
      if (box) { asks.push({ label: String(k), object: id, box }); continue; }
    }
    const c = badgeCenter(m.n);
    const r = c ? null : markRect(m);
    if (!c && !r) continue;
    const x = c ? c.x - scroll.x : r!.left - scroll.x, y = c ? c.y - scroll.y : r!.top - scroll.y;
    asks.push({ label: String(k), at: { x: Math.min(w - 12, Math.max(12, x)), y: Math.min(h - 12, Math.max(12, y)) } });
  }
  const holds = (outer: string, inner: string): boolean => {
    for (let p = findNode(model, inner)?.parent; p; p = findNode(model, p.id)?.parent ?? null) if (p.id === outer) return true;
    return false;
  };
  const soft = items.filter(i => i.k === 'button' || i.k === 'field' || i.k === 'media');
  const badges = placeBadges(asks, [...boxes, ...pills], { w, h }, holds, soft);
  const inkTop = pt.ink ? inkTopOf(pt.ink.el) : Infinity;
  const top = contentTop([...boxes.map(b => b.y), ...pills.map(p => p.y), ...badges.map(b => b.y - 12), inkTop], h);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = BAND + h - top + FOOT;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.textBaseline = 'top';

  // The band: the page's name.
  const title = currentPageName() ?? model.pageName ?? '';
  g.fillStyle = '#161616'; g.font = `700 15px ${FONT}`;
  g.fillText(clip(g, title || 'Page', w - 28), 14, 12);
  g.fillStyle = '#e9ecf0'; g.fillRect(0, BAND - 1, w, 1);

  g.save();
  g.beginPath(); g.rect(0, BAND, w, h - top); g.clip();
  g.translate(0, BAND - top);
  // The boxes: an outline each, containers dashed.
  for (const b of boxes) {
    const container = findNode(model, b.id)?.node.kind === 'container';
    g.strokeStyle = container ? '#e4e7eb' : INK.box; g.lineWidth = 1;
    g.setLineDash(container ? [5, 4] : []);
    g.beginPath(); g.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 4); g.stroke();
    g.setLineDash([]);
  }
  for (const it of items) drawItem(g, it);
  // A marked object is outlined in the badge's colour.
  const marked = new Set(badges.flatMap(b => (b.object ? [b.object] : [])));
  g.strokeStyle = VIOLET; g.lineWidth = 2;
  for (const b of [...boxes, ...pills]) if (marked.has(b.id)) { g.beginPath(); g.roundRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, 4); g.stroke(); }
  // The labels: type and name on the top edge of each box, on a chip over the edge so neither the outline nor what is
  // inside crosses them. A marked object's label is the plainest of all. Containers are faint frames without a
  // label unless a mark is on them; then the label sits at the right end of the edge, clear of the others.
  const kindOf = (id: string) => findNode(model, id)?.node.kind;
  const labelled: Box[] = [];
  const order = [...boxes.filter(x => kindOf(x.id) !== 'container'), ...boxes.filter(x => kindOf(x.id) === 'container' && marked.has(x.id))];
  for (const b of order) {
    if (b.w < 44 || b.h < 18) continue;
    const container = kindOf(b.id) === 'container';
    const on = marked.has(b.id);
    const size = on ? 11 : 10;
    const abbr = b.type ? getTypeAbbr(b.type) : '';
    g.font = `600 ${size}px ${FONT}`;
    const aw = abbr ? g.measureText(abbr).width + 5 : 0;
    g.font = `${on ? 600 : 400} ${size}px ${FONT}`;
    const name = clip(g, container && !/container/i.test(b.name) ? `Container ${b.name}` : b.name, Math.min(container ? 200 : 280, b.w - 28 - aw)) || (abbr ? '' : b.name.slice(0, 1));
    const nw = g.measureText(name).width;
    const x = container ? b.x + b.w - 10 - aw - nw : b.x + 9, y = b.y - (on ? 7 : 6);
    const spot = { x: x - 4, y, w: aw + nw + 8, h: on ? 15 : 12 };
    if (container && labelled.some(o => spot.x < o.x + o.w && spot.x + spot.w > o.x && spot.y < o.y + o.h && spot.y + spot.h > o.y)) continue;
    labelled.push(spot);
    g.fillStyle = '#ffffff';
    g.beginPath(); g.roundRect(spot.x, spot.y, spot.w, spot.h, 3); g.fill();
    if (on) { g.strokeStyle = VIOLET; g.lineWidth = 1; g.stroke(); }
    if (abbr) { g.fillStyle = getTypeColor(b.type); g.font = `600 ${size}px ${FONT}`; g.fillText(abbr, x, y + (on ? 2 : 1)); }
    g.fillStyle = on ? '#24282e' : '#7b828d'; g.font = `${on ? 600 : 400} ${size}px ${FONT}`;
    g.fillText(name, x + aw, y + (on ? 2 : 1));
  }
  // The tabs: every name, the shown one in the brand colour and underlined.
  for (const p of pills) {
    const on = p.id === scene.liveTabId;
    g.font = `${on ? 600 : 500} 12px ${FONT}`;
    g.fillStyle = on ? '#6d28d9' : '#5b6675';
    g.textBaseline = 'middle';
    g.fillText(clip(g, p.name, Math.max(30, p.w - 8)), p.x + 4, p.y + p.h / 2);
    g.textBaseline = 'top';
    if (on) { g.fillStyle = VIOLET; g.fillRect(p.x, p.y + p.h - 2, p.w, 2); }
  }
  if (pt.ink) {
    const k = pt.ink.el.width / Math.max(1, document.documentElement.clientWidth || w);
    g.drawImage(pt.ink.el, 0, top * k, pt.ink.el.width, (h - top) * k, 0, top, pt.ink.el.width / k, h - top);
  }
  // A badge outside its box has a short line to it.
  g.strokeStyle = VIOLET; g.lineWidth = 1.5;
  for (const b of badges) {
    if (!b.leader) continue;
    g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.leader.x, b.leader.y); g.stroke();
    g.fillStyle = VIOLET; g.beginPath(); g.arc(b.leader.x, b.leader.y, 2.5, 0, Math.PI * 2); g.fill();
  }
  for (const b of badges) {
    g.fillStyle = VIOLET; g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(b.x, b.y, BADGE_R, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.font = `700 11px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(b.label, b.x, b.y + 0.5);
    g.textAlign = 'left'; g.textBaseline = 'top';
  }
  g.restore();
  g.fillStyle = '#e9ecf0'; g.fillRect(0, canvas.height - FOOT, w, 1);
  g.fillStyle = '#8b93a0'; g.font = `11px ${FONT}`;
  g.fillText('Drawn by Configuration Companion from the page, not a screenshot. Values may be cut short.', 10, canvas.height - FOOT + 5);
  lastDraw.ms = Math.round(performance.now() - t0); lastDraw.items = items.length; lastDraw.cut = budget.cut;
  return new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
}

/** The first row of the ink canvas that has ink on it, in window pixels (Infinity when it is empty). */
function inkTopOf(c: HTMLCanvasElement): number {
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height) return Infinity;
  try {
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const k = c.width / Math.max(1, document.documentElement.clientWidth || window.innerWidth);
    for (let y = 0; y < c.height; y += 2) {
      const row = y * c.width * 4;
      for (let x = 3; x < c.width * 4; x += 16) if (data[row + x] > 0) return y / k;
    }
  } catch { /* a tainted or lost canvas: start at the top */ }
  return Infinity;
}
