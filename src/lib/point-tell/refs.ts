/**
 * Refs: the short names an AI answer uses for the page's objects. Assigned when notes are copied, in
 * outline order: t1... tabs, c1... containers, o1... widgets. They live inside one copied payload and
 * its snapshot; the page resolves them back to object ids (business IDs), never to a rid in the text.
 */
import type { LModel, LNode } from '../layout/types';
import { findNode } from '../layout/model';
import { isDraftId } from './drafts';
import type { PtRefEntry } from './types';

export interface RefTable {
  entries: PtRefEntry[];
  byRef: Map<string, PtRefEntry>;
  byId: Map<string, PtRefEntry>;
}

const PREFIX = { tab: 't', container: 'c', widget: 'o' } as const;

export function assignRefs(model: LModel): RefTable {
  const entries: PtRefEntry[] = [];
  const count = { tab: 0, container: 0, widget: 0, draft: 0 };
  const visit = (n: LNode): void => {
    // A tab the user drew has a name of its own kind (n1, n2 ...), the "as" namespace.
    const ref = isDraftId(n.id) ? `n${++count.draft}` : `${PREFIX[n.kind]}${++count[n.kind]}`;
    entries.push({ ref, id: n.id, ...(n.rid ? { rid: n.rid } : {}), kind: n.kind, className: n.className, name: n.name });
    n.children.forEach(visit);
  };
  model.tabs.forEach(visit);
  return tableOf(entries);
}

/** A table over entries kept in a snapshot. */
export function tableOf(entries: PtRefEntry[]): RefTable {
  return { entries, byRef: new Map(entries.map(e => [e.ref, e])), byId: new Map(entries.map(e => [e.id, e])) };
}

/** Normalise how an answer may write a ref ("O3", " o3 ") to the table's spelling. */
export function normRef(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** The node a ref stands for in `model`: found by object id first (the BMP business ID), by rid second
 *  (an id can change when BMP assigns a real one to a staged add). Null: no longer on the page. */
export function resolveRef(model: LModel, table: RefTable, ref: unknown): { entry: PtRefEntry; node: LNode } | null {
  const entry = table.byRef.get(normRef(ref));
  if (!entry) return null;
  const byId = findNode(model, entry.id)?.node;
  if (byId) return { entry, node: byId };
  if (entry.rid) {
    let hit: LNode | null = null;
    const walk = (n: LNode): void => { if (!hit && n.rid === entry.rid) hit = n; n.children.forEach(walk); };
    model.tabs.forEach(walk);
    if (hit) return { entry, node: hit };
  }
  return null;
}
