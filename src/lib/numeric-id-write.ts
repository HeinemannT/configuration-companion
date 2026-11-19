/**
 * Changing numeric IDs on the window's own workspace, with the Extended Code
 * that names them. Pure: the caller supplies the ports (messages to the
 * worker); no DOM, no chrome.*.
 *
 * Order, and why. IDs first, then code:
 *  1. The IDs change in batches of ID_BATCH objects. Each batch is run as a
 *     preview first (nothing kept), then committed for the objects the
 *     preview accepted, then every object is read again: only an object whose
 *     ID reads back as the new one counts as changed.
 *  2. The code that names a changed ID is rewritten afterwards, through the
 *     Replace engine (code-replace.ts: the script is read again and compared
 *     with the copy, parsed on the server, written, read back).
 * The syntax check does not look up IDs, so a script may name an ID that does
 * not exist yet or any more; the order is chosen for what a failure leaves:
 *  - IDs first: an ID that could not be changed is known before any script is
 *    touched, so no script ever names an ID that does not exist. The only
 *    broken state is a script that still names an ID that has changed, which
 *    is what the user sees in the result and what "Change back" repairs.
 *  - Code first would leave scripts naming IDs that do not exist if the ID
 *    step then failed, and nothing would show which.
 * After the ID step the record of the change is stored (phase `ids`), and
 * again after the code step (phase `done`), so closing the window between
 * the two leaves a record that "Change back" can use.
 *
 * Linked copies are not listed: a copy follows its template, which is its own
 * object with its own ID; changing the template's ID leaves the copies linked.
 *
 * "Change back" runs the same steps the other way: IDs first (an ID that can
 * not go back keeps its new name), then the scripts, but only those whose
 * IDs all went back.
 */

import { appendRowEc, EC_CHUNK, EC_DONE_LITERAL, flushChunkEc, parseFramedLog } from './ec-parser';
import { ecString, validateBusinessId, validateRid } from './ec-guards';
import { findCodeRefs, type CodeRef } from './code-refs';
import { isEcScriptProp, undoReplace, type Edit, type ReplacePort, type ReplaceRecord, type ScriptChange, type ScriptResult } from './code-replace';

/** Objects whose ID one run changes at most. */
export const ID_BATCH = 20;

/** One ID to change. `space` is the ID space of the object (`t`, `r` …). */
export interface IdChange {
  rid: string;
  space: string;
  className: string;
  name: string;
  from: string;
  to: string;
}

const SPACE = /^[a-z]{1,6}$/;

/** Throws when an item could not be written into a script. */
export function checkIdChange(c: IdChange): void {
  validateRid(c.rid);
  validateBusinessId(c.from);
  validateBusinessId(c.to);
  if (!SPACE.test(c.space)) throw new Error(`Not an ID space: ${c.space}`);
  if (c.from === c.to) throw new Error('The new ID is the old one');
}

export function inBatches<T>(items: readonly T[], size = ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── the script of one batch ───────────────────────────────────────

export type RunStatus = 'ok' | 'gone' | 'moved' | 'taken';

const row = (rid: string, status: RunStatus, indent: string): string[] => appendRowEc(EC_CHUNK, ['"R"', ecString(rid), ecString(status)], indent);

/**
 * The script that changes a batch: per object, the object at its old ID, only
 * when it is the object with that RID and nothing has the new ID yet.
 * Every case writes one framed row (`R`, RID, status) so the answer says what
 * happened to each. Run it as a preview first.
 */
export function buildIdChangeEc(items: readonly IdChange[]): string {
  if (!items.length || items.length > ID_BATCH) throw new Error(`Between 1 and ${ID_BATCH} objects per run.`);
  const lines: string[] = ['_r := ""', `${EC_CHUNK} := ""`];
  for (const c of items) {
    checkIdChange(c);
    lines.push(
      `_o := ${c.space}.get(${ecString(c.from)})`,
      'IF _o = MISSING THEN',
      ...row(c.rid, 'gone', ' '),
      'ELSE',
      ` IF str(_o.rid) != ${ecString(c.rid)} THEN`,
      ...row(c.rid, 'moved', '  '),
      ' ELSE',
      `  IF ${c.space}.get(${ecString(c.to)}) != MISSING THEN`,
      ...row(c.rid, 'taken', '   '),
      '  ELSE',
      `   _o.change(id := ${ecString(c.to)})`,
      ...row(c.rid, 'ok', '   '),
      '  ENDIF',
      ' ENDIF',
      'ENDIF',
    );
  }
  lines.push(...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  return lines.join('\n');
}

/** What the batch's answer says per RID. Throws on a cut-off or damaged answer. */
export function parseIdChangeLog(log: string, items: readonly IdChange[]): Map<string, RunStatus> {
  const out = new Map<string, RunStatus>();
  const asked = new Set(items.map(i => i.rid));
  for (const r of parseFramedLog(log)) {
    if (r[0] !== 'R' || r.length !== 3 || !asked.has(r[1]) || !(['ok', 'gone', 'moved', 'taken'] as string[]).includes(r[2])) throw new Error('BMP returned a damaged answer');
    out.set(r[1], r[2] as RunStatus);
  }
  return out;
}

export const RUN_REASONS: Readonly<Record<Exclude<RunStatus, 'ok'>, string>> = {
  gone: 'The object is not on the server with this ID any more',
  moved: 'Another object has this ID now',
  taken: 'The new ID is already used',
};

// ── running a batch ───────────────────────────────────────────────

export interface IdRunAnswer {
  ok: boolean;
  log?: string;
  error?: string;
  /** A committed run whose answer did not arrive: it may have been applied. */
  outcomeUnknown?: boolean;
  cancelled?: boolean;
}

export type IdRead = { id: string } | { missing: true } | { error: string };

export interface IdWritePort {
  /** One batch as a preview or committed (the caller confirmed already). */
  run(items: readonly IdChange[], transactional: boolean): Promise<IdRunAnswer>;
  /** The IDs the server holds now (one read per call; the port batches). */
  read(rids: readonly string[]): Promise<Map<string, IdRead>>;
}

export type IdStatus = 'changed' | 'skipped' | 'failed' | 'unknown';

export interface IdOutcome {
  item: IdChange;
  status: IdStatus;
  /** Why it was not changed, or what is not known. */
  reason?: string;
}

export const NOT_STARTED = 'Not started: an earlier step failed';
export const NOT_SAVED_UNKNOWN = 'Whether it was saved is not known. Refresh the list.';

/**
 * Change the IDs batch by batch. A preview that fails stops the run (nothing
 * of that batch was written); a committed batch is read back before the next
 * starts. `onBatch` follows each batch with the outcomes so far.
 */
export async function applyIdChanges(
  items: readonly IdChange[],
  port: IdWritePort,
  opts: { signal?: AbortSignal; onBatch?: (done: number, total: number, outcomes: readonly IdOutcome[]) => void } = {},
): Promise<IdOutcome[]> {
  const out: IdOutcome[] = [];
  const batches = inBatches(items);
  let stopped: string | null = null;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (stopped || opts.signal?.aborted) {
      for (const item of batch) out.push({ item, status: 'skipped', reason: stopped ?? NOT_STARTED });
      continue;
    }
    const finished = await runBatch(batch, port);
    out.push(...finished.outcomes);
    if (finished.stop) stopped = NOT_STARTED;
    opts.onBatch?.(b + 1, batches.length, out);
  }
  return out;
}

async function runBatch(batch: readonly IdChange[], port: IdWritePort): Promise<{ outcomes: IdOutcome[]; stop: boolean }> {
  const fail = (status: IdStatus, reason: string): IdOutcome[] => batch.map(item => ({ item, status, reason }));
  let preview: IdRunAnswer;
  try { preview = await port.run(batch, false); } catch (e) { return { outcomes: fail('failed', errorText(e)), stop: true }; }
  if (!preview.ok) return { outcomes: fail('failed', preview.error || 'The server did not accept the change'), stop: true };
  let statuses: Map<string, RunStatus>;
  try { statuses = parseIdChangeLog(preview.log ?? '', batch); } catch (e) { return { outcomes: fail('failed', errorText(e)), stop: true }; }
  const outcomes = new Map<string, IdOutcome>();
  const go: IdChange[] = [];
  for (const item of batch) {
    const s = statuses.get(item.rid);
    if (s === 'ok') go.push(item);
    else outcomes.set(item.rid, { item, status: 'skipped', reason: s ? RUN_REASONS[s] : 'The preview did not say' });
  }
  let stop = false;
  if (go.length) {
    let commit: IdRunAnswer | null = null;
    let thrown: string | null = null;
    try { commit = await port.run(go, true); } catch (e) { thrown = errorText(e); }
    const unknown = !!(commit?.outcomeUnknown) || thrown != null;
    if (commit && !commit.ok && !unknown) {
      for (const item of go) outcomes.set(item.rid, { item, status: 'failed', reason: commit.error || 'The server did not change it' });
      stop = true;
    } else {
      // Whatever the answer said, the server's own state decides.
      let now: Map<string, IdRead> | null = null;
      try { now = await port.read(go.map(g => g.rid)); } catch { now = null; }
      for (const item of go) {
        const r = now?.get(item.rid);
        if (r && 'id' in r) {
          outcomes.set(item.rid, r.id === item.to ? { item, status: 'changed' }
            : r.id === item.from ? { item, status: 'failed', reason: commit?.error || 'The server did not change it' }
              : { item, status: 'unknown', reason: `It has the ID ${r.id} now` });
        } else {
          outcomes.set(item.rid, { item, status: 'unknown', reason: NOT_SAVED_UNKNOWN });
          stop = true;
        }
      }
      if (commit && !commit.ok) stop = true;
    }
  }
  return { outcomes: batch.map(item => outcomes.get(item.rid)!), stop };
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── the code ──────────────────────────────────────────────────────

/** A stored script holder: what the code copy holds of an object. */
export interface CodeHolder {
  rid: string;
  type: string;
  name: string;
  businessId: string;
  code: Readonly<Record<string, string>>;
}

/** The edit that puts `to` where the reference `ref` has its ID, or null. */
export function idEdit(text: string, ref: CodeRef, from: string, to: string): Edit | null {
  const at = ref.form === 'dot' ? ref.start + ref.ns.length + 1
    : ref.form === 'brace' ? ref.start + 1
      : ref.form === 'get' ? text.indexOf(from, ref.start + ref.ns.length + 4)
        : -1;
  if (at < ref.start || at + from.length > ref.end || text.slice(at, at + from.length) !== from) return null;
  return [at, at + from.length, to];
}

/**
 * The edits of every script that names a changed ID as a reference (code in
 * strings and comments is left alone, as code-refs reads it): `t.5612`,
 * `t.5612.expression`, `t.get("5612")`, `{5612}`.
 */
export function planCodeEdits(changed: readonly IdChange[], holders: readonly CodeHolder[]): ScriptChange[] {
  const byKey = new Map(changed.map(c => [`${c.space}.${c.from}`, c]));
  const out: ScriptChange[] = [];
  for (const h of holders) {
    for (const [prop, text] of Object.entries(h.code)) {
      if (!text || !isEcScriptProp(prop)) continue;
      const edits: Edit[] = [];
      for (const ref of findCodeRefs(text)) {
        const c = byKey.get(ref.key);
        if (!c) continue;
        const e = idEdit(text, ref, c.from, c.to);
        if (e) edits.push(e);
      }
      if (edits.length) out.push({ rid: h.rid, prop, type: h.type, name: h.name, businessId: h.businessId, opened: text, edits });
    }
  }
  return out;
}

/** Objects whose code names each key (`t.5612`): from the stored references. */
export function codeObjectCounts(cards: Iterable<{ rid: string; refs: ReadonlyArray<{ k: string }> }>, keys: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of cards) {
    for (const r of c.refs) {
      if (!keys.has(r.k)) continue;
      let s = out.get(r.k);
      if (!s) { s = new Set(); out.set(r.k, s); }
      s.add(c.rid);
    }
  }
  return out;
}

// ── the record, and changing back ─────────────────────────────────

/** What the last change of one workspace did: enough to change it back. */
export interface NumericIdsRecord {
  v: 1;
  environment: string;
  /** ISO time. */
  at: string;
  /** `ids`: the IDs changed and the code step has not finished; `done`. */
  phase: 'ids' | 'done';
  ids: IdChange[];
  /** The scripts that were saved. */
  code: ReplaceRecord['scripts'];
}

export const numericRecordKey = (environment: string): string => `crev_numeric_ids_undo:${environment}`;

export function buildNumericRecord(environment: string, outcomes: readonly IdOutcome[], saved: readonly ScriptResult[], phase: 'ids' | 'done', at: Date = new Date()): NumericIdsRecord | null {
  const ids = outcomes.filter(o => o.status === 'changed').map(o => o.item);
  if (!ids.length) return null;
  const code = saved.filter(r => r.status === 'saved').map(r => ({ rid: r.rid, prop: r.prop, type: r.type, name: r.name, businessId: r.businessId, before: r.before, edits: r.edits }));
  return { v: 1, environment, at: at.toISOString(), phase, ids, code };
}

export function readNumericRecord(value: unknown, environment: string): NumericIdsRecord | null {
  const r = value as NumericIdsRecord | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || r.environment !== environment || typeof r.at !== 'string' || !Array.isArray(r.ids) || !Array.isArray(r.code) || !(r.ids.length || r.code.length)) return null;
  for (const i of r.ids) {
    if (!i || typeof i.rid !== 'string' || typeof i.from !== 'string' || typeof i.to !== 'string' || typeof i.space !== 'string') return null;
  }
  for (const s of r.code) {
    if (!s || typeof s.rid !== 'string' || typeof s.prop !== 'string' || typeof s.before !== 'string' || !Array.isArray(s.edits)) return null;
  }
  return r;
}

export interface ChangeBackResult {
  ids: IdOutcome[];
  code: ScriptResult[];
  /** Scripts left as they are because an ID they name did not go back. */
  heldBack: number;
  /** What is still changed (null: nothing). */
  rest: NumericIdsRecord | null;
}

/**
 * Put the last change back: the IDs (an object whose ID is no longer the new
 * one is left), then the scripts that only name IDs that went back, where the
 * server still holds the text the change wrote.
 */
export async function changeBack(
  record: NumericIdsRecord,
  ids: IdWritePort,
  code: ReplacePort,
  opts: { signal?: AbortSignal; onStep?: (step: 'ids' | 'code') => void } = {},
): Promise<ChangeBackResult> {
  opts.onStep?.('ids');
  const reversed: IdChange[] = record.ids.map(i => ({ ...i, from: i.to, to: i.from }));
  const outcomes = await applyIdChanges(reversed, ids, opts.signal ? { signal: opts.signal } : {});
  const back = new Set(outcomes.filter(o => o.status === 'changed').map(o => o.item.rid));
  // `reversed` holds the new ID in `from`: the ones that did not go back keep their new name.
  const stillNew = new Set(outcomes.filter(o => o.status !== 'changed').map(o => o.item.from));
  const ready = record.code.filter(s => !s.edits.some(e => stillNew.has(e[2])));
  const heldBack = record.code.length - ready.length;
  let results: ScriptResult[] = [];
  if (ready.length) {
    opts.onStep?.('code');
    results = await undoReplace({ v: 1, environment: record.environment, at: record.at, find: '', replace: '', scripts: ready }, code);
  }
  const codeBack = new Set(results.filter(r => r.status === 'saved').map(r => `${r.rid}|${r.prop}`));
  const restIds = record.ids.filter(i => !back.has(i.rid));
  const restCode = record.code.filter(s => !codeBack.has(`${s.rid}|${s.prop}`));
  // Kept while an ID or a script is still changed.
  const rest: NumericIdsRecord | null = restIds.length || restCode.length ? { ...record, ids: restIds, code: restCode, phase: 'done' } : null;
  return { ids: outcomes, code: results, heldBack, rest };
}
