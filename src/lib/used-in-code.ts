/**
 * "Used in code" from the local code index, for an extension page: the
 * objects whose Extended Code calls an object. The same search the code
 * search window runs in its "Used in code" mode (lib/code-search.ts), over
 * the same index (lib/code-index-store.ts). Read-only; references written as
 * `ns.id` are resolved in one batched post per 80 keys.
 */

import type { CodeIndexStatus, InspectorMessage } from './types';
import { sendRequestBounded } from './messaging';
import { codeIndexStore, type CodeIndexStore, type IndexedCard } from './code-index-store';
import { copyTargetKeys, indexSource, runCodeSearch, type CodeSearchHit } from './code-search';
import type { RefResolution } from './code-ref-resolve';
import type { Coverage } from './coverage-line';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

/** The light records of the index (no code), per index revision. */
let snapshot: { key: string; cards: IndexedCard[] } | null = null;

const keyOf = (st: CodeIndexStatus) => `${st.environment}|${st.version}|${st.syncedAt ?? ''}|${st.objects}|${st.pending}`;

/** Why the index was not searched, in the words of the coverage line. */
export function notSearchedReason(state: CodeIndexStatus['state'] | null): string {
  switch (state) {
    case 'building': return 'the code copy is still being made';
    case 'paused': return 'copying the code stopped';
    case 'failed': return 'the code copy could not be made';
    case 'unavailable': return 'a copy cannot be made of this server';
    case null: return 'no answer about the code copy';
    default: return 'no code copy on this computer';
  }
}

/** What an index search covered: the objects with code it holds, and when it was synced. */
export function indexCoverage(st: Pick<CodeIndexStatus, 'objects' | 'syncedAt' | 'builtAt' | 'pending' | 'notCovered'>): Coverage {
  const notes: string[] = [];
  if (st.pending > 0) notes.push(`${st.pending.toLocaleString('en-US')} changed objects are not read yet`);
  if (st.notCovered?.length) notes.push(`Not searched: ${st.notCovered.join('; ')}`);
  notes.push('References built from text at run time are not found');
  return { kind: 'index', objects: st.objects, at: st.syncedAt ?? st.builtAt, noun: ['object with code', 'objects with code'], note: notes.join('. ') };
}

export type UsedInCodeResult =
  | { hits: CodeSearchHit[]; coverage: Coverage }
  /** The index was not searched; `coverage` says why ("Not searched: no code index."). */
  | { hits: null; coverage: Coverage };

/** Objects whose code calls `target`, with what the answer covers. */
export async function usedInCode(target: { rid: string; businessId: string; name?: string; type?: string }): Promise<UsedInCodeResult> {
  const res = await sendRequestBounded<Msg<'CODE_INDEX_STATUS'>>({ type: 'CODE_INDEX_GET_STATUS' }, { timeoutMs: 5_000 });
  const st = res?.type === 'CODE_INDEX_STATUS' ? res.status : null;
  if (!st || (st.state !== 'ready' && st.state !== 'refreshing')) {
    return { hits: null, coverage: { kind: 'not-searched', reason: notSearchedReason(st?.state ?? null) } };
  }
  const key = keyOf(st);
  if (snapshot?.key !== key) {
    const cards: IndexedCard[] = [];
    await codeIndexStore().scanCards(st.environment, batch => { cards.push(...batch); }, 1000);
    snapshot = { key, cards };
  }
  const meta = { env: st.environment, syncedAt: st.syncedAt, builtAt: st.builtAt, objects: st.objects, bytes: st.bytes, types: [], pending: st.pending };
  const resolveKeys = async (keys: string[]): Promise<Record<string, RefResolution>> => {
    const out: Record<string, RefResolution> = {};
    for (let i = 0; i < keys.length; i += 80) {
      const r = await sendRequestBounded<Msg<'CODE_REFS_RESULT'>>({ type: 'RESOLVE_CODE_REFS', keys: keys.slice(i, i + 80), environment: st.environment }, { timeoutMs: 20_000 });
      if (r?.type !== 'CODE_REFS_RESULT' || !r.ok) throw new Error(r?.type === 'CODE_REFS_RESULT' && r.error ? r.error : 'References could not be resolved');
      Object.assign(out, r.results);
    }
    return out;
  };
  const hits = await usedInCodeFrom(codeIndexStore(), st.environment, snapshot.cards, target, resolveKeys, meta);
  return { hits, coverage: indexCoverage(st) };
}

/**
 * "Used in code" over the light records: the references are in the cards, so
 * the objects that call the target (with their templates) are found without
 * reading any code; only those are read in full and matched, exactly as a
 * search over the whole index would (lib/code-search.ts, refs mode).
 */
export async function usedInCodeFrom(
  store: Pick<CodeIndexStore, 'getMany'>, env: string, cards: readonly IndexedCard[],
  target: { rid: string; businessId: string; name?: string; type?: string },
  resolveKeys: (keys: string[]) => Promise<Record<string, RefResolution>>,
  meta: Parameters<typeof indexSource>[0],
): Promise<CodeSearchHit[]> {
  // The keys that name the target: its RID, and each `ns.id` key with its
  // business ID that resolves to it (the same rule as the search).
  const named = new Set<string>();
  if (target.businessId) {
    for (const c of cards) for (const ref of c.refs) if (!ref.k.startsWith('rid:') && ref.k.slice(ref.k.indexOf('.') + 1) === target.businessId) named.add(ref.k);
  }
  // A complete index holds every object with code: the names it answers
  // are not asked (code-search copyTargetKeys).
  const local = named.size && meta?.builtAt && !meta.pending ? copyTargetKeys(target, named, cards) : { keys: new Set<string>(), ask: [...named] };
  const resolved: Record<string, RefResolution> = local.ask.length ? await resolveKeys(local.ask) : {};
  for (const k of local.keys) resolved[k] = { found: true, target: { rid: target.rid, type: target.type ?? '', name: target.name ?? '', businessId: target.businessId } };
  const keys = new Set([`rid:${target.rid}`, ...[...named].filter(k => { const x = resolved[k]; return !!x?.found && x.target.rid === target.rid; })]);
  // An object calls the target in its own code, or through code it inherits
  // from its template (a property it does not hold itself).
  const byRid = new Map(cards.map(c => [c.rid, c]));
  const want = new Set<string>();
  for (const c of cards) {
    const own = c.refs.some(ref => keys.has(ref.k));
    const t = c.tmpl && c.inherits?.length ? byRid.get(c.tmpl) : undefined;
    const inherited = !!t && t.refs.some(ref => keys.has(ref.k) && c.inherits!.includes(ref.p) && !c.props.includes(ref.p));
    if (!own && !inherited) continue;
    want.add(c.rid);
    if (c.tmpl) want.add(c.tmpl);
  }
  const objects = await store.getMany(env, [...want].sort());
  const hits: CodeSearchHit[] = [];
  await runCodeSearch({ mode: 'refs', target: { rid: target.rid, businessId: target.businessId, ...(target.name ? { name: target.name } : {}) }, limit: 500 },
    indexSource(meta, each => { each(objects); return Promise.resolve(); }), found => { hits.push(...found); },
    // The keys are resolved above: the same answers, no second request.
    { resolveKeys: async ks => Object.fromEntries(ks.map(k => [k, resolved[k] ?? { found: false as const }])) });
  return hits;
}
