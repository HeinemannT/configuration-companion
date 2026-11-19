/**
 * Numeric IDs tab: state and actions. The tab changes the numbers BMP gave
 * objects as IDs into readable ones, on the window's own workspace, with no
 * target and no transport.
 *
 * Reads happen when the tab is opened the first time and on Refresh (and for
 * an area chosen later), never by themselves: each chosen area is read with
 * the numeric-ID scan (or taken from Find when Find holds the complete area),
 * then who created the numbered objects, then the stored code copy is asked
 * which objects name the IDs. The write is one confirmed operation:
 * numeric-id-write.ts says in which order and why.
 *
 * No DOM: the worker is reached through the injected deps, so tests drive it
 * with fake senders.
 */

import { applyIdChanges, buildNumericRecord, changeBack, inBatches, numericRecordKey, planCodeEdits, readNumericRecord, type IdChange, type IdOutcome, type IdRead, type IdRunAnswer, type IdWritePort, type NumericIdsRecord } from '../lib/numeric-id-write';
import { applyReplace, type ReplacePort, type ScriptResult } from '../lib/code-replace';
import { isFactAddress, TRANSPORT_FACTS_BATCH, type TransportOrigin, type TransportScanRow } from '../lib/transport-read';
import { TRANSPORT_READ_BATCH, type TransportRoot } from '../lib/transport-bundle';
import type { Proposal } from '../lib/numeric-id-propose';
import type { InspectorMessage } from '../lib/types';
import type { CodeAccess, CodeCopy } from './numeric-ids-code';
import type { DraftStore, TransportConnection } from './transport-controller';
import {
  areaTree, backLine, bmpReason, creatorCounts, entriesOf, entriesUnder, NUMERIC_AREAS, NUMERIC_DEFAULT_AREAS, proposalsFor, resultLine, rowStates, showEntries, shownEntries, takenIds,
  type AreaScan, type NumericEntry, type RowState,
} from './numeric-ids-model';
import type { GroupTree, TreeNode, TreeShow } from './transport-model';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

/** How long the window waits for one read or one batch of the change. */
export const NUMERIC_WAIT_MS = 200_000;

export interface NumericDeps {
  request(msg: InspectorMessage, timeoutMs: number, signal: AbortSignal): Promise<InspectorMessage | undefined>;
  connection(): Promise<TransportConnection | null>;
  now(): Date;
  store?: DraftStore;
  code: CodeAccess;
  replacePort(environment: string): ReplacePort;
  /** The rows Find holds for an area when it holds the whole area (a scan without a day, not cut). */
  findRows?(root: TransportRoot): TransportScanRow[] | null;
  openCodeSearch?(): void;
}

/** What the tab shows of the data of one area. */
export interface AreaModel {
  root: TransportRoot;
  scan: AreaScan;
  entries: NumericEntry[];
  byRid: Map<string, NumericEntry>;
  tree: GroupTree;
}

export type NumericChange = { kind: 'data' } | { kind: 'filters' } | { kind: 'ticks' } | { kind: 'status' } | { kind: 'confirm' } | { kind: 'result' };

/** What the confirmation lists. */
export interface ConfirmState {
  items: IdChange[];
  /** Objects whose code names these IDs; null when the code was not checked. */
  codeObjects: number | null;
  /** Ticked rows left out because the new ID turned out to be used. */
  leftOut: number;
  /** Running: which step. */
  phase: 'asking' | 'ready' | 'ids' | 'code';
  done: number;
  total: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_ANSWER = 'Companion did not answer. Close the window and open it again.';
const NOT_CONNECTED = 'Not connected to a server. Open this window on a BMP page Companion is set up for.';
const TIMED_OUT = 'The server did not answer in time.';

function failureLine(e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  if (kind === 'timeout') return TIMED_OUT;
  if (kind === 'no-response') return NO_ANSWER;
  return errorText(e) || NO_ANSWER;
}

export class NumericIdsController {
  /** The areas read, in the order of the Areas menu. */
  readonly chosen = new Set<TransportRoot>(NUMERIC_DEFAULT_AREAS);
  text = '';
  /** The tab was opened once (the first read started). */
  opened = false;
  reading: { label: string; done: number; total: number } | null = null;
  error: string | null = null;
  /** The line after a change or a change back. */
  result: string | null = null;
  confirm: ConfirmState | null = null;
  record: NumericIdsRecord | null = null;
  code: CodeCopy | null = null;
  /** Rows that were not changed, with the reason. */
  readonly notes = new Map<string, string>();
  /** Typed IDs. */
  readonly edits = new Map<string, string>();
  readonly ticked = new Set<string>();
  /** Folders and groups the user closed (BMP's own group starts closed). */
  readonly closed = new Set<string>();
  bmpOpen = false;
  /** Objects with code that names each entry's ID: key `space.id` → RIDs. */
  codeUsers = new Map<string, Set<string>>();

  private readonly scans = new Map<TransportRoot, AreaScan>();
  private readonly origins = new Map<string, TransportOrigin>();
  private readonly seen = new Set<string>();
  private readonly refused = new Map<string, string>();
  private models: AreaModel[] = [];
  private proposals = new Map<string, Proposal>();
  private taken = new Set<string>();
  private states = new Map<string, RowState>();
  private shows = new Map<string, { text: string; show: TreeShow }>();
  private readonly listeners = new Set<(c: NumericChange) => void>();
  private abort: AbortController | null = null;
  private stopped = false;
  private seq = 0;
  private readonly winId = Math.random().toString(36).slice(2, 10);
  private disposed = false;
  private connection: TransportConnection | null = null;

  constructor(private readonly deps: NumericDeps) {}

  onChange(fn: (c: NumericChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(c: NumericChange): void { for (const fn of this.listeners) fn(c); }
  private nextId(): string { return `ni-${this.winId}-${++this.seq}`; }

  get busy(): boolean { return !!this.reading || (!!this.confirm && (this.confirm.phase === 'ids' || this.confirm.phase === 'code' || this.confirm.phase === 'asking')); }
  get writing(): boolean { return !!this.confirm && (this.confirm.phase === 'ids' || this.confirm.phase === 'code'); }

  // ── reading ─────────────────────────────────────────────────────

  /** The tab was shown: read the chosen areas the first time. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    void this.loadRecord();
    void this.load(false);
  }

  refresh(): void {
    if (this.busy) return;
    this.result = null;
    void this.load(true);
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  setArea(root: TransportRoot, on: boolean): void {
    if (on) this.chosen.add(root); else this.chosen.delete(root);
    this.derive();
    this.emit({ kind: 'data' });
    if (on && !this.scans.has(root) && this.opened && !this.busy) void this.load(false);
  }

  get defaultAreas(): boolean {
    return this.chosen.size === NUMERIC_DEFAULT_AREAS.length && NUMERIC_DEFAULT_AREAS.every(r => this.chosen.has(r));
  }

  resetAreas(): void {
    this.chosen.clear();
    for (const r of NUMERIC_DEFAULT_AREAS) this.chosen.add(r);
    this.derive();
    this.emit({ kind: 'data' });
    if (this.opened && !this.busy && NUMERIC_DEFAULT_AREAS.some(r => !this.scans.has(r))) void this.load(false);
  }

  private async ensureConnection(): Promise<TransportConnection | null> {
    if (this.connection) return this.connection;
    try { this.connection = await this.deps.connection(); } catch { this.connection = null; }
    return this.connection;
  }

  private async ask<T extends InspectorMessage['type']>(make: (requestId: string) => InspectorMessage, answer: T, signal: AbortSignal): Promise<{ ok: true; res: Msg<T> } | { ok: false; stopped?: true; error?: string }> {
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request(make(this.nextId()), NUMERIC_WAIT_MS, signal);
    } catch (e) {
      return this.stopped || this.disposed ? { ok: false, stopped: true } : { ok: false, error: failureLine(e) };
    }
    if (this.stopped || this.disposed) return { ok: false, stopped: true };
    if (res?.type === 'REQUEST_FAILED' || res?.type !== answer) return { ok: false, error: res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER };
    const r = res as unknown as { ok?: boolean; cancelled?: boolean; error?: string };
    if (r.cancelled) return { ok: false, stopped: true };
    if (!r.ok) return { ok: false, error: r.error || 'The read failed.' };
    return { ok: true, res: res as Msg<T> };
  }

  /** Read the chosen areas that are not read yet (all of them with `force`), then who created the numbered objects, then the code copy. */
  private async load(force: boolean): Promise<void> {
    if (this.reading || this.disposed) return;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'status' }); return; }
    this.error = null;
    this.stopped = false;
    this.abort = new AbortController();
    const roots = NUMERIC_AREAS.filter(r => this.chosen.has(r) && (force || !this.scans.has(r)));
    this.reading = { label: '', done: 0, total: roots.length };
    this.emit({ kind: 'status' });
    try {
      for (const root of roots) {
        if (this.stopped || this.disposed) break;
        this.reading = { label: root, done: this.reading.done, total: roots.length };
        this.emit({ kind: 'status' });
        const found = !force ? this.deps.findRows?.(root) : null;
        if (found) {
          this.scans.set(root, scanFromRows(root, found, this.deps.now().getTime()));
        } else {
          const r = await this.ask<'NUMERIC_IDS_SCAN_RESULT'>(requestId => ({ type: 'NUMERIC_IDS_SCAN', requestId, environment: conn.environment, root }), 'NUMERIC_IDS_SCAN_RESULT', this.abort.signal);
          if (!r.ok) { if (!r.stopped) this.error = r.error ?? 'The read failed.'; break; }
          if (r.res.missingRoot) this.scans.set(root, { root, rows: [], context: [], more: false, at: this.deps.now().getTime() });
          else this.scans.set(root, { root, rows: r.res.rows ?? [], context: r.res.context ?? [], more: !!r.res.more, at: this.deps.now().getTime() });
        }
        this.reading = { label: root, done: this.reading.done + 1, total: roots.length };
        this.derive();
        this.emit({ kind: 'data' });
      }
      if (!this.stopped && !this.error) await this.readOrigins(conn);
      // The objects are known now: list them, then ask the stored code copy which code names them.
      this.reading = null;
      this.derive();
      this.emit({ kind: 'data' });
      if (!this.stopped && !this.disposed) await this.readCode();
    } finally {
      this.reading = null;
      this.abort = null;
      this.derive();
      this.emit({ kind: 'data' });
      this.emit({ kind: 'status' });
    }
  }

  private candidates(): TransportScanRow[] {
    const out: TransportScanRow[] = [];
    for (const s of this.scans.values()) for (const e of entriesOf(s, new Map())) out.push(e.row);
    return out;
  }

  private async readOrigins(conn: TransportConnection): Promise<void> {
    const todo = this.candidates().map(r => r.rid).filter(rid => !this.origins.has(rid));
    const batches = inBatches(todo, TRANSPORT_READ_BATCH);
    for (let i = 0; i < batches.length; i++) {
      if (this.stopped || this.disposed) return;
      this.reading = { label: 'who created them', done: i, total: batches.length };
      this.emit({ kind: 'status' });
      const r = await this.ask<'NUMERIC_IDS_ORIGINS_RESULT'>(requestId => ({ type: 'NUMERIC_IDS_ORIGINS', requestId, environment: conn.environment, rids: batches[i] }), 'NUMERIC_IDS_ORIGINS_RESULT', this.abort!.signal);
      if (!r.ok) {
        if (!r.stopped) { this.error = `Could not tell which objects are BMP's own: ${r.error ?? 'the read failed'}`; }
        return;
      }
      for (const o of r.res.origins ?? []) if ('origin' in o) this.origins.set(o.rid, o.origin);
    }
  }

  private async readCode(): Promise<void> {
    try { this.code = await this.deps.code.status(); } catch { this.code = null; }
    this.codeUsers = new Map();
    if (this.code?.ready) {
      const keys = new Set<string>();
      for (const m of this.models) for (const e of m.entries) keys.add(`${e.space}.${e.row.id}`);
      try { this.codeUsers = await this.deps.code.users(keys); } catch { this.code = { ready: false, reason: 'the code copy could not be read', canMake: false }; }
    }
  }

  /** The oldest read among the chosen areas (epoch ms), or null. */
  get readAt(): number | null {
    let at: number | null = null;
    for (const r of this.chosen) { const s = this.scans.get(r); if (s && (at == null || s.at < at)) at = s.at; }
    return at;
  }

  /** The areas read that were cut at the scan's limit. */
  get cut(): TransportRoot[] {
    return [...this.chosen].filter(r => this.scans.get(r)?.more);
  }

  // ── what the list holds ─────────────────────────────────────────

  /** Rebuild the entries, proposals and trees from the scans and origins. */
  private derive(): void {
    const scans = NUMERIC_AREAS.filter(r => this.scans.has(r) && this.chosen.has(r)).map(r => this.scans.get(r)!);
    // While the areas are read, an object is not listed before it is known whether it is BMP's own.
    this.models = scans.map(scan => {
      const entries = entriesOf(scan, this.origins, this.byCreator).filter(e => !this.reading || this.origins.has(e.row.rid));
      return { root: scan.root, scan, entries, byRid: new Map(entries.map(e => [e.row.rid, e])), tree: areaTree(scan) };
    });
    const all = this.models.flatMap(m => m.entries);
    this.proposals = proposalsFor(all, scans);
    this.taken = takenIds(scans);
    this.shows.clear();
    // Own objects start ticked; one whose origin is not known (the read failed or was stopped) starts unticked.
    // When the signed-in user is the built-in account the creator says nothing: nothing starts ticked.
    for (const e of all) {
      if (this.seen.has(e.row.rid)) continue;
      this.seen.add(e.row.rid);
      if (!e.bmp && this.byCreator && this.origins.has(e.row.rid)) this.ticked.add(e.row.rid);
    }
    this.restate();
  }

  private restate(): void {
    this.states = rowStates(this.models.flatMap(m => m.entries), this.proposals, this.edits, this.ticked, this.taken, this.refused);
  }

  get areaModels(): readonly AreaModel[] { return this.models; }

  stateOf(rid: string): RowState | undefined { return this.states.get(rid); }
  proposalOf(rid: string): Proposal | undefined { return this.proposals.get(rid); }

  /** What shows of an area, for its own objects or BMP's. */
  show(m: AreaModel, bmp: boolean): TreeShow {
    const key = `${m.root}|${bmp}`;
    const cached = this.shows.get(key);
    if (cached && cached.text === this.text) return cached.show;
    const show = showEntries(m.tree, m.byRid, bmp, { text: this.text });
    this.shows.set(key, { text: this.text, show });
    return show;
  }

  isClosed(key: string): boolean { return this.closed.has(key); }

  /** Entries of the tab that are not BMP's own. */
  get ownEntries(): NumericEntry[] { return this.models.flatMap(m => m.entries.filter(e => !e.bmp)); }
  /** Does the creator tell BMP's own objects from the user's? (Not for the built-in account.) */
  get byCreator(): boolean { return creatorCounts(this.connection?.user); }

  get bmpEntries(): NumericEntry[] { return this.models.flatMap(m => m.entries.filter(e => e.bmp)); }

  /** The number on the tab: objects listed as the user's own. */
  get count(): number { return this.ownEntries.length; }

  /** Ticked rows with a usable ID (the ones that change), and rows listed (own, and BMP's that are ticked). */
  get ready(): NumericEntry[] {
    return this.models.flatMap(m => m.entries).filter(e => this.ticked.has(e.row.rid) && !this.states.get(e.row.rid)?.problem && !this.done.has(e.row.rid));
  }
  get listed(): number { return this.ownEntries.length + this.bmpEntries.filter(e => this.ticked.has(e.row.rid)).length; }

  /** Rows changed in this window: gone from the list. */
  private readonly done = new Set<string>();

  codeCount(e: NumericEntry): number | undefined {
    if (!this.code?.ready) return undefined;
    return this.codeUsers.get(`${e.space}.${e.row.id}`)?.size ?? 0;
  }

  // ── filters, ticks, edits ───────────────────────────────────────

  setText(text: string): void {
    this.text = text;
    this.shows.clear();
    this.emit({ kind: 'filters' });
  }

  toggleNode(key: string): void {
    if (this.closed.has(key)) this.closed.delete(key); else this.closed.add(key);
    this.emit({ kind: 'filters' });
  }

  toggleBmp(): void {
    this.bmpOpen = !this.bmpOpen;
    this.emit({ kind: 'filters' });
  }

  setTicked(rids: Iterable<string>, on: boolean): void {
    for (const rid of rids) { if (on) this.ticked.add(rid); else this.ticked.delete(rid); }
    this.restate();
    this.emit({ kind: 'ticks' });
  }

  /** The entries shown under a folder (or in the whole area with no node). */
  entriesIn(m: AreaModel, bmp: boolean, node?: TreeNode): NumericEntry[] {
    const show = this.show(m, bmp);
    return node ? entriesUnder(m.tree, show, node, m.byRid) : shownEntries(m.tree, show, m.byRid);
  }

  /** 'all', 'some' or 'none' of the entries are ticked. */
  tickState(entries: readonly NumericEntry[]): 'all' | 'some' | 'none' | 'empty' {
    if (!entries.length) return 'empty';
    const n = entries.filter(e => this.ticked.has(e.row.rid)).length;
    return n === 0 ? 'none' : n === entries.length ? 'all' : 'some';
  }

  /** Every entry that shows, own and BMP's. */
  get shown(): NumericEntry[] {
    return this.models.flatMap(m => [...this.entriesIn(m, false), ...(this.bmpOpen ? this.entriesIn(m, true) : [])]);
  }

  setValue(rid: string, text: string): void {
    const value = text.trim();
    if (!value || value === this.proposals.get(rid)?.id) this.edits.delete(rid); else this.edits.set(rid, value);
    this.refused.delete(rid);
    this.restate();
    this.emit({ kind: 'ticks' });
  }

  /** Back to the proposal. */
  resetValue(rid: string): void { this.setValue(rid, ''); }

  /** Why the row is where it is, for the BMP group. */
  whyBmp(e: NumericEntry): string { return e.why ?? bmpReason(this.origins.get(e.row.rid), this.byCreator) ?? ''; }

  // ── the change ──────────────────────────────────────────────────

  /** The IDs that would change, in the order of the list. */
  private selection(): NumericEntry[] {
    return this.models.flatMap(m => m.tree.order.map(n => m.byRid.get(n.key)).filter((e): e is NumericEntry => !!e && this.ticked.has(e.row.rid) && !this.states.get(e.row.rid)?.problem && !this.done.has(e.row.rid)));
  }

  private itemOf(e: NumericEntry): IdChange {
    return { rid: e.row.rid, space: e.space, className: e.row.className, name: e.row.name, from: e.row.id, to: this.states.get(e.row.rid)!.value };
  }

  /** "Change n IDs": check that the new IDs are free, count the code that names the old ones, show the confirmation. */
  async requestChange(): Promise<void> {
    if (this.busy || this.confirm) return;
    this.result = null;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'status' }); return; }
    const first = this.selection();
    if (!first.length) return;
    this.confirm = { items: [], codeObjects: null, leftOut: 0, phase: 'asking', done: 0, total: first.length };
    this.emit({ kind: 'confirm' });
    this.stopped = false;
    this.abort = new AbortController();
    try {
      await this.checkFree(conn, first);
      const selected = this.selection();
      const items = selected.map(e => this.itemOf(e));
      let codeObjects: number | null = null;
      if (this.code?.ready && items.length) {
        try {
          const users = await this.deps.code.users(new Set(items.map(i => `${i.space}.${i.from}`)));
          codeObjects = new Set([...users.values()].flatMap(s => [...s])).size;
        } catch { codeObjects = null; }
      }
      if (this.disposed) return;
      this.confirm = items.length ? { items, codeObjects, leftOut: first.length - items.length, phase: 'ready', done: 0, total: items.length } : null;
      if (!items.length) this.error = 'None of the new IDs is free to use. Change them, then try again.';
    } finally {
      this.abort = null;
      this.emit({ kind: 'confirm' });
      this.emit({ kind: 'ticks' });
    }
  }

  /** Ask the server whether the new IDs are used (a row whose ID is used leaves the selection). */
  private async checkFree(conn: TransportConnection, rows: readonly NumericEntry[]): Promise<void> {
    const asked = rows.map(e => ({ e, address: `${e.space}.${this.states.get(e.row.rid)!.value}` })).filter(a => isFactAddress(a.address));
    for (const batch of inBatches(asked, TRANSPORT_FACTS_BATCH)) {
      const r = await this.ask<'TRANSPORT_FACTS_RESULT'>(requestId => ({ type: 'TRANSPORT_FACTS', requestId, environment: conn.environment, addresses: batch.map(a => a.address) }), 'TRANSPORT_FACTS_RESULT', this.abort!.signal);
      // A read that fails does not stop the change: the script checks again for every object.
      if (!r.ok) return;
      for (const f of r.res.facts ?? []) {
        if ('missing' in f) continue;
        const hit = batch.find(a => a.address === f.address);
        if (hit) this.refused.set(hit.e.row.rid, 'Already used by another object');
      }
    }
    this.restate();
  }

  cancelConfirm(): void {
    if (!this.confirm || this.writing) return;
    this.confirm = null;
    this.emit({ kind: 'confirm' });
  }

  private idPort(conn: TransportConnection): IdWritePort {
    return {
      run: async (items, transactional): Promise<IdRunAnswer> => {
        // A committed run is never aborted once it started.
        const signal = transactional ? new AbortController().signal : this.abort!.signal;
        const r = await this.ask<'NUMERIC_IDS_RUN_RESULT'>(requestId => ({
          type: 'NUMERIC_IDS_RUN', requestId, environment: conn.environment, items: [...items], transactional,
          ...(transactional ? { confirmed: true } : {}),
        }), 'NUMERIC_IDS_RUN_RESULT', signal);
        if (r.ok) return { ok: true, log: r.res.log ?? '' };
        if (r.stopped) return { ok: false, error: 'Stopped', cancelled: true };
        return { ok: false, error: r.error ?? 'The change failed.', ...(transactional && r.error === TIMED_OUT ? { outcomeUnknown: true } : {}) };
      },
      read: async (rids): Promise<Map<string, IdRead>> => {
        const out = new Map<string, IdRead>();
        for (const batch of inBatches(rids, TRANSPORT_READ_BATCH)) {
          const r = await this.ask<'TRANSPORT_ROWS_RESULT'>(requestId => ({ type: 'TRANSPORT_ROWS', requestId, environment: conn.environment, rids: batch }), 'TRANSPORT_ROWS_RESULT', new AbortController().signal);
          if (!r.ok) throw new Error(r.error ?? 'The objects could not be read again.');
          for (const row of r.res.rows ?? []) out.set(row.rid, 'row' in row ? { id: row.row.id } : 'missing' in row ? { missing: true } : { error: row.error });
        }
        return out;
      },
    };
  }

  /** The confirmed change: the IDs, then the code that names them. */
  async confirmChange(): Promise<void> {
    const c = this.confirm;
    if (!c || c.phase !== 'ready') return;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'status' }); return; }
    this.error = null;
    this.stopped = false;
    this.abort = new AbortController();
    const items = c.items;
    this.confirm = { ...c, phase: 'ids', done: 0 };
    this.emit({ kind: 'confirm' });
    let outcomes: IdOutcome[] = [];
    let codeResults: ScriptResult[] = [];
    let codeLine = '';
    try {
      outcomes = await applyIdChanges(items, this.idPort(conn), {
        signal: this.abort.signal,
        onBatch: (done, total) => { this.confirm = { ...(this.confirm ?? c), phase: 'ids', done, total }; this.emit({ kind: 'confirm' }); },
      });
      const changed = outcomes.filter(o => o.status === 'changed');
      // The record exists as soon as an ID changed: closing the window now still leaves a way back.
      await this.saveRecord(buildNumericRecord(conn.environment, outcomes, [], 'ids', this.deps.now()));
      if (changed.length && this.code?.ready) {
        this.confirm = { ...(this.confirm ?? c), phase: 'code', done: 0, total: changed.length };
        this.emit({ kind: 'confirm' });
        try {
          codeResults = await this.changeCode(conn, changed.map(o => o.item));
        } catch (e) {
          codeLine = `The code was not changed: ${failureLine(e)}`;
        }
      }
      await this.saveRecord(buildNumericRecord(conn.environment, outcomes, codeResults, 'done', this.deps.now()));
    } finally {
      this.abort = null;
      this.confirm = null;
    }
    this.finish(outcomes, codeResults, codeLine);
  }

  /** Rewrite the code that names the changed IDs (the Replace engine of Code Search). */
  private async changeCode(conn: TransportConnection, changed: readonly IdChange[]): Promise<ScriptResult[]> {
    const users = await this.deps.code.users(new Set(changed.map(i => `${i.space}.${i.from}`)));
    const rids = [...new Set([...users.values()].flatMap(s => [...s]))];
    if (!rids.length) return [];
    const holders = await this.deps.code.holders(rids);
    const edits = planCodeEdits(changed, holders);
    return applyReplace(edits, this.deps.replacePort(conn.environment), {
      signal: this.abort?.signal,
      onResult: (_r, done, total) => { this.confirm = { ...(this.confirm ?? { items: [], codeObjects: null, leftOut: 0, phase: 'code', done: 0, total: 0 }), phase: 'code', done, total }; this.emit({ kind: 'confirm' }); },
    });
  }

  private finish(outcomes: readonly IdOutcome[], code: readonly ScriptResult[], codeLine: string): void {
    const changed = outcomes.filter(o => o.status === 'changed');
    for (const o of outcomes) if (o.status !== 'changed') this.notes.set(o.item.rid, o.reason ?? 'Not changed');
    for (const o of changed) this.markDone(o.item);
    const saved = code.filter(r => r.status === 'saved');
    const failed = code.filter(r => r.status !== 'saved');
    for (const r of failed) this.error = `${r.name || r.businessId || r.rid}: ${r.message ?? 'not changed'}`;
    this.result = [resultLine({
      changed: changed.length, codeObjects: new Set(saved.map(r => r.rid)).size, codeNotSaved: new Set(failed.map(r => r.rid)).size,
      notChanged: outcomes.length - changed.length,
    }), codeLine].filter(Boolean).join(' ');
    this.derive();
    this.emit({ kind: 'data' });
    this.emit({ kind: 'result' });
    this.emit({ kind: 'confirm' });
  }

  /** The object has its new ID: it leaves the numbers and joins the other objects of its area. */
  private markDone(c: IdChange): void {
    this.done.add(c.rid);
    this.ticked.delete(c.rid);
    this.edits.delete(c.rid);
    for (const s of this.scans.values()) {
      const at = s.rows.findIndex(r => r.rid === c.rid);
      if (at < 0) continue;
      const [row] = s.rows.splice(at, 1);
      s.context.push({ rid: row.rid, parentRid: row.parentRid, parentId: row.parentId, sortIndex: row.sortIndex, id: c.to, name: row.name, className: row.className });
      this.shows.clear();
      return;
    }
  }

  // ── the record, and changing back ───────────────────────────────

  private async loadRecord(): Promise<void> {
    const conn = await this.ensureConnection();
    if (!conn || !this.deps.store) return;
    try { this.record = readNumericRecord(await this.deps.store.get(numericRecordKey(conn.environment)), conn.environment); } catch { this.record = null; }
    this.emit({ kind: 'result' });
  }

  private async saveRecord(record: NumericIdsRecord | null): Promise<void> {
    this.record = record;
    this.emit({ kind: 'result' });
    const conn = this.connection;
    if (!conn || !this.deps.store) return;
    try {
      if (record) await this.deps.store.set(numericRecordKey(conn.environment), record);
      else await this.deps.store.remove(numericRecordKey(conn.environment));
    } catch { /* kept in this window only */ }
  }

  /** "Change back": the IDs of the last change, then its code. */
  async undo(): Promise<void> {
    const record = this.record;
    if (!record || this.busy) return;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'status' }); return; }
    this.error = null;
    this.stopped = false;
    this.abort = new AbortController();
    this.confirm = { items: [], codeObjects: null, leftOut: 0, phase: 'ids', done: 0, total: record.ids.length };
    this.emit({ kind: 'confirm' });
    try {
      const back = await changeBack(record, this.idPort(conn), this.deps.replacePort(conn.environment), {
        signal: this.abort.signal,
        onStep: step => { this.confirm = { ...(this.confirm!), phase: step }; this.emit({ kind: 'confirm' }); },
      });
      await this.saveRecord(back.rest);
      const ids = back.ids.filter(o => o.status === 'changed').length;
      this.result = backLine({
        ids, code: back.code.filter(r => r.status === 'saved').length, heldBack: back.heldBack, notBack: back.ids.length - ids,
      }) + (ids ? ' Refresh to list them again.' : '');
      for (const o of back.ids) if (o.status === 'changed') this.done.delete(o.item.rid);
    } catch (e) {
      this.error = failureLine(e);
    } finally {
      this.abort = null;
      this.confirm = null;
      this.emit({ kind: 'result' });
      this.emit({ kind: 'confirm' });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
  }
}

/** An area as Find holds it, in the shape of the numeric scan. */
export function scanFromRows(root: TransportRoot, rows: readonly TransportScanRow[], at: number): AreaScan {
  const digit = (r: TransportScanRow) => /^[0-9]/.test(r.id);
  return {
    root, at, more: false,
    rows: rows.filter(digit),
    context: rows.filter(r => !digit(r)).map(r => ({ rid: r.rid, parentRid: r.parentRid, parentId: r.parentId, sortIndex: r.sortIndex, id: r.id, name: r.name, className: r.className })),
  };
}

