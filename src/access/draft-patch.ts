import type { AccessCollection, AccessRecord } from '../lib/access-workspace/model';

type Draft = Partial<Record<AccessCollection, AccessRecord[]>>;
export interface DraftChange {
  collection: AccessCollection;
  rid: string;
  field: string | null;
  before: unknown;
  after: unknown;
  name: string;
}
type Identity = Omit<AccessRecord, 'content' | 'invalidContent'>;
export type HistoryContext = Partial<Record<AccessCollection, Identity[]>>;
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Detached, record/field-level patches. Omitted values remain distinct from
 * null; 64-bit record IDs stay strings. A policy body is one atomic field. */
export function changePatch(before: Draft, after: Draft): DraftChange[] {
  const changes: DraftChange[] = [];
  const collections = new Set([...Object.keys(before), ...Object.keys(after)] as AccessCollection[]);
  for (const collection of collections) {
    const old = new Map((before[collection] ?? []).map(r => [r.rid, r]));
    const now = new Map((after[collection] ?? []).map(r => [r.rid, r]));
    for (const rid of new Set([...old.keys(), ...now.keys()])) {
      const a = old.get(rid), b = now.get(rid);
      if (equal(a, b)) continue;
      if (!a || !b) {
        const row = (b ?? a)!;
        changes.push({ collection, rid, field: null, before: copy(a), after: copy(b), name: row.name ?? row.id ?? rid });
        continue;
      }
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)] as (keyof AccessRecord)[])) {
        if (!equal(a[field], b[field])) changes.push({ collection, rid, field,
          before: copy(a[field]), after: copy(b[field]), name: b.name ?? b.id ?? rid });
      }
    }
  }
  return changes;
}

/** Retain identities and ancestors for history labels, never every policy body
 * or the full assigned-user directory. Bodies live only in the patch. */
export function historyContext(model: Draft, patch: DraftChange[]): HistoryContext {
  const result: HistoryContext = Object.fromEntries(Object.keys(model).map(k => [k, []]));
  const byRid = new Map(Object.entries(model).flatMap(([collection, rows]) =>
    rows.map(r => [r.rid, { collection: collection as AccessCollection, r }] as const)));
  const retained = new Set<string>();
  for (const change of patch) {
    let rid = change.rid;
    while (rid && !retained.has(rid)) {
      retained.add(rid);
      const entry = byRid.get(rid);
      if (!entry) break;
      const { content: _content, invalidContent: _invalid, ...identity } = entry.r;
      result[entry.collection]!.push(copy(identity));
      rid = entry.r.parent;
    }
  }
  return result;
}
