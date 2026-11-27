/**
 * Browse's "Locate on page", the pure parts: what the panel asks the page
 * for, and what it says about the answer. No DOM, no messaging.
 *
 * The panel knows the page's structure (the Here tree). An object inside a
 * page tab has that tab among its ancestors (type `Tab`; its rid is the
 * tab's `tabrid` on the page). So the request carries the object, the
 * ancestors that can stand in for it while they are inside the same tab
 * (an input has no element of its own; its input set has), and the tabs on
 * its path, outermost first. The page layer (content-locate.ts) switches to
 * those tabs when the object is not shown, waits for it, and rings it.
 */
import type { BrowseNode } from './browse-tree';

/** A page tab on the object's path: its rid (the page's `tabrid`) and name. */
export interface LocateTab { rid: string; name: string }

/** Why nothing was ringed: the object's tab could not be opened
 *  ('other-tab'), it is not shown as the page is now ('not-shown'), the
 *  BMP page is not the visible tab ('page-behind'), or there is no BMP page
 *  to ask ('no-page'). */
export type LocateWhy = 'not-shown' | 'other-tab' | 'page-behind' | 'no-page';

/** What the page answers. `tab`: the name of the page tab that holds the
 *  object, when known; `switched`: the page was switched to it. */
export interface LocateAnswer {
  found: string | null;
  tab?: string;
  switched?: boolean;
  why?: LocateWhy;
}

export const TAB_TYPE = 'Tab';
/** At most this many tabs on one path (nested tab strips). */
export const MAX_LOCATE_TABS = 4;

/** The request for `rid` from the tree `nodes` (null: not loaded). Without
 *  a tab on the path the whole ancestor chain may stand in, as before. */
export function locateRequest(nodes: readonly BrowseNode[] | null | undefined, rid: string): { rids: string[]; tabs: LocateTab[] } {
  const byRid = new Map((nodes ?? []).map(n => [n.rid, n]));
  const self = byRid.get(rid);
  if (!self) return { rids: [rid], tabs: [] };
  const chain: string[] = [];
  const inside: string[] = [];
  const tabs: LocateTab[] = [];
  let cur = self.parent ? byRid.get(self.parent) : undefined;
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.push(cur.rid);
    if (cur.type === TAB_TYPE) tabs.push({ rid: cur.rid, name: cur.name || cur.businessId || '' });
    else if (!tabs.length) inside.push(cur.rid);
    cur = cur.parent ? byRid.get(cur.parent) : undefined;
  }
  tabs.reverse();
  // A tab itself is found by its own button: nothing stands in for it.
  if (self.type === TAB_TYPE) return { rids: [rid], tabs: tabs.slice(-MAX_LOCATE_TABS) };
  if (!tabs.length) return { rids: [rid, ...chain], tabs: [] };
  return { rids: [rid, ...inside], tabs: tabs.slice(-MAX_LOCATE_TABS) };
}

/** What the panel says. `status`: a short flash in the status bar (the ring
 *  on the page shows the rest); `row`: a note at the row, because nothing on
 *  the page changed. `holderName` names the object that stood in. */
export function locateLine(rid: string, a: LocateAnswer, holderName?: string): { where: 'status' | 'row'; text: string } {
  if (a.found) {
    const on = a.switched && a.tab ? ` on the tab ${a.tab}` : ' on the page';
    if (a.found === rid) return { where: 'status', text: `Located${on}` };
    return { where: 'status', text: `Located its widget${holderName ? `, ${holderName}` : ''}${a.switched && a.tab ? `, on the tab ${a.tab}` : ''}` };
  }
  switch (a.why) {
    case 'page-behind': return { where: 'row', text: 'The BMP page is not in front. Bring its tab to the front, then try again.' };
    case 'no-page': return { where: 'row', text: 'No BMP page is open in front in this window.' };
    default: break;
  }
  // Not shown although its tab is open (the page switched to it, or it was open already).
  if (a.tab && a.why !== 'other-tab' && (a.switched || a.why === 'not-shown')) return { where: 'row', text: `Not shown on the tab ${a.tab} as it is now.` };
  if (a.tab) return { where: 'row', text: `On the tab ${a.tab}. Open that tab to see it.` };
  return { where: 'row', text: 'Not shown on this page as it is now.' };
}

/** A worker-side check of tabs sent by the panel: rid-shaped, named, at most MAX_LOCATE_TABS. */
export function cleanLocateTabs(raw: unknown, isRid: (r: string) => boolean): LocateTab[] {
  if (!Array.isArray(raw)) return [];
  const out: LocateTab[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const { rid, name } = t as { rid?: unknown; name?: unknown };
    if (typeof rid !== 'string' || !isRid(rid)) continue;
    out.push({ rid, name: typeof name === 'string' ? name.trim().slice(0, 200) : '' });
  }
  return out.slice(-MAX_LOCATE_TABS);
}

/** What `layoutTabs` needs of an object read. */
export interface LayoutObject {
  type: string;
  name: string;
  props?: Record<string, { text?: string } | undefined>;
  references?: Record<string, readonly string[] | undefined>;
}

/** How many of the request's rids are read for their place on the page. */
const LAYOUT_RIDS = 6;
/** The layout parts between a widget and its tab set's category, and how many are walked. */
const LAYOUT_TYPES = new Set(['Container', TAB_TYPE, 'TabSet']);
const LAYOUT_STEPS = 8;

/**
 * The page tabs that hold `rids` by the page's layout, outermost first. A
 * widget of an enterprise template sits in a layout container (its
 * `container` reference); the container lies under a tab of a tab set
 * (Layout > tab set > tab > container, and deeper for nested tab sets). The
 * Browse tree shows the template, not that layout, so its path names no tab.
 * Read: the first rid alone, the others only when it has no container (the
 * first with a container wins), then the container and
 * its parents one by one up to the layout's category (a batch with the
 * customer root in it fails on BMP 5.6, so the path is walked, not read at
 * once). Empty when none is known.
 */
export async function layoutTabs(read: (rids: string[]) => Promise<Record<string, LayoutObject | null | undefined>>, rids: readonly string[]): Promise<LocateTab[]> {
  const first = rids.slice(0, LAYOUT_RIDS);
  if (!first.length) return [];
  const containerOf = (objs: Record<string, LayoutObject | null | undefined>, list: readonly string[]) =>
    list.map(r => objs[r]?.references?.container?.[0]).find((c): c is string => typeof c === 'string' && c.length > 0);
  // The widget alone first: usually it names its container, and a batch
  // with a root-type ancestor in it can be refused.
  let cur = containerOf(await read([first[0]]), [first[0]]);
  const rest = first.slice(1);
  if (!cur && rest.length) cur = containerOf(await read(rest), rest);
  const tabs: LocateTab[] = [];
  for (let step = 0; cur && step < LAYOUT_STEPS; step++) {
    const o = (await read([cur]))[cur];
    if (!o || !LAYOUT_TYPES.has(o.type)) break;
    if (o.type === TAB_TYPE) tabs.unshift({ rid: cur, name: o.name ?? '' });
    cur = o.references?.parent?.[0];
  }
  return tabs.slice(-MAX_LOCATE_TABS);
}

/** A content answer as the worker passes it on: only known fields. */
export function cleanLocateAnswer(raw: unknown): LocateAnswer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const why = r.why === 'not-shown' || r.why === 'other-tab' || r.why === 'page-behind' || r.why === 'no-page' ? r.why : undefined;
  return {
    found: typeof r.found === 'string' ? r.found : null,
    ...(typeof r.tab === 'string' && r.tab ? { tab: r.tab.slice(0, 200) } : {}),
    ...(r.switched === true ? { switched: true } : {}),
    ...(why ? { why } : {}),
  };
}
