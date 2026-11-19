/**
 * What the numeric-ID tab asks of the stored code copy (the code index): is
 * there one, which objects' code names an ID, and the code of those objects.
 * Nothing is read from the server here; the copy is the one Code Search keeps
 * and is never made or refreshed from this tab.
 */

import { sendRequestBounded } from '../lib/messaging';
import { codeIndexStore } from '../lib/code-index-store';
import { notSearchedReason } from '../lib/used-in-code';
import { codeObjectCounts, type CodeHolder } from '../lib/numeric-id-write';
import type { CodeIndexStatus, InspectorMessage } from '../lib/types';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

export type CodeCopy =
  | { ready: true; environment: string; at: number | null; objects: number }
  /** `canMake`: Code Search offers to make a copy. */
  | { ready: false; reason: string; canMake: boolean };

export interface CodeAccess {
  status(): Promise<CodeCopy>;
  /** The RIDs of the objects whose code names each key (`t.5612`). */
  users(keys: ReadonlySet<string>): Promise<Map<string, Set<string>>>;
  /** The stored code of some objects. */
  holders(rids: readonly string[]): Promise<CodeHolder[]>;
}

export function codeCopyFrom(st: Pick<CodeIndexStatus, 'state' | 'environment' | 'syncedAt' | 'builtAt' | 'objects'> | null): CodeCopy {
  if (st && (st.state === 'ready' || st.state === 'refreshing')) return { ready: true, environment: st.environment, at: st.syncedAt ?? st.builtAt, objects: st.objects };
  const state = st?.state ?? null;
  return { ready: false, reason: notSearchedReason(state), canMake: state === 'none' || state === 'paused' || state === 'failed' };
}

export function indexCodeAccess(): CodeAccess {
  let copy: Extract<CodeCopy, { ready: true }> | null = null;
  return {
    async status() {
      let st: CodeIndexStatus | null = null;
      try {
        const res = await sendRequestBounded<Msg<'CODE_INDEX_STATUS'>>({ type: 'CODE_INDEX_GET_STATUS' }, { timeoutMs: 5_000 });
        st = res?.type === 'CODE_INDEX_STATUS' ? res.status : null;
      } catch { st = null; }
      const c = codeCopyFrom(st);
      copy = c.ready ? c : null;
      return c;
    },
    async users(keys) {
      if (!copy || !keys.size) return new Map();
      const cards: Array<{ rid: string; refs: ReadonlyArray<{ k: string }> }> = [];
      await codeIndexStore().scanCards(copy.environment, batch => { for (const c of batch) if (c.refs.some(r => keys.has(r.k))) cards.push({ rid: c.rid, refs: c.refs }); }, 1000);
      return codeObjectCounts(cards, keys);
    },
    async holders(rids) {
      if (!copy || !rids.length) return [];
      const objects = await codeIndexStore().getMany(copy.environment, rids);
      return objects.map(o => ({ rid: o.rid, type: o.type, name: o.name, businessId: o.businessId, code: o.code }));
    },
  };
}
