/**
 * Where a reference property is used in the server's Extended Code, from the
 * local code copy (lib/code-index-store.ts): the objects whose code reads the
 * property (`.controls`, `rref(controls)`). Read-only and local: no server
 * request. Without a copy there is no answer, and Atlas says so in the place
 * of the list.
 *
 * A property is found by its ID in the text, so a property of another type
 * with the same ID is counted too, and a read built from text at run time is
 * not found.
 */
import type { CodeIndexStatus } from '../messages';
import type { CodeIndexStore, IndexedObject } from '../code-index-store';

export interface UsageHit {
  rid: string;
  type: string;
  name: string;
  businessId: string;
  /** "Grandparent › Parent". */
  where: string;
  /** The property of the object that holds the code. */
  codeProp: string;
}

export type AtlasUsage =
  /** The copy is being read. */
  | { state: 'loading' }
  | { state: 'ready'; byProp: Record<string, UsageHit[]>; objects: number; at: number | null }
  /** No copy to read: `reason` in the words of the code search window; `canMake` when the user can make one; `making` while one is made. */
  | { state: 'none'; reason: string; canMake: boolean; making?: { read: number; toRead: number } };

const READ = /(?:\.(?!rref\()|\brref\(\s*)([A-Za-z_][A-Za-z0-9_]*)/g;

/** The IDs `code` reads as a property or through `rref`, each once. */
export function propsRead(code: string, wanted: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const m of code.matchAll(READ)) if (wanted.has(m[1])) found.add(m[1]);
  return [...found];
}

/** Add the hits of one batch of stored objects. */
export function addUsage(byProp: Record<string, UsageHit[]>, batch: readonly IndexedObject[], wanted: ReadonlySet<string>): void {
  for (const o of batch) {
    for (const [codeProp, code] of Object.entries(o.code)) {
      for (const prop of propsRead(code, wanted)) {
        (byProp[prop] ??= []).push({ rid: o.rid, type: o.type, name: o.name, businessId: o.businessId, where: o.where, codeProp });
      }
    }
  }
}

/** Why there is no usage, from the state of the code copy. */
export function noUsage(st: Pick<CodeIndexStatus, 'state' | 'progress' | 'error'> | null): Extract<AtlasUsage, { state: 'none' }> {
  switch (st?.state) {
    case 'building': return { state: 'none', reason: 'Making the code copy', canMake: false, making: { read: st.progress?.read ?? 0, toRead: st.progress?.toRead ?? 0 } };
    case 'paused': return { state: 'none', reason: 'Code copy incomplete', canMake: true };
    case 'failed': return { state: 'none', reason: st.error || 'Code copy failed', canMake: true };
    case 'unavailable': return { state: 'none', reason: 'No code copy possible on this server', canMake: false };
    case 'none': return { state: 'none', reason: 'No code copy of this server', canMake: true };
    default: return { state: 'none', reason: 'Code copy state unknown', canMake: false };
  }
}

/** Where each of `props` is used, from the copy `st` describes. */
export async function readUsage(store: CodeIndexStore, st: CodeIndexStatus | null, props: Iterable<string>): Promise<AtlasUsage> {
  if (!st || (st.state !== 'ready' && st.state !== 'refreshing')) return noUsage(st);
  const wanted = new Set(props);
  const byProp: Record<string, UsageHit[]> = {};
  let objects = 0;
  await store.scan(st.environment, batch => { objects += batch.length; addUsage(byProp, batch, wanted); }, 400);
  return { state: 'ready', byProp, objects, at: st.syncedAt ?? st.builtAt };
}

/** How often each property is used: what the route ranking takes. */
export function usageCounts(usage: AtlasUsage | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (usage?.state === 'ready') for (const [prop, hits] of Object.entries(usage.byProp)) out[prop] = hits.length;
  return out;
}

/** The hits of one property by the type of the object that holds the code, the largest group first. */
export function groupHits(hits: readonly UsageHit[]): Array<{ type: string; hits: UsageHit[] }> {
  const by = new Map<string, UsageHit[]>();
  for (const h of hits) by.set(h.type, [...(by.get(h.type) ?? []), h]);
  return [...by].map(([type, list]) => ({ type, hits: list })).sort((a, b) => b.hits.length - a.hits.length || a.type.localeCompare(b.type));
}
