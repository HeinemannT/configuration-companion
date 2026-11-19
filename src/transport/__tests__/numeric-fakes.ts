/** A fake worker, code copy and server for the Numeric IDs tests: it holds IDs by RID and code texts, and answers the tab's messages. */
import { framedText } from '../../lib/ec-parser';
import { findCodeRefs } from '../../lib/code-refs';
import type { ReplacePort } from '../../lib/code-replace';
import type { CodeHolder, IdChange } from '../../lib/numeric-id-write';
import type { NumericContextRow, TransportOrigin, TransportScanRow } from '../../lib/transport-read';
import type { InspectorMessage } from '../../lib/types';
import type { CodeAccess, CodeCopy } from '../numeric-ids-code';
import { NumericIdsController, type NumericDeps } from '../numeric-ids-controller';

export const ENV = 'p1@https://bmp.example.test/Work/';
export const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };

export const row = (rid: string, id: string, name: string, o: Partial<TransportScanRow> = {}): TransportScanRow => ({
  rid, id, name, className: 'ActionButton', modified: '', modifiedBy: '', modifiedById: '', created: '', parentRid: 'F1', parentId: 'folder_one', parentName: 'Folder one', sortIndex: 0, ...o,
});
export const folder = (rid: string, id: string, name: string, root = 'TEMPLATECATEGORY'): NumericContextRow => ({ rid, parentRid: 'ROOT', parentId: root, sortIndex: 0, id, name, className: 'Category' });

export interface Setup {
  c: NumericIdsController;
  sent: Array<Record<string, unknown>>;
  ids: Map<string, string>;
  texts: Map<string, string>;
  store: Map<string, unknown>;
  writes: string[];
  origins: Map<string, TransportOrigin>;
  scans: Map<string, { rows: TransportScanRow[]; context: NumericContextRow[] }>;
  copy: { value: CodeCopy };
  fail: { scanRoot?: string; originsFail?: boolean; previewFail?: number; commitFail?: number; factsTaken?: Set<string>; syntaxFail?: Set<string> };
}

export function setup(o: { rows?: TransportScanRow[]; context?: NumericContextRow[]; origins?: Array<[string, string]>; code?: Array<[string, string, string]>; copy?: CodeCopy; find?: Record<string, TransportScanRow[]>; areas?: string[]; user?: string } = {}): Setup {
  const rows = o.rows ?? [];
  const context = o.context ?? [folder('F1', 'folder_one', 'Folder one')];
  const ids = new Map(rows.map(r => [r.rid, r.id]));
  const texts = new Map((o.code ?? []).map(([rid, prop, text]) => [`${rid}|${prop}`, text]));
  const store = new Map<string, unknown>();
  const writes: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const origins = new Map<string, TransportOrigin>(rows.map(r => [r.rid, { rid: r.rid, systemObject: false, createdBy: 'Tassilo' }]));
  for (const [rid, by] of o.origins ?? []) origins.set(rid, { rid, systemObject: false, createdBy: by });
  const scans = new Map<string, { rows: TransportScanRow[]; context: NumericContextRow[] }>([['templateCategory', { rows, context }]]);
  const copy = { value: o.copy ?? ({ ready: true, environment: ENV, at: 5, objects: 10 } as CodeCopy) };
  const fail: Setup['fail'] = {};
  let previews = 0;
  let commits = 0;

  const reply = (msg: Record<string, unknown>, extra: Record<string, unknown>): InspectorMessage => ({ type: `${msg.type as string}_RESULT`, requestId: msg.requestId, environment: ENV, ok: true, ...extra } as unknown as InspectorMessage);
  const request: NumericDeps['request'] = async (m) => {
    const msg = m as unknown as Record<string, unknown>;
    sent.push(msg);
    switch (msg.type) {
      case 'NUMERIC_IDS_SCAN': {
        if (fail.scanRoot === msg.root) return reply(msg, { ok: false, error: 'The server did not answer in time.' });
        const s = scans.get(msg.root as string);
        return reply(msg, s ? { rows: s.rows.filter(r => ids.get(r.rid) === r.id), context: [...s.context, ...s.rows.filter(r => ids.get(r.rid) !== r.id).map(r => ({ rid: r.rid, parentRid: r.parentRid, parentId: r.parentId, sortIndex: 0, id: ids.get(r.rid)!, name: r.name, className: r.className }))] } : { missingRoot: true });
      }
      case 'NUMERIC_IDS_ORIGINS':
        if (fail.originsFail) return reply(msg, { ok: false, error: 'No access' });
        return reply(msg, { origins: (msg.rids as string[]).map(rid => ({ rid, origin: origins.get(rid) ?? { rid, systemObject: false, createdBy: '' } })) });
      case 'TRANSPORT_FACTS':
        return reply(msg, { facts: (msg.addresses as string[]).map(a => (fail.factsTaken?.has(a) ? { address: a, rid: '1', className: 'Tab', parentId: 'x', name: 'n' } : { address: a, missing: true })) });
      case 'NUMERIC_IDS_RUN': {
        const items = msg.items as IdChange[];
        if (!msg.transactional) { previews++; if (fail.previewFail === previews) return reply(msg, { ok: false, error: 'Script too large' }); } else { commits++; if (fail.commitFail === commits) return reply(msg, { ok: false, error: 'Server error' }); }
        const out = items.map(i => {
          const status = ids.get(i.rid) !== i.from ? 'gone' : [...ids.values()].includes(i.to) ? 'taken' : 'ok';
          if (msg.transactional && status === 'ok') ids.set(i.rid, i.to);
          return ['R', i.rid, status];
        });
        return reply(msg, { log: framedText(out) });
      }
      case 'TRANSPORT_ROWS':
        return reply(msg, { rows: (msg.rids as string[]).map(rid => (ids.has(rid) ? { rid, row: row(rid, ids.get(rid)!, 'x') } : { rid, missing: true })) });
      default:
        return undefined;
    }
  };

  const code: CodeAccess = {
    async status() { return copy.value; },
    async users(keys) {
      const out = new Map<string, Set<string>>();
      for (const [k, text] of texts) for (const r of findCodeRefs(text)) if (keys.has(r.key)) { const s = out.get(r.key) ?? new Set<string>(); s.add(k.split('|')[0]); out.set(r.key, s); }
      return out;
    },
    async holders(rids) {
      return rids.map((rid): CodeHolder => ({ rid, type: 'ExtendedExpression', name: `Calc ${rid}`, businessId: `calc_${rid}`, code: Object.fromEntries([...texts].filter(([k]) => k.startsWith(`${rid}|`)).map(([k, v]) => [k.split('|')[1], v])) }));
    },
  };
  const replacePort: ReplacePort = {
    async fetch(rid, props) { return { ok: true, code: Object.fromEntries(props.map(p => [p, texts.get(`${rid}|${p}`) ?? ''])) }; },
    async check(text) { return fail.syntaxFail?.has(text) ? { ok: false, message: 'Syntax error', verdict: true } : { ok: true }; },
    async write(rid, _l, prop, value) { texts.set(`${rid}|${prop}`, value); writes.push(`${rid}|${prop}`); return { ok: true, committed: true } as never; },
  };
  const deps: NumericDeps = {
    request,
    connection: async () => ({ environment: ENV, label: 'Work', ...(o.user !== undefined ? { user: o.user } : {}) }),
    now: () => new Date(2026, 10, 19, 12, 0, 0),
    store: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); }, remove: async k => { store.delete(k); } },
    code,
    replacePort: () => replacePort,
    findRows: root => o.find?.[root] ?? null,
  };
  const c = new NumericIdsController(deps);
  if (o.areas) { c.chosen.clear(); for (const a of o.areas) c.chosen.add(a as never); }
  return { c, sent, ids, texts, store, writes, origins, scans, copy, fail };
}

