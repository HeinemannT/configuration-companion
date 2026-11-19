/**
 * What an extension window needs to run a replace (code-replace.ts): the port
 * to the server through the service worker, the record of the last replace
 * kept across windows, and the entry that opens Code Search on the Replace tab.
 */

import { sendFireForget, sendRequest } from './messaging';
import { readReplaceRecord, replaceRecordKey, type ReplacePort, type ReplaceRecord, type SyntaxAnswer } from './code-replace';
import { syntaxProblemText } from './ec-syntax-check';
import type { InspectorMessage } from './types';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

/** The port to the server for one server (`environment`: the window's own,
 *  so a request never reaches another server). Reads and writes are the
 *  editor's own messages: STUDIO_FETCH_CODE and SAVE_PROPERTY. */
export function messageReplacePort(environment?: string): ReplacePort {
  const env = environment ? { environment } : {};
  return {
    async fetch(rid, props) {
      const r = await sendRequest<Msg<'STUDIO_CODE_DATA'>>({ type: 'STUDIO_FETCH_CODE', rid, props, ...env });
      return r?.type === 'STUDIO_CODE_DATA' && r.ok && r.code
        ? { ok: true, code: r.code }
        : { ok: false, error: (r?.type === 'STUDIO_CODE_DATA' && r.error) || 'No response from the extension' };
    },
    async check(text): Promise<SyntaxAnswer> {
      const r = await sendRequest<Msg<'EC_SYNTAX_RESULT'>>({ type: 'EC_SYNTAX_CHECK', code: text, ...env });
      if (r?.type !== 'EC_SYNTAX_RESULT') return { ok: false, message: 'Could not check the script: no response from the extension', verdict: false };
      if (r.ok) return { ok: true };
      return r.verdict
        ? { ok: false, message: syntaxProblemText(r.message ?? ''), verdict: true }
        : { ok: false, message: `Could not check the script: ${r.message ?? 'no answer'}`, verdict: false };
    },
    async write(rid, label, prop, value) {
      const r = await sendRequest<Msg<'SAVE_RESULT'>>({
        type: 'SAVE_PROPERTY', ...env, rid, objectType: label.type, property: prop, value,
        objectLabel: { name: label.name, businessId: label.businessId, type: label.type },
      });
      return r?.type === 'SAVE_RESULT' ? r : undefined;
    },
  };
}

// ── the record of the last replace ────────────────────────────────

/** The last replace of each server, in chrome.storage.local (as the
 *  Transport keeps its last apply): it survives closing the window. */
export const replaceRecords = {
  async load(environment: string): Promise<ReplaceRecord | null> {
    try {
      const key = replaceRecordKey(environment);
      const got = await chrome.storage.local.get(key);
      return readReplaceRecord(got[key], environment);
    } catch { return null; }
  },
  async save(record: ReplaceRecord): Promise<void> {
    try { await chrome.storage.local.set({ [replaceRecordKey(record.environment)]: record }); } catch { /* kept in this window only */ }
  },
  async clear(environment: string): Promise<void> {
    try { await chrome.storage.local.remove(replaceRecordKey(environment)); } catch { /* nothing to clear */ }
  },
};

// ── the entry ─────────────────────────────────────────────────────

/** Open Code Search on the Replace tab with the find and replace text filled
 *  in (nothing is searched or changed until the user acts). For another
 *  window: the Transport's numeric IDs. */
export function openCodeSearchReplace(find: string, replace = ''): void {
  sendFireForget({ type: 'OPEN_CODE_SEARCH', mode: 'replace', query: find, replace });
}
