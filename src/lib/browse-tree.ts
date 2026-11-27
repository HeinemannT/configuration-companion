/**
 * Browse tab data (service-worker side, pure): the structure of the page the
 * user is on, flattened for the side panel, plus the two small read-only
 * Extended Code calls Browse needs (the page's ancestors for the location
 * crumb, and an exact ID lookup).
 *
 * The structure itself comes from the object window's machinery
 * (object-window.ts → openObjectRoot); this module only turns those payloads
 * into light rows. No chrome.*, no I/O.
 */

import type { ObjectRootPayload } from './object-window';
import { assembleStructure, attachTree, type StructureTree } from './object-structure';
import { appendRowEc, EC_DONE_LITERAL, parseFramedLog, STATIC_EC_FRAME, type EcFrame } from './ec-parser';
import { ecString } from './ec-guards';
import { scriptOn } from './script-kinds';
import { ID_SPACES, isValidNamespace } from './namespace';
import { isDataObject, typeInfo } from './object-window-table';
import { isRidShaped } from './rid-shape';

/** One row of the page tree. `group` 1 holds the presenting template of a
 *  data object ("Presented by"). */
export interface BrowseNode {
  rid: string;
  parent: string | null;
  depth: number;
  group: 0 | 1;
  type: string;
  name: string;
  businessId: string;
  kids: number;
}

export interface BrowseCrumb {
  rid: string;
  type: string;
  name: string;
}

export interface BrowseTree {
  rootRid: string;
  /** Pre-order; group 0 first, then group 1. */
  nodes: BrowseNode[];
  /** Ancestors of the root, outermost first (the root itself is not here). */
  crumbs: BrowseCrumb[];
  /** Presenting template of a data object: null when the root is not a
   *  data object; 'loading' on the first answer, before the template is read
   *  (a second answer then carries it). */
  presented: 'loading' | 'loaded' | 'none' | 'error' | null;
  /** The root's type has no structure rule: its direct children are shown. */
  fallback: boolean;
  structureError?: string;
  /** Set to the cap when the listing was cut; the tree shows the first nodes. */
  structureTruncatedAt?: number;
  /** The root's full property list was unavailable (Extended Code fallback). */
  rootFallback?: string;
  /** Names and markers of some rows could not be read (row-facts-status.ts). */
  rowFactsError?: import('./row-facts-status').RowFactsFailure;
  /** Diagnostics: HTTP posts and wall time of the whole read. */
  posts: number;
  ms: number;
}

export interface ObjectHit {
  rid: string;
  type: string;
  name: string;
  businessId: string;
}

/** Build the rows from the root payload and, for a data object, the payload
 *  of its presenting template. */
/** What the Browse tree of `root` shows besides the object itself: the
 *  presenting template of a data object (`presented` 'none' says no template
 *  presents it), and the direct children when the type has no structure rule
 *  and there is no template to show. `selected` says the object names a
 *  template selector (`templateExpression`): BMP may then present it with
 *  another template than `template`, and only template-link.ts's rule says
 *  which, so the caller asks the server and passes the answer to `withTemplate`. */
export function browsePlan(root: ObjectRootPayload): { presented: 'none' | null; templateRid: string | null; children: boolean; selected: boolean } {
  let templateRid: string | null = null;
  let presented: 'none' | null = null;
  let selected = false;
  if (isDataObject(root.root)) {
    presented = 'none';
    const tpl = root.root.references.template?.[0];
    if (tpl && isRidShaped(tpl)) templateRid = tpl;
    selected = !!root.root.references.templateExpression?.[0];
  }
  return withTemplate(root, { presented, templateRid, children: false, selected }, templateRid);
}

/** The plan with the template BMP really presents the object with. */
export function withTemplate<P extends { templateRid: string | null; children: boolean }>(root: ObjectRootPayload, plan: P, templateRid: string | null): P {
  const children = !templateRid && !root.rows && !root.structureError && !typeInfo(root.root.type).structure;
  return { ...plan, templateRid, children };
}

export function flattenTree(root: ObjectRootPayload, presented: ObjectRootPayload | null): BrowseNode[] {
  const own = assembleStructure(root.root, root.rows, root.nodes);
  let tree: StructureTree = own;
  if (presented) tree = attachTree(own, assembleStructure(presented.root, presented.rows, presented.nodes));
  const ownRids = new Set(own.order);
  return tree.order.map((rid): BrowseNode => {
    const n = tree.nodes[rid];
    return {
      rid,
      parent: n.parent,
      depth: n.depth,
      group: ownRids.has(rid) ? 0 : 1,
      type: n.obj?.type ?? '',
      name: n.obj?.name ?? '',
      businessId: n.obj?.businessId ?? '',
      kids: n.children.length,
    };
  });
}

/** Types that are containers of a whole workspace area, not places a user
 *  works in; the crumb skips them. */
function isRootType(type: string): boolean {
  return /Root$/.test(type) || type === 'Root';
}

/** Read-only EC printing up to three ancestors of `ref`, nearest first, as
 *  framed `rid, className, name` rows (EcFrame: names keep `|` and line
 *  breaks). */
export function buildAncestorsEc(ref: string, _frame: EcFrame = STATIC_EC_FRAME): string {
  const row = (indent: string) => appendRowEc('_r', ['_p.rid', '_p.className', '_p.name.whenMissing("")'], indent);
  return scriptOn('buildAncestorsEc', ref, [
    `_o := ${ref}`,
    '_r := ""',
    '_p := _o.parent',
    'IF _p != MISSING THEN',
    ...row('  '),
    '  _p := _p.parent',
    '  IF _p != MISSING THEN',
    ...row('    '),
    '    _p := _p.parent',
    '    IF _p != MISSING THEN',
    ...row('      '),
    '    ENDIF',
    '  ENDIF',
    'ENDIF',
    `_r + ${EC_DONE_LITERAL}`,
  ].join('\n'));
}

/** Parse the ancestors log into crumbs, outermost first: at most the two
 *  nearest ancestors that are not workspace roots. Throws when the answer is
 *  incomplete. */
export function parseAncestors(log: string, frame: EcFrame = STATIC_EC_FRAME): BrowseCrumb[] {
  const out: BrowseCrumb[] = [];
  for (const [ridRaw, typeRaw, name] of parseFramedLog(log, frame, 3)) {
    const rid = ridRaw.trim();
    const type = typeRaw.trim();
    if (!/^-?\d+$/.test(rid) || isRootType(type)) continue;
    out.push({ rid, type, name });
    if (out.length === 2) break;
  }
  return out.reverse();
}

/** Characters an ID may contain for the exact-ID lookup. Anything
 *  else is not looked up, so the value never needs escaping in EC. */
const ID_CHARS = /^[A-Za-z0-9_.:-]{1,120}$/;

export function isLookupableId(id: string): boolean {
  return ID_CHARS.test(id);
}

/**
 * The exact-ID lookup in as little varying text as possible (ref-rid): the
 * ID is bound once per script (`prelude`), each ID space is one `get` whose
 * object's RID comes back; the first space (in `exprs` order) that knows the
 * ID wins. The row is then read by a constant script
 * on that object (object-summaries).
 */
export function idLookupPlan(id: string): { prelude: string[]; exprs: string[] } {
  if (!isLookupableId(id)) throw new Error(`Not an ID: ${id}`);
  const prelude = [`_k := ${ecString(id)}`];
  const exprs: string[] = [];
  const dot = id.indexOf('.');
  if (dot > 0) {
    const ns = id.slice(0, dot);
    const rest = id.slice(dot + 1);
    if (isValidNamespace(ns) && rest && ID_SPACES.includes(ns)) { prelude.push(`_s := ${ecString(rest)}`); exprs.push(`${ns}.get(_s)`); }
  }
  for (const ns of ID_SPACES) exprs.push(`${ns}.get(_k)`);
  return { prelude, exprs };
}

