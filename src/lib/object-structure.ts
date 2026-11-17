/**
 * Object window structure — which nodes belong under a root object.
 *
 * There is no binary get-children command, so the listing is one read-only
 * Extended Code call that walks the rule's levels and prints `rid|||parent`
 * rows. The window then reads every listed node in ONE batched object read.
 *
 * Pure helpers (EC text, row parsing, tree assembly); no chrome.*, no I/O.
 */

import { validateEcIdentifier } from './ec-guards';
import { isCodeProperty } from './ec-code-safety';
import { CONTEXT_OBJECT, parsePipeLines } from './ec-parser';
import { scriptOn, varyingScript } from './script-kinds';
import type { FullObject } from './object-read';

export interface StructureRule {
  /** Optional single-reference accessor followed from the root before
   *  listing children (InputView → `inputSet`). The target becomes the root's
   *  only tree child. */
  via?: string;
  /** Child levels listed below the start node. */
  depth: number;
}

export interface StructureRow {
  rid: string;
  parent: string;
}

/** Hard cap on listed nodes. Keeps the batch read and the tree bounded. */
export const STRUCTURE_MAX_NODES = 400;

const MAX_DEPTH = 4;

/** Build the read-only EC that lists a root's structure as `rid|||parent` rows. */
export function buildStructureEc(ref: string, rule: StructureRule): string {
  const depth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(rule.depth)));
  // The script stops adding rows one past the cap (the extra row tells the reader the list was cut):
  // an object can have many thousands of children, and every row added copies the text built so far.
  const lines = [`_o := ${ref}`, '_r := ""', '_n := 0'];
  const cap = STRUCTURE_MAX_NODES + 1;
  const walk = (parentVar: string, level: number, indent: string): string[] => {
    if (level > depth) return [];
    const v = `_c${level}`;
    return [
      `${indent}${parentVar}.children().forEach(${v}:`,
      `${indent}  IF _n < ${cap} THEN`,
      `${indent}    _r := _r + (${v}.rid + "|||" + ${parentVar}.rid + "\\n")`,
      `${indent}    _n := _n + 1`,
      `${indent}  ELSE`,
      `${indent}    _n := _n`,
      `${indent}  ENDIF`,
      ...walk(v, level + 1, `${indent}  `),
      `${indent})`,
    ];
  };
  if (rule.via) {
    // An unset reference (ActionButton without actionObject) lists the root
    // alone instead of failing the listing.
    validateEcIdentifier(rule.via);
    // A reference, never a code property: `_o.expression` would run it.
    if (isCodeProperty(rule.via)) throw new Error(`Not a reference: ${rule.via}`);
    lines.push(`_s := _o.${rule.via}`);
    lines.push('IF _s != MISSING THEN');
    lines.push('  _r := _r + _s.rid + "|||" + _o.rid + "\\n"');
    lines.push(...walk('_s', 1, '  '));
    lines.push('ENDIF');
  } else {
    lines.push(...walk('_o', 1, ''));
  }
  lines.push('_r');
  return scriptOn('buildStructureEc', ref, lines.join('\n'));
}

/** Several listings in one read-only EC call: the blocks share one `_r`
 *  accumulator and print the same `rid|||parent` rows. */
export function buildStructureEcMany(items: ReadonlyArray<{ ref: string; rule: StructureRule }>): string {
  // Items with the same rule share one loop over their objects: the walk is
  // written once per rule, not once per object (the script then changes only
  // in its list lines).
  const groups = new Map<string, { rule: StructureRule; refs: string[] }>();
  for (const { ref, rule } of items) {
    const key = `${rule.via ?? ''}|${Math.max(0, Math.min(MAX_DEPTH, Math.floor(rule.depth)))}`;
    const g = groups.get(key) ?? { rule, refs: [] };
    g.refs.push(ref);
    groups.set(key, g);
  }
  const lines = ['_r := ""'];
  for (const { rule, refs } of groups.values()) {
    // buildStructureEc: `_o := ref`, `_r := ""`, …body…, `_r`.
    const body = buildStructureEc('_o', rule).split('\n').slice(2, -1);
    lines.push(`LIST(${refs.join(', ')}).forEach(_o:`, '  IF _o != MISSING THEN', ...body.map(l => `    ${l}`), '  ENDIF', ')');
  }
  lines.push('_r');
  return varyingScript('buildStructureEcMany', lines.join('\n'));
}

/** What a structure listing needs from the client. */
export interface StructureLister {
  resolveRef(rid: string, signal?: AbortSignal): Promise<string>;
  executeEc(code: string, objectRid?: string, transactional?: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; log?: string; error?: string; hasWarning?: boolean }>;
  /** Constant scripts with the object as the command context (BmpClient). */
  executeEcEach?: import('./object-summaries').ContextEach;
}

/**
 * Several listings, their `rid|||parent` rows in item order. With context
 * commands: one constant script per rule (`this.object` is the root), one
 * command per root, so the server parses each rule's script once. Without:
 * buildStructureEcMany (the loop fallback). Any failed listing fails the
 * call, as one script did.
 */
export async function listStructures(client: StructureLister, items: ReadonlyArray<{ rid: string; rule: StructureRule }>, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; log?: string; error?: string; hasWarning?: boolean }> {
  if (!client.executeEcEach) {
    const refs = await Promise.all(items.map(async it => ({ ref: await client.resolveRef(it.rid, signal), rule: it.rule })));
    return client.executeEc(buildStructureEcMany(refs), undefined, false, signal, timeoutMs);
  }
  const key = (rule: StructureRule) => `${rule.via ?? ''}|${Math.max(0, Math.min(MAX_DEPTH, Math.floor(rule.depth)))}`;
  const groups = new Map<string, { rule: StructureRule; rids: string[] }>();
  for (const it of items) {
    const g = groups.get(key(it.rule)) ?? { rule: it.rule, rids: [] };
    g.rids.push(it.rid);
    groups.set(key(it.rule), g);
  }
  const logs = new Map<string, string>();
  let hasWarning = false;
  for (const g of groups.values()) {
    const answers = await client.executeEcEach(buildStructureEc(CONTEXT_OBJECT, g.rule), g.rids, signal, timeoutMs);
    for (const rid of g.rids) {
      const r = answers.get(rid);
      if (!r?.ok) return { ok: false, error: r?.error || 'Structure listing failed' };
      if ((r as { hasWarning?: boolean }).hasWarning) hasWarning = true;
      logs.set(`${key(g.rule)}#${rid}`, r.log ?? '');
    }
  }
  return { ok: true, ...(hasWarning ? { hasWarning } : {}), log: items.map(it => logs.get(`${key(it.rule)}#${it.rid}`) ?? '').join('\n') };
}

/** Listed rows. `truncated` is true when the listing had more than
 *  STRUCTURE_MAX_NODES nodes and only the first ones are kept. */
export type StructureRows = StructureRow[] & { truncated?: boolean };

/** Parse `rid|||parent` rows; malformed and duplicate rows are dropped. At
 *  most STRUCTURE_MAX_NODES rows are kept; a cut sets `truncated`. */
export function parseStructureRows(log: string): StructureRows {
  const seen = new Set<string>();
  const rows: StructureRows = [];
  for (const [rid, parent] of parsePipeLines(log, 2)) {
    if (!/^-?\d+$/.test(rid) || !/^-?\d+$/.test(parent ?? '')) continue;
    if (seen.has(rid)) continue;
    if (rows.length >= STRUCTURE_MAX_NODES) {
      rows.truncated = true;
      break;
    }
    seen.add(rid);
    rows.push({ rid, parent });
  }
  return rows;
}

export interface StructureNode {
  rid: string;
  parent: string | null;
  depth: number;
  /** null when the batch read did not return this node. */
  obj: FullObject | null;
  children: string[];
  /** Reached through a reference (a button's action object, a followed code
   *  reference), not a child of its parent. */
  referenced?: boolean;
}

/** A listed row that may hang under its parent by reference. */
export interface AttachedRow extends StructureRow {
  referenced?: boolean;
}

export interface StructureTree {
  rootRid: string;
  /** Pre-order list of rids (root first). */
  order: string[];
  nodes: Record<string, StructureNode>;
  /** Top-level rows in order. One entry (the root) unless a second tree is
   *  attached (data object → "Presented by" template). */
  tops: string[];
}

/** Assemble the tree from the root read, the listed rows (null when the
 *  listing failed) and the batched reads keyed by rid. Rows whose parent is
 *  not in the tree are dropped; the root never appears twice. */
export function assembleStructure(
  root: FullObject,
  rows: readonly StructureRow[] | null,
  reads: Readonly<Record<string, FullObject>>,
): StructureTree {
  const nodes: Record<string, StructureNode> = Object.create(null);
  nodes[root.rid] = { rid: root.rid, parent: null, depth: 0, obj: root, children: [] };
  for (const row of rows ?? []) {
    if (row.rid === root.rid || nodes[row.rid]) continue;
    const parent = nodes[row.parent];
    if (!parent) continue;
    nodes[row.rid] = { rid: row.rid, parent: row.parent, depth: parent.depth + 1, obj: reads[row.rid] ?? null, children: [] };
    parent.children.push(row.rid);
  }
  const order: string[] = [];
  const visit = (rid: string) => {
    order.push(rid);
    for (const child of nodes[rid].children) visit(child);
  };
  visit(root.rid);
  return { rootRid: root.rid, order, nodes, tops: [root.rid] };
}

/** Attach a second tree (a data object's presenting template with its
 *  widgets) after the root's own tree. The attached root becomes a second
 *  top-level row; nodes already in `tree` are not added twice. Returns a new
 *  tree; `tree` is not changed. */
export function attachTree(tree: StructureTree, other: StructureTree): StructureTree {
  if (tree.nodes[other.rootRid]) return tree;
  const nodes: Record<string, StructureNode> = Object.create(null);
  Object.assign(nodes, tree.nodes);
  const order = [...tree.order];
  for (const rid of other.order) {
    if (nodes[rid]) continue;
    const n = other.nodes[rid];
    nodes[rid] = { ...n, children: n.children.filter(c => !tree.nodes[c]) };
    order.push(rid);
  }
  return { rootRid: tree.rootRid, order, nodes, tops: [...tree.tops, other.rootRid] };
}

/** Hang extra rows (followed references) under nodes already in the tree.
 *  A row whose parent is not in the tree, or whose node already is, is
 *  skipped; rows may build on rows attached before them. Returns a new tree;
 *  `tree` is not changed. */
export function attachRows(
  tree: StructureTree,
  rows: readonly AttachedRow[],
  reads: Readonly<Record<string, FullObject>>,
): StructureTree {
  if (!rows.length) return tree;
  const nodes: Record<string, StructureNode> = Object.create(null);
  for (const [rid, n] of Object.entries(tree.nodes)) nodes[rid] = { ...n, children: [...n.children] };
  let added = 0;
  for (const row of rows) {
    const parent = nodes[row.parent];
    if (!parent || nodes[row.rid]) continue;
    nodes[row.rid] = {
      rid: row.rid, parent: row.parent, depth: parent.depth + 1, obj: reads[row.rid] ?? null, children: [],
      ...(row.referenced ? { referenced: true } : {}),
    };
    parent.children.push(row.rid);
    added++;
  }
  if (!added) return tree;
  const order: string[] = [];
  const visit = (rid: string) => {
    order.push(rid);
    for (const c of nodes[rid].children) visit(c);
  };
  for (const top of tree.tops) visit(top);
  return { ...tree, order, nodes };
}
