/**
 * The page as the AI sees it: a tree of refs, types, names, columns and rows. Reads no code and carries
 * no rid and no ID (the IDs of the marked objects go in the copy's "objects"). The signature is what a pasted answer is compared with to see whether the
 * page changed after the copy.
 */
import type { LModel, LNode } from '../layout/types';
import { computeRows } from '../layout/rows';
import { descendantVisibleWidgets } from '../layout/model';
import { isDraftId } from './drafts';
import type { RefTable } from './refs';

export interface OutlineNode {
  ref: string;
  type: string;
  name: string;
  columns?: number;
  row?: number;
  /** A tab BMP does not show (empty, or only hidden widgets). */
  hidden?: true;
  /** A tab the user drew: Companion adds it, the answer must not. */
  new?: true;
  children?: OutlineNode[];
}

export function buildOutline(model: LModel, refs: RefTable): OutlineNode[] {
  const nodeOf = (n: LNode, row?: number): OutlineNode => {
    const e = refs.byId.get(n.id);
    const out: OutlineNode = { ref: e?.ref ?? '?', type: n.className, name: n.name };
    if (n.kind !== 'tab') out.columns = n.cols.L === 0 ? 6 : n.cols.L;
    if (row !== undefined) out.row = row;
    if (isDraftId(n.id)) out.new = true;
    else if (n.kind === 'tab' && !descendantVisibleWidgets(n).length) out.hidden = true;
    if (n.children.length) {
      const rowOf = new Map<string, number>();
      computeRows(n.children).forEach((r, i) => r.items.forEach(it => rowOf.set(it.id, i + 1)));
      out.children = n.children.map(c => nodeOf(c, rowOf.get(c.id)));
    }
    return out;
  };
  return model.tabs.map(t => nodeOf(t));
}

/** FNV-1a, 32 bit, hex. Not a security hash: a cheap "did this change" key. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** What the signature sees of one node: identity, shape, order, and the style an answer may change. */
function project(n: LNode): unknown {
  const s = n.style;
  return [n.id, n.kind, n.className, n.name, n.cols.L, n.cols.M ?? null, n.cols.S ?? null, n.height ?? null,
    s ? [s.headerColorBid ?? '', s.fontColorBid ?? '', s.shadow ?? false, s.headerStyle ?? '', s.borderStyle ?? '', s.transparency ?? 0,
      s.showToolMenu ?? null, s.disableSearch ?? null, s.visibility ?? '', s.shownOnLargeDisplay ?? null, s.shownOnMediumDisplay ?? null, s.shownOnSmallDisplay ?? null] : null,
    n.children.map(project)];
}

/** One key for the page's layout. Equal across a re-read of the same page, different after any rename,
 *  resize, move, add, delete or style change an answer could touch. */
export function pageSignature(model: LModel): string {
  return fnv(JSON.stringify(model.tabs.map(project)));
}
