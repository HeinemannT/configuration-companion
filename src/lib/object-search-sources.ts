/**
 * The object search's sources for an extension page (lib/object-search.ts):
 * the worker's exact lookup, the local code index in IndexedDB, the
 * worker's server search and the portal quick search.
 */

import type { CodeIndexStatus, InspectorMessage } from './types';
import { sendFireForget, sendRequestBounded } from './messaging';
import { codeIndexStore } from './code-index-store';
import { matchLocal, searchObjects, searchReportText, type FoundObject, type ObjectSearchSources, type SearchReport } from './object-search';
import type { PickerObject, PickerSearch } from './object-picker';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

interface Lite { rid: string; type: string; name: string; businessId: string; where: string }

let snapshot: { key: string; objects: Lite[]; at: number | null } | null = null;
let loading: Promise<void> | null = null;

const keyOf = (st: CodeIndexStatus) => `${st.environment}|${st.version}|${st.syncedAt ?? ''}|${st.objects}|${st.pending}`;

/** Name, ID and location of every indexed object (no code), cached per
 *  index revision. Null when the index is not ready. */
async function indexObjects(): Promise<{ objects: Lite[]; at: number | null } | null> {
  const res = await sendRequestBounded<Msg<'CODE_INDEX_STATUS'>>({ type: 'CODE_INDEX_GET_STATUS' }, { timeoutMs: 5_000 }).catch(() => null);
  const st = res?.type === 'CODE_INDEX_STATUS' ? res.status : null;
  if (!st || (st.state !== 'ready' && st.state !== 'refreshing')) return null;
  const key = keyOf(st);
  if (snapshot?.key === key) return snapshot;
  if (!loading) {
    loading = (async () => {
      const objects: Lite[] = [];
      // The light records: no code is read.
      await codeIndexStore().scanCards(st.environment, batch => {
        for (const o of batch) objects.push({ rid: o.rid, type: o.type, name: o.name, businessId: o.businessId, where: o.where });
      }, 1000);
      snapshot = { key, objects, at: st.syncedAt };
    })().finally(() => { loading = null; });
  }
  await loading;
  return snapshot?.key === key ? snapshot : null;
}

/** A query that can be an exact RID or business ID (no spaces). */
const exactShaped = (q: string) => /^-?\d{15,20}$/.test(q) || /^[A-Za-z0-9_.:-]{2,120}$/.test(q);

export function objectSearchSources(channel: string, opts: { portal?: boolean } = {}): ObjectSearchSources {
  let info: { objects: number; at: number | null } | null = null;
  let notice: string | null = null;
  const sources: ObjectSearchSources = {
    indexInfo: () => info,
    serverNotice: () => notice,
    async exact(query) {
      const q = query.trim();
      if (!exactShaped(q)) return null;
      const res = await sendRequestBounded<Msg<'BROWSE_RESOLVE_RESULT'>>({ type: 'BROWSE_RESOLVE', query: q, gen: Date.now() }, { timeoutMs: 20_000 });
      if (res?.type !== 'BROWSE_RESOLVE_RESULT' || !res.ok) throw new Error(res?.type === 'BROWSE_RESOLVE_RESULT' && res.error ? res.error : 'No answer');
      return res.object ? { rid: res.object.rid, name: res.object.name, type: res.object.type, businessId: res.object.businessId } : null;
    },
    async local(query) {
      const all = await indexObjects();
      info = all ? { objects: all.objects.length, at: all.at } : null;
      return all ? matchLocal(all.objects, query) : null;
    },
    async server(query, skipIndexed, signal) {
      const onAbort = () => sendFireForget({ type: 'OBJECT_SEARCH_CANCEL', channel });
      signal.addEventListener('abort', onAbort, { once: true });
      notice = null;
      try {
        const res = await sendRequestBounded<Msg<'OBJECT_SEARCH_RESULT'>>({ type: 'OBJECT_SEARCH', query, channel, skipIndexed }, { timeoutMs: 70_000 });
        if (signal.aborted) return [];
        if (res?.type !== 'OBJECT_SEARCH_RESULT' || !res.ok) throw new Error(res?.type === 'OBJECT_SEARCH_RESULT' && res.error ? res.error : 'No answer');
        notice = res.notice ?? null;
        return res.objects;
      } finally { signal.removeEventListener('abort', onAbort); }
    },
  };
  if (opts.portal !== false) {
    sources.portal = async (query) => {
      const res = await sendRequestBounded<Msg<'BROWSE_SEARCH_RESULT'>>({ type: 'BROWSE_SEARCH', query, gen: Date.now(), pageSize: 20 }, { timeoutMs: 20_000 });
      if (res?.type !== 'BROWSE_SEARCH_RESULT' || !res.ok) throw new Error(res?.type === 'BROWSE_SEARCH_RESULT' && res.error ? res.error : 'No answer');
      return (res.objects ?? []).map((o): FoundObject => ({ rid: o.rid, name: o.name ?? '', type: o.type ?? '', businessId: o.businessId ?? '' }));
    };
  }
  return sources;
}

/** The object search as the picker's `search` (lib/object-picker.ts). */
export function pickerSearch(channel: string): PickerSearch {
  const sources = objectSearchSources(channel);
  const toPicker = (list: readonly FoundObject[]): PickerObject[] =>
    list.map(o => ({ rid: o.rid, name: o.name, type: o.type, businessId: o.businessId, ...(o.where ? { note: o.where } : {}), ...(o.exact ? { tag: 'exact' } : {}) }));
  let last: SearchReport | null = null;
  const search: PickerSearch = async (query, signal, partial) => {
    last = null;
    return toPicker(await searchObjects(query, sources, signal, found => partial?.(toPicker(found)), r => { last = r; }));
  };
  search.coverage = () => (last ? searchReportText(last) : null);
  search.notice = () => last?.notice ?? null;
  // Data objects by name come from the portal's search (its second phase).
  search.dataHint = !!sources.portal;
  return search;
}
