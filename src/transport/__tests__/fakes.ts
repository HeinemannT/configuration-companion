/** Fake worker for the Transport window tests: records every message and
 *  answers each request from a handler, or holds it until the test says. */
import type { InspectorMessage } from '../../lib/types';
import type { TransportScanRow, TransportObjectRead, TransportTarget } from '../../lib/transport-read';
import { PROBE_MARKER, PROBE_VERSION, type TransportProbe } from '../../lib/transport-patch';
import { splitAddress } from '../../lib/transport-bundle';
import type { TransportDeps } from '../transport-controller';

export type Sent = InspectorMessage & { [k: string]: unknown };

export interface Pending {
  msg: Sent;
  signal: AbortSignal;
  resolve(r: InspectorMessage | undefined): void;
  reject(e: unknown): void;
}

export interface FakeWorker {
  deps: TransportDeps;
  sent: Sent[];
  posted: Sent[];
  pending: Pending[];
  /** Answer requests at once with this (undefined: hold them in `pending`;
   *  an answer of HOLD holds that request). */
  answer?: (msg: Sent) => InspectorMessage | undefined | typeof HOLD | Promise<InspectorMessage | undefined>;
  /** The requests for the connected workspaces: answered at once with
   *  `targets` (default: none), kept apart from `sent` and `pending`. */
  targetsSent: Sent[];
  targets: TransportTarget[];
  /** The facts reads of used objects: answered at once by `facts` (default:
   *  nothing known), kept apart from `sent` and `pending`. */
  factsSent: Sent[];
  facts?: (msg: Sent) => InspectorMessage | undefined;
  /** The reads of what the source has under a listing start: answered at
   *  once by `sourceListing` (default: the IDs in `sourceIds`, none), kept
   *  apart from `sent` and `pending`. */
  sourceListingSent: Sent[];
  sourceIds: string[];
  sourceListing?: (msg: Sent) => InspectorMessage | undefined;
}

export const ENV = 'p1@https://bmp.example.test/Work/';

/** An answer that holds its request in `pending`. */
export const HOLD = Symbol('hold');

export function fakeWorker(answer?: FakeWorker['answer'], connected = true): FakeWorker {
  const w: FakeWorker = {
    sent: [], posted: [], pending: [], answer, targetsSent: [], targets: [], factsSent: [], sourceListingSent: [], sourceIds: [],
    deps: {
      request: (msg, _timeoutMs, signal) => {
        const m = msg as Sent;
        if (m.type === 'TRANSPORT_FACTS') {
          w.factsSent.push(m);
          return Promise.resolve(w.facts ? w.facts(m) : { type: 'TRANSPORT_FACTS_RESULT', requestId: m.requestId as string, environment: ENV, ok: true, facts: [] } as InspectorMessage);
        }
        if (m.type === 'TRANSPORT_SOURCE_LISTING') {
          w.sourceListingSent.push(m);
          return Promise.resolve(w.sourceListing ? w.sourceListing(m) : { type: 'TRANSPORT_SOURCE_LISTING_RESULT', requestId: m.requestId as string, environment: ENV, start: m.start as string, ok: true, ids: w.sourceIds } as InspectorMessage);
        }
        if (m.type === 'TRANSPORT_TARGETS') {
          w.targetsSent.push(m);
          return Promise.resolve({ type: 'TRANSPORT_TARGETS_RESULT', requestId: m.requestId as string, environment: ENV, ok: true, targets: w.targets } as InspectorMessage);
        }
        w.sent.push(m);
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Request cancelled'), { kind: 'cancelled' })), { once: true });
          const a = w.answer?.(m);
          if (w.answer && a !== HOLD) { Promise.resolve(a).then(resolve, reject); return; }
          w.pending.push({ msg: m, signal, resolve, reject });
        });
      },
      post: msg => { w.posted.push(msg as Sent); },
      connection: async () => (connected ? { environment: ENV, label: 'Demo DEV' } : null),
      now: () => new Date(2026, 10, 15, 12, 0, 0),
    },
  };
  return w;
}

/** An in-memory draft store with the calls it got. */
export function memoryStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const calls: Array<{ op: 'get' | 'set' | 'remove'; key: string }> = [];
  return {
    data, calls,
    get: async (key: string) => { calls.push({ op: 'get', key }); return structuredClone(data[key]); },
    set: async (key: string, value: unknown) => { calls.push({ op: 'set', key }); data[key] = structuredClone(value); },
    remove: async (key: string) => { calls.push({ op: 'remove', key }); delete data[key]; },
  };
}

/** Let queued promise callbacks run. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let n = 0;
/** A scan row; RIDs are 64-bit numbers as text. */
export function row(over: Partial<TransportScanRow> = {}): TransportScanRow {
  n++;
  return {
    rid: String(9_007_199_254_740_993n + BigInt(n)),
    id: `obj_${n}`,
    name: `Object ${n}`,
    className: 'TextElement',
    modified: 'Nov 14, 2026 10:05:00',
    modifiedIso: '2026-11-14T10:05:00',
    modifiedBy: 'Editor One',
    modifiedById: 'u1',
    created: 'Jan 2, 2026 09:00:00',
    createdIso: '2026-01-02T09:00:00',
    parentRid: '',
    parentId: '',
    parentName: '',
    sortIndex: 0,
    ...over,
  };
}

export function scanResult(msg: Sent, over: Record<string, unknown> = {}): InspectorMessage {
  return { type: 'TRANSPORT_SCAN_RESULT', requestId: msg.requestId as string, environment: ENV, root: msg.root as string, since: msg.since as string, ok: true, rows: [], ...over } as InspectorMessage;
}

/** The answer of a scan under an object: `origin` first, then `rows`
 *  (`missingStart` when there is no origin). */
export function underResult(msg: Sent, origin: TransportScanRow | null, rows: TransportScanRow[] = [], over: Record<string, unknown> = {}): InspectorMessage {
  return {
    type: 'TRANSPORT_SCAN_UNDER_RESULT', requestId: msg.requestId as string, environment: ENV, start: msg.start as string, since: msg.since as string, ok: true,
    ...(origin ? { origin, rows: [origin, ...rows] } : { rows: [], missingStart: true }), ...over,
  } as InspectorMessage;
}

/** A read that worked: a text element with a genedit line. */
export function readOk(rid: string, id: string, over: Partial<Extract<TransportObjectRead, { ok: true }>> = {}): TransportObjectRead {
  return {
    rid, ok: true, className: 'TextElement',
    generate: `t.page.add(TextElement, id := '${id}', name := 'Name ${id}')`,
    genedit: `t.${id}.change(id := '${id}', name := 'Name ${id}') //TextElement`,
    parentAddress: 't.page', previousAddress: '', nextAddress: '', parentId: 'page', parentIsRoot: false, systemObject: false,
    ...over,
  };
}

/** The creation texts of a creation read, as `readOk` would read them. */
export function creationResult(msg: Sent, ids: ReadonlyMap<string, string>, over: Record<string, unknown> = {}): InspectorMessage {
  const texts = (msg.rids as string[]).map(rid => ({ rid, ok: true, generate: `t.page.add(TextElement, id := '${ids.get(rid)}', name := 'Name ${ids.get(rid)}')` }));
  return { type: 'TRANSPORT_CREATION_RESULT', requestId: msg.requestId as string, environment: ENV, ok: true, texts, ...over } as InspectorMessage;
}

/** What a target holds per address, for a probe answer: class, text, and
 *  its parent's ID (default `page`) and siblings' IDs (default none). */
export type ProbeTarget = Record<string, { cls: string; genedit?: string; parent?: string; prev?: string; next?: string; generate?: string; instances?: string; flow?: string; modified?: string } | undefined>;

/** The generate(true) text of a property definition linked to `classes`,
 *  as BMP prints it. */
export const propertyGenerate = (id: string, classes: readonly string[], cls = 'ListMethodConfig'): string =>
  `\n_lmc := root.property.add(${cls}, id := '${id}', name := 'Name ${id}')${classes.map(c => `\n        c.get(${c}.name).link(_lmc)`).join('')}\n`;

/** `<size>:<text>`. */
const framed = (s = '') => `${s.length}:${s}`;

/** The answer a target prints for `probe`, every part as a script window
 *  shows it (`Result : ` before, `Duration : …` after), in the order given. */
export function probeAnswer(probe: TransportProbe, target: ProbeTarget, opts: { key?: string; version?: number; parts?: number[]; cut?: boolean; listing?: ListedTarget[] | null; types?: string } = {}): string {
  const k = opts.key ?? probe.key;
  const order = opts.parts ?? probe.parts.map(p => p.index);
  const NL = String.fromCharCode(10);
  return order.map(index => {
    const part = probe.parts.find(p => p.index === index)!;
    let s = `${PROBE_MARKER} v${opts.version ?? PROBE_VERSION} part ${part.index}/${part.total} key ${k}`;
    // The types switched off on the target, as each part prints them.
    if (opts.types != null) s += `${NL}Y ${framed(opts.types)}`;
    for (const e of probe.entries.filter(x => x.part === part.index)) {
      const t = target[e.address];
      const a = framed(e.address);
      if (!t) s += `${NL}M ${a}`;
      else if (e.kind === 'object') {
        // The place line, as the part's loop prints it.
        const at = splitAddress(e.address)!;
        s += `${NL}P ${at.space} ${framed(at.id)} ${framed(t.parent ?? 'page')} ${framed(t.prev)} ${framed(t.next)}`;
        s += `${NL}O ${a} ${t.cls} ${framed(t.genedit)} ${framed(t.modified ?? 'Nov 16, 2026 20:17:30')}`;
        if (e.links) s += `${NL}L ${a} ${framed(t.generate)}${NL}I ${a} ${framed(t.instances)}`;
        if (e.flow) s += `${NL}F ${a} ${framed(t.flow)}`;
      } else if (e.kind === 'step') s += `${NL}T ${a} ${t.cls} ${framed(t.genedit)}`;
      else s += `${NL}E ${a} ${t.cls} ${framed(t.parent ?? 'page')}`;
    }
    if (part.step === 'listing') s += listingAnswer(opts.listing === undefined ? [] : opts.listing);
    if (opts.cut) return `Result : ${s.slice(0, -5)}`;
    return `Result : ${s}${NL}${PROBE_MARKER} end part ${part.index}/${part.total} key ${k}${NL}Duration : 3ms${NL}`;
  }).join(NL);
}

/** An object the target has under the listed object. */
export interface ListedTarget { id: string; parent: string; cls?: string; name?: string; system?: boolean }

/** The listing lines of a probe answer; null: the object is not there. */
export function listingAnswer(objects: readonly ListedTarget[] | null): string {
  if (!objects) return '\nK -1';
  return objects.map(o => `\nU ${o.cls ?? 'TextElement'} ${o.system ? 'true' : 'false'} ${framed(o.id)} ${framed(o.parent)} ${framed(o.name ?? `Name ${o.id}`)}`).join('')
    + `\nK ${objects.length}`;
}

/** A value text longer than two lines. */
export const LONG_TEXT = `'${'A long text that wraps. '.repeat(14).trim()}'`;

/** The patch path's case: four rows in Shared web, a worker that answers
 *  the scan and the reads, and a target that holds one object with another
 *  name and a value of its own, one the same, none of the third (its parent
 *  is there) and the fourth with another class. */
export function patchCase() {
  const rows = [row({ id: 'el_change' }), row({ id: 'el_same' }), row({ id: 'el_new' }), row({ id: 'el_clash' })];
  const ids = new Map(rows.map(r => [r.rid, r.id]));
  const read = (rid: string) => {
    const id = ids.get(rid)!;
    return id === 'el_change'
      ? readOk(rid, id, { genedit: `t.el_change.change(id := 'el_change', name := ${LONG_TEXT}) //TextElement` })
      : readOk(rid, id);
  };
  const answer: FakeWorker['answer'] = msg => (msg.type === 'TRANSPORT_READ_OBJECTS'
    ? objectsResult(msg, (msg.rids as string[]).map(read))
    : msg.type === 'TRANSPORT_READ_CREATION' ? creationResult(msg, ids)
      : scanResult(msg, { rows: msg.root === 'portal' ? rows : [] }));
  const target: ProbeTarget = {
    't.el_change': { cls: 'TextElement', genedit: "\nt.el_change.change(id := 'el_change', name := 'Old name', description := 'only there') //TextElement\n" },
    't.el_same': { cls: 'TextElement', genedit: "\nt.el_same.change(id := 'el_same', name := 'Name el_same') //TextElement\n" },
    't.el_clash': { cls: 'ExtendedTable', genedit: "\nt.el_clash.change(id := 'el_clash') //ExtendedTable\n" },
    't.page': { cls: 'Category' },
  };
  return { rows, ids, answer, target };
}

export function logResult(msg: Sent, over: Record<string, unknown> = {}): InspectorMessage {
  return { type: 'TRANSPORT_LOG_RESULT', requestId: msg.requestId as string, environment: ENV, ok: true, entries: [], ...over } as InspectorMessage;
}

export function objectsResult(msg: Sent, objects: TransportObjectRead[], over: Record<string, unknown> = {}): InspectorMessage {
  return { type: 'TRANSPORT_OBJECTS_RESULT', requestId: msg.requestId as string, environment: ENV, ok: true, objects, ...over } as InspectorMessage;
}

/** The answer of a read of one object by its RID and everything under it:
 *  `origin` first, then `rows` (`missing` when there is no origin). */
export function belowResult(msg: Sent, origin: TransportScanRow | null, rows: TransportScanRow[] = [], over: Record<string, unknown> = {}): InspectorMessage {
  return {
    type: 'TRANSPORT_SCAN_BELOW_RESULT', requestId: msg.requestId as string, environment: ENV, rid: msg.rid as string, since: msg.since as string, ok: true,
    ...(origin ? { origin, rows: [origin, ...rows] } : { rows: [], missing: true }), ...over,
  } as InspectorMessage;
}

/** The answer of a children read: the RIDs of `rows`. */
export function childrenResult(msg: Sent, rows: TransportScanRow[], over: Record<string, unknown> = {}): InspectorMessage {
  return { type: 'TRANSPORT_CHILDREN_RESULT', requestId: msg.requestId as string, environment: ENV, ok: true, rids: rows.map(r => r.rid), ...over } as InspectorMessage;
}

/** The answer of a rows read: the rows asked for among `known`. */
export function rowsResult(msg: Sent, known: readonly TransportScanRow[]): InspectorMessage {
  const rows = (msg.rids as string[]).map(rid => { const row = known.find(r => r.rid === rid); return row ? { rid, row } : { rid, missing: true }; });
  return { type: 'TRANSPORT_ROWS_RESULT', requestId: msg.requestId as string, environment: ENV, ok: true, rows } as InspectorMessage;
}

/** The answer of a counts read: \`counts\` by root name or RID. */
export function countsResult(msg: Sent, counts: Record<string, number>): InspectorMessage {
  return { type: 'TRANSPORT_COUNTS_RESULT', requestId: msg.requestId as string, environment: ENV, ok: true, counts } as InspectorMessage;
}
