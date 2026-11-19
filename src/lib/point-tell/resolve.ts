/**
 * Point and tell: from a point or a rectangle on the page to a place in the layout model. Pure
 * functions over a scene (the model plus the rectangles the page measured), used by the drawing layers:
 * an arrow's end (`resolveArrow`), a box (`resolveBox`), the place of freehand ink (`inkPlace`).
 *
 * A place is "before X", "after X" or "into X" (a tab or container), with the tab, container, grid row
 * and first column it lands in. The rules are Blueprint's: the nearest edge of the object under the
 * point decides before or after; containers always come before widgets in a parent, so a place that
 * BMP cannot render is refused with the reason (or, for an add, moved to the nearest legal place).
 * Coordinates are page (document) coordinates.
 */
import type { LModel, LNode, NodeKind } from '../layout/types';
import { eachInSubtree, findNode, findTabOf } from '../layout/model';
import { computeRows } from '../layout/rows';
import { contains, hitTest, intersection, area, bottom, centre, nearestEdge, right, targetsInBox, unionOf, type PtTarget, type Rect } from './hit';
import type { PtGridPlace, PtMeaning, PtPlace, PtPoint } from './types';

export interface PtScene {
  model: LModel;
  /** The tab BMP shows (a model tab id), or null when it cannot be told. */
  liveTabId: string | null;
  /** Widgets and containers that have a place on the page right now. */
  targets: PtTarget[];
  /** The tab pills of the page's tab strip, as targets of kind 'tab'. */
  pills: PtTarget[];
  /** The tab strip's row: where a new tab may be drawn. */
  tabRow?: { rect: Rect };
  /** The breadcrumb row and the last crumb: where a new page may be drawn. */
  crumbRow?: { rect: Rect; lastId: string; /** The name of the page's parent crumb (the one before the last). */ parent?: string };
  /** The scene of the paper page of a drawn page (its tab row is its own). */
  paperPage?: true;
  /** A drawn tab (or page) is shown as paper over the content: its draft id and area. */
  paper?: { tabId: string; rect: Rect };
}

/** What is being placed: an existing object (a move), or a new one of a kind. */
export interface Mover { id?: string; kind: NodeKind }

export interface Placed {
  place: PtPlace;
  /** The place in plain words: `before "Export"`, `into tab "Details"`. */
  words: string;
  tabId: string;
  containerId?: string;
  /** Grid row (1-based) of the object the place is next to. */
  row: number;
  /** First column (1..6) under the point. */
  col: number;
  /** The place was not legal and was moved to the nearest one that is (only in 'nearest' mode). */
  remapped?: boolean;
  /** The place is where the object already is. */
  unchanged?: boolean;
}
export type PlaceResult = (Placed & { ok: true; alternatives: Array<{ place: PtPlace; words: string }> }) | { ok: false; reason: string };

const SLOP = 12;
const NOT_A_PLACE = 'Not a place on this page.';
export const BAND_WIDGET = 'BMP shows widgets after all containers, and this place is between containers';
export const BAND_CONTAINER = 'BMP shows containers before widgets. Place it beside a container instead';

const label = (n: LNode | undefined, fallback: string): string => (n ? (n.kind === 'tab' ? `tab "${n.name}"` : `"${n.name}"`) : fallback);

/** A place as a short phrase, with the object named. */
export function placeWords(model: LModel, place: PtPlace): string {
  if ('before' in place) return `before ${label(findNode(model, place.before)?.node, place.before)}`;
  if ('after' in place) return `after ${label(findNode(model, place.after)?.node, place.after)}`;
  return `into ${label(findNode(model, place.into)?.node, place.into)}`;
}

const rectMap = (targets: readonly PtTarget[]): Map<string, Rect> => new Map(targets.map(t => [t.id, t.rect]));

/** Where an object's children are laid out: a container's rectangle, or the union of a tab's children. */
function areaOf(parent: LNode, rects: Map<string, Rect>, scene: PtScene): Rect | null {
  if (parent.kind === 'container') return rects.get(parent.id) ?? null;
  return unionOf(parent.children.flatMap(c => rects.get(c.id) ?? [])) ?? contentBounds(scene);
}

/** Everything the page shows of the layout: the union of all targets. */
export function contentBounds(scene: PtScene): Rect | null { return scene.paper?.rect ?? unionOf(scene.targets.map(t => t.rect)); }

/** The first column (1..6) under x within an area. */
function columnAt(rect: Rect | null, x: number): number {
  if (!rect || rect.width <= 0) return 1;
  return Math.max(1, Math.min(6, Math.floor(((x - rect.left) / rect.width) * 6) + 1));
}

/** Index a place takes among the children of `parent` once `mover` is out of the way. */
export function slotIndex(kids: LNode[], place: PtPlace, kind: NodeKind): number {
  const boundary = kids.filter(k => k.kind === 'container').length;
  if ('into' in place) return kind === 'container' ? boundary : kids.length;
  const at = kids.findIndex(k => k.id === ('before' in place ? place.before : place.after));
  return 'before' in place ? at : at + 1;
}

/** Containers come before widgets in a parent. */
export function legal(kids: LNode[], index: number, kind: NodeKind): boolean {
  const boundary = kids.filter(k => k.kind === 'container').length;
  return kind === 'container' ? index <= boundary : index >= boundary;
}

/** The nearest place BMP can render: a container after the last container, a widget before the first widget. */
export function nearestLegal(parent: LNode, kids: LNode[], kind: NodeKind): PtPlace {
  const boundary = kids.filter(k => k.kind === 'container').length;
  if (kind === 'container') return boundary > 0 ? { after: kids[boundary - 1].id } : { into: parent.id };
  return boundary < kids.length ? { before: kids[boundary].id } : { into: parent.id };
}

interface Ctx { scene: PtScene; rects: Map<string, Rect>; excluded: Set<string>; mover: Mover; mode: 'strict' | 'nearest' }

function finish(c: Ctx, parent: LNode, place: PtPlace, rowOfAnchor: number, x: number, alternatives: PtPlace[]): PlaceResult {
  const model = c.scene.model;
  const kids = parent.children.filter(k => !c.excluded.has(k.id));
  const kind = c.mover.kind;
  let chosen = place, remapped = false;
  if (!legal(kids, slotIndex(kids, place, kind), kind)) {
    if (c.mode === 'strict') return { ok: false, reason: kind === 'container' ? BAND_CONTAINER : BAND_WIDGET };
    chosen = nearestLegal(parent, kids, kind); remapped = true;
  }
  const tabId = parent.kind === 'tab' ? parent.id : findTabOf(model, parent.id)?.id ?? parent.id;
  const idx = slotIndex(kids, chosen, kind);
  const mover = c.mover.id ? findNode(model, c.mover.id) : null;
  const unchanged = !!mover && (mover.parent?.id ?? null) === parent.id && mover.index === idx;
  return {
    ok: true,
    place: chosen,
    words: placeWords(model, chosen),
    tabId,
    ...(parent.kind === 'container' ? { containerId: parent.id } : {}),
    row: rowOfAnchor,
    col: columnAt(areaOf(parent, c.rects, c.scene), x),
    ...(remapped ? { remapped } : {}),
    ...(unchanged ? { unchanged } : {}),
    alternatives: alternatives
      .filter(p => legal(kids, slotIndex(kids, p, kind), kind))
      .map(p => ({ place: p, words: placeWords(model, p) })),
  };
}

/** A point inside a parent's own area but not over one of its children: row by row, then the nearest
 *  object in that row decides before or after; past the last row it is "into" (the end). */
function inParent(c: Ctx, parent: LNode, x: number, y: number): PlaceResult {
  const kids = parent.children.filter(k => !c.excluded.has(k.id));
  const rows = computeRows(kids).map(r => r.items.filter(i => c.rects.has(i.id))).filter(r => r.length);
  if (!rows.length) return finish(c, parent, { into: parent.id }, 1, x, []);
  const span = rows.map(items => {
    const u = unionOf(items.map(i => c.rects.get(i.id)!))!;
    return { items, top: u.top, bottom: bottom(u) };
  });
  const last = span[span.length - 1];
  if (y > last.bottom + SLOP) return finish(c, parent, { into: parent.id }, span.length + 1, x, []);
  let r = 0;
  for (let i = 0; i < span.length; i++) {
    const lower = i === span.length - 1 ? Infinity : (span[i].bottom + span[i + 1].top) / 2;
    if (y <= lower) { r = i; break; }
  }
  const items = [...span[r].items].sort((a, b) => c.rects.get(a.id)!.left - c.rects.get(b.id)!.left);
  const next = items.find(i => right(c.rects.get(i.id)!) >= x) ?? null;
  if (!next) {
    const tail = items[items.length - 1];
    return finish(c, parent, { after: tail.id }, r + 1, x, [{ into: parent.id }]);
  }
  const rect = c.rects.get(next.id)!;
  const before = x < centre(rect)[0];
  return finish(c, parent, before ? { before: next.id } : { after: next.id }, r + 1, x, [before ? { after: next.id } : { before: next.id }]);
}

/** The place a point means for `mover`. 'strict' refuses a place BMP cannot render (with the reason);
 *  'nearest' moves it to the nearest legal one and says so. */
export function resolvePlace(scene: PtScene, x: number, y: number, mover: Mover, mode: 'strict' | 'nearest' = 'strict'): PlaceResult {
  const model = scene.model;
  const rects = rectMap(scene.targets);
  const moverNode = mover.id ? findNode(model, mover.id)?.node : undefined;
  const excluded = new Set<string>();
  if (moverNode) eachInSubtree(moverNode, n => excluded.add(n.id));
  const c: Ctx = { scene, rects, excluded, mover, mode };

  const pill = hitTest(scene.pills, x, y);
  if (pill) {
    if (mover.kind === 'tab') {
      if (excluded.has(pill.id)) return { ok: false, reason: 'That is the tab itself.' };
      const before = nearestEdge(pill.rect, x, y).before;
      const place: PtPlace = before ? { before: pill.id } : { after: pill.id };
      return { ok: true, place, words: placeWords(model, place), tabId: pill.id, row: 1, col: 1, alternatives: [] };
    }
    if (excluded.has(pill.id)) return { ok: false, reason: NOT_A_PLACE };
    const place: PtPlace = { into: pill.id };
    return { ok: true, place, words: placeWords(model, place), tabId: pill.id, row: 1, col: columnAt(contentBounds(scene), x), alternatives: [] };
  }
  if (mover.kind === 'tab') return { ok: false, reason: 'A tab is placed beside another tab.' };

  const over = hitTest(scene.targets, x, y);
  if (over && excluded.has(over.id)) return { ok: false, reason: 'That is the object itself.' };
  const hit = hitTest(scene.targets.filter(t => !excluded.has(t.id)), x, y);

  if (hit?.kind === 'widget') {
    const f = findNode(model, hit.id);
    if (!f?.parent) return { ok: false, reason: NOT_A_PLACE };
    const parent = f.parent;
    // The members of a button group, an input set and the like are placed in Blueprint, not from a sketch.
    if (parent.kind === 'widget' && (!moverNode || findNode(model, moverNode.id)?.parent?.id !== parent.id)) {
      return { ok: false, reason: `"${parent.name}" holds its own members; place them in Blueprint` };
    }
    const before = nearestEdge(hit.rect, x, y).before;
    const rowOf = computeRows(parent.children.filter(k => !excluded.has(k.id))).findIndex(r => r.items.some(i => i.id === hit.id)) + 1;
    return finish(c, parent, before ? { before: hit.id } : { after: hit.id }, Math.max(1, rowOf), x,
      [before ? { after: hit.id } : { before: hit.id }, { into: parent.id }]);
  }
  if (hit?.kind === 'container') {
    const node = findNode(model, hit.id)?.node;
    return node ? inParent(c, node, x, y) : { ok: false, reason: NOT_A_PLACE };
  }
  // Nothing under the point: the live tab, when the point is on the page's content.
  const bounds = contentBounds(scene);
  const live = scene.liveTabId ? findNode(model, scene.liveTabId)?.node : undefined;
  if (!bounds || !live || !contains({ left: bounds.left - 16, top: bounds.top - SLOP, width: bounds.width + 32, height: bounds.height + 48 }, x, y)) {
    return { ok: false, reason: NOT_A_PLACE };
  }
  return inParent(c, live, x, y);
}

// ── Arrow ───────────────────────────────────────────────────────────────────────────────────────

export type ArrowResult =
  | { ok: true; meaning: Extract<PtMeaning, { kind: 'move' }>; grid: PtGridPlace; alternatives: Array<{ place: PtPlace; words: string }> }
  | { ok: false; reason: string };

/** An arrow from an object to a point: move that object there. */
export function resolveArrow(scene: PtScene, fromId: string, x: number, y: number): ArrowResult {
  const node = findNode(scene.model, fromId)?.node;
  if (!node) return { ok: false, reason: 'That object is not in the page layout.' };
  const r = resolvePlace(scene, x, y, { id: fromId, kind: node.kind }, 'strict');
  if (!r.ok) return r;
  if (r.unchanged) return { ok: false, reason: 'It is already there.' };
  return {
    ok: true,
    meaning: { kind: 'move', to: r.place, words: `Move "${node.name}" ${r.words}` },
    grid: { tabId: r.tabId, ...(r.containerId ? { containerId: r.containerId } : {}), row: r.row, col: r.col },
    alternatives: r.alternatives,
  };
}

// ── Box ─────────────────────────────────────────────────────────────────────────────────────────

export type BoxResult =
  | { ok: true; kind: 'objects'; ids: string[]; grid: PtGridPlace }
  | { ok: true; kind: 'place'; meaning: Extract<PtMeaning, { kind: 'add' }>; grid: PtGridPlace }
  | { ok: false; reason: string };

/** Drop objects whose ancestor is in the set too: a box over a container means the container. */
function outermost(model: LModel, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter(id => {
    for (let p = findNode(model, id)?.parent; p; p = findNode(model, p.id)?.parent ?? null) if (set.has(p.id)) return false;
    return true;
  });
}

/** The objects a rectangle covers: those whose centre is inside it (outermost only); else the widget it
 *  lies mostly within (a box drawn on a table's body); else none. */
export function objectsIn(scene: PtScene, box: Rect): string[] {
  const pills = targetsInBox(scene.pills, box).map(t => t.id);
  const inside = outermost(scene.model, targetsInBox(scene.targets, box).map(t => t.id));
  if (inside.length || pills.length) return [...pills, ...inside];
  const boxArea = area(box);
  let best: PtTarget | null = null;
  for (const t of scene.targets) {
    if (t.kind !== 'widget' || boxArea <= 0 || intersection(t.rect, box) / boxArea < 0.5) continue;
    if (!best || area(t.rect) <= area(best.rect)) best = t;
  }
  return best ? [best.id] : [];
}

export function gridOfBox(scene: PtScene, box: Rect, placed: Placed | null, over: string[]): PtGridPlace {
  const rects = rectMap(scene.targets);
  const parentRect = placed?.containerId ? rects.get(placed.containerId) ?? null : contentBounds(scene);
  const cols = parentRect && parentRect.width > 0 ? Math.max(1, Math.min(6, Math.round((box.width / parentRect.width) * 6))) : undefined;
  return {
    ...(placed ? { tabId: placed.tabId, ...(placed.containerId ? { containerId: placed.containerId } : {}), row: placed.row, col: placed.col } : scene.liveTabId ? { tabId: scene.liveTabId } : {}),
    ...(cols ? { cols } : {}),
    ...(over.length ? { over } : {}),
  };
}

/** A box on the page: the objects inside it, or, over empty space, an "add here" place with a width. */
export function resolveBox(scene: PtScene, box: Rect): BoxResult {
  if (box.width < 4 || box.height < 4) return { ok: false, reason: NOT_A_PLACE };
  const ids = objectsIn(scene, box);
  if (ids.length) return { ok: true, kind: 'objects', ids, grid: gridOfBox(scene, box, null, ids) };
  const [cx, cy] = centre(box);
  const r = resolvePlace(scene, box.left + 2, cy, { kind: 'widget' }, 'nearest');
  if (!r.ok) {
    const alt = resolvePlace(scene, cx, cy, { kind: 'widget' }, 'nearest');
    if (!alt.ok) {
      // A box drawn on the empty page below the last row: it goes at the end of the tab.
      const bounds = contentBounds(scene);
      if (bounds && cx >= bounds.left - 16 && cx <= right(bounds) + 16) {
        const end = resolvePlace(scene, box.left + 2, bottom(bounds) + 30, { kind: 'widget' }, 'nearest');
        if (end.ok) return boxPlace(scene, box, end);
      }
      return alt;
    }
    return boxPlace(scene, box, alt);
  }
  return boxPlace(scene, box, r);
}

function boxPlace(scene: PtScene, box: Rect, r: Placed): BoxResult {
  const grid = gridOfBox(scene, box, r, []);
  return {
    ok: true,
    kind: 'place',
    meaning: { kind: 'add', place: r.place, ...(grid.cols ? { columns: grid.cols } : {}), words: `${r.words}${grid.cols ? `, about ${grid.cols} column${grid.cols === 1 ? '' : 's'} wide` : ''}` },
    grid,
  };
}

// ── Ink ─────────────────────────────────────────────────────────────────────────────────────────

export function inkBounds(strokes: ReadonlyArray<{ points: PtPoint[] }>): Rect | null {
  const pts = strokes.flatMap(s => s.points);
  if (!pts.length) return null;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const l = Math.min(...xs), t = Math.min(...ys);
  return { left: l, top: t, width: Math.max(...xs) - l, height: Math.max(...ys) - t };
}

/** Where freehand ink sits in page-grid terms: the tab, container, row, first column and width, and the
 *  objects it covers. The drawing layer stores this beside the raw strokes. */
export function inkPlace(scene: PtScene, strokes: ReadonlyArray<{ points: PtPoint[] }>): PtGridPlace {
  const box = inkBounds(strokes);
  if (!box) return {};
  const over = objectsIn(scene, box);
  const [cx, cy] = centre(box);
  const r = resolvePlace(scene, cx, cy, { kind: 'widget' }, 'nearest');
  return gridOfBox(scene, box, r.ok ? r : null, over);
}
