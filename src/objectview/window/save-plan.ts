/**
 * Object window — turn the draft into calls on the EXISTING write routes and
 * run them object by object.
 *
 *  - pane properties, gates, override resets → one APPLY_OBJECT_CHANGES per
 *    object (the service worker keeps its allowlist and EC escaping);
 *  - expressions → one SAVE_PROPERTY per property;
 *  - name / business ID → one SAVE_IDENTITY per object (preview, write,
 *    read back), run last so the object's other writes resolve it first.
 *    Only the edited field is sent, with the value it was opened with.
 *
 * Changed since opened: before an object's first write, its current values
 * are read once (`SavePort.check`) and compared with the values the draft
 * started from (`base`). A difference holds the whole object back; the other
 * objects still save. An object with only identity edits needs no extra
 * read: SAVE_IDENTITY's own first read makes the comparison. Nor does an
 * object whose only other write is one custom post: it carries the opened
 * values (`expect`) and the worker compares them with the object read its
 * gate makes anyway, before it writes.
 *
 * Every object saves to its own rid. The root's template is an object of its
 * own in the draft, so template edits save to the template rid.
 *
 * Guard: an entry whose property the object read did not return, or that
 * the edit policy does not allow, is never sent. It stays in the draft and
 * the object reports why.
 *
 * Pure: no DOM, no chrome.*. The port is supplied by the caller.
 */

import type { FullObject, PropValue, ValueKind } from '../../lib/object-read';
import { buildChangesPayload, paneValueEquals } from '../../lib/pane-edit';
import { findPropDef } from '../../lib/pane-schema';
import { compareOpened, type BaseCheck, type ValueChange } from '../../lib/save-check';
import { baseText, editability, type CustomEntry, type DraftEntry, type DraftItem } from './draft';
import {
  ABSENT, changeLineSize, isEditKind, isReferenceKind, MAX_CUSTOM_CHANGES, SCRIPT_HEAD, storedEquals, storedValue,
  type CustomChange, type EditKind,
} from '../../lib/property-schema';
import { isCustomKey } from '../../lib/object-window-table';

/** Characters one custom write may use (the service worker refuses a
 *  script over the user-script limit of 25,000; script-kinds.ts). */
export const CUSTOM_WRITE_BUDGET = 25_000 - SCRIPT_HEAD;

export interface IdentityFields { name?: string; businessId?: string }

export type SaveStep =
  | { route: 'APPLY_OBJECT_CHANGES'; rid: string; changes: Record<string, string | number | boolean>; resetProps: string[] }
  | { route: 'SAVE_PROPERTY'; rid: string; objectType: string; property: string; value: string; valueKind?: ValueKind }
  // Custom properties: the service worker checks each change again.
  // `expect`: the opened values, checked by the worker against the object it
  // reads for its gate (the object's only write step: no separate read).
  | { route: 'APPLY_CUSTOM_CHANGES'; rid: string; changes: CustomChange[]; expect?: Record<string, string> }
  // Only the edited fields; `expect` holds their opened values (absent on Overwrite).
  | ({ route: 'SAVE_IDENTITY'; rid: string; expect?: IdentityFields } & IdentityFields);

export interface PlannedStep {
  step: SaveStep;
  /** Draft entries this step writes. */
  entries: Array<{ prop: string; entry: DraftEntry }>;
}

export interface ObjectPlan {
  rid: string;
  steps: PlannedStep[];
  /** Entries that are not sent, with the reason. */
  rejected: Array<{ prop: string; reason: string }>;
  /** Opened value (`base`) of every entry that is sent, by property. */
  opened: Record<string, string>;
  /** Kind of every custom property in `opened`: the check reads its stored
   *  value by kind (a list item's RID lives in `references`, an unset
   *  property is absent). */
  kinds: Record<string, EditKind>;
}

export const NOT_IN_READ = 'This BMP version did not return the property, so it is not written.';
export const NOT_EDITABLE = 'This property is not editable in the object window.';
export const NOT_LOADED = 'The object is not loaded, so its changes are not written.';
export const TOO_LARGE = 'This value is too large to write in one step.';

/** The business ID of list item `item` of definition `definition`, or of
 *  object `item` of a reference property (sizes its pre-lookup reference). */
export type ItemIdOf = (definition: string, item: string) => string | undefined;

/** Split custom changes into posts that each fit the write budget and the
 *  worker's count limit, in draft order. A single change over the budget is
 *  not sent. Each change counts with the size of the line the gate builds
 *  (changeLineSize). */
export function splitCustom(entries: ReadonlyArray<{ prop: string; entry: CustomEntry }>, budget = CUSTOM_WRITE_BUDGET, maxCount = MAX_CUSTOM_CHANGES, itemId?: ItemIdOf): {
  posts: Array<Array<{ prop: string; entry: CustomEntry }>>; oversized: string[];
} {
  const posts: Array<Array<{ prop: string; entry: CustomEntry }>> = [];
  const oversized: string[] = [];
  let cur: Array<{ prop: string; entry: CustomEntry }> = [];
  let size = 0;
  for (const it of entries) {
    const { definition, valueKind } = it.entry;
    // A list item by its one business ID; each object of a reference value by its own.
    const id = valueKind === 'listItem' ? itemId?.(definition, it.entry.value)
      : isReferenceKind(valueKind) ? (rid: string) => itemId?.(definition, rid) : undefined;
    const n = changeLineSize({ accessor: it.entry.accessor, value: it.entry.value, kind: valueKind }, id) + 1;
    if (n > budget) { oversized.push(it.prop); continue; }
    if (cur.length && (size + n > budget || cur.length >= maxCount)) { posts.push(cur); cur = []; size = 0; }
    cur.push(it);
    size += n;
  }
  if (cur.length) posts.push(cur);
  return { posts, oversized };
}

export function planSave(
  items: readonly DraftItem[],
  objects: Readonly<Record<string, FullObject>>,
  opts: { itemId?: (rid: string, definition: string, item: string) => string | undefined } = {},
): ObjectPlan[] {
  const byRid = new Map<string, DraftItem[]>();
  for (const it of items) byRid.set(it.rid, [...(byRid.get(it.rid) ?? []), it]);
  const plans: ObjectPlan[] = [];
  for (const [rid, list] of byRid) {
    const obj = objects[rid];
    const plan: ObjectPlan = { rid, steps: [], rejected: [], opened: {}, kinds: {} };
    plans.push(plan);
    if (!obj) {
      for (const it of list) plan.rejected.push({ prop: it.prop, reason: NOT_LOADED });
      continue;
    }
    const values: Record<string, string> = {};
    const resets: string[] = [];
    const propEntries: PlannedStep['entries'] = [];
    const code: PlannedStep[] = [];
    const identity: PlannedStep['entries'] = [];
    const custom: Array<{ prop: string; entry: CustomEntry }> = [];
    for (const { prop, entry } of list) {
      if (entry.kind === 'custom') {
        // A custom property may be absent from the read (not set); the
        // service worker decides whether it may be written.
        if (!isCustomKey(prop) || entry.definition !== prop || !isEditKind(entry.valueKind)) { plan.rejected.push({ prop, reason: NOT_EDITABLE }); continue; }
        custom.push({ prop, entry });
        continue;
      }
      if (!Object.hasOwn(obj.props, prop)) { plan.rejected.push({ prop, reason: NOT_IN_READ }); continue; }
      const how = editability(obj, prop);
      if (!how || (entry.kind === 'reset' && how.route !== 'props')) { plan.rejected.push({ prop, reason: NOT_EDITABLE }); continue; }
      plan.opened[prop] = entry.base;
      if (how.route === 'identity' && entry.kind === 'value') identity.push({ prop, entry });
      else if (how.route === 'code' && entry.kind === 'value') {
        code.push({
          step: { route: 'SAVE_PROPERTY', rid, objectType: obj.type, property: prop, value: entry.value, valueKind: obj.props[prop].kind },
          entries: [{ prop, entry }],
        });
      } else if (entry.kind === 'reset') {
        resets.push(prop);
        propEntries.push({ prop, entry });
      } else {
        values[prop] = entry.value;
        propEntries.push({ prop, entry });
      }
    }
    if (propEntries.length) {
      const changes = buildChangesPayload(values);
      // Gates are not in the pane schema; send them as real booleans.
      for (const p of Object.keys(values)) if (editability(obj, p)?.gate) changes[p] = values[p] === 'true';
      plan.steps.push({ step: { route: 'APPLY_OBJECT_CHANGES', rid, changes, resetProps: resets }, entries: propEntries });
    }
    const { posts, oversized } = splitCustom(custom, undefined, undefined, opts.itemId ? (d, i) => opts.itemId!(rid, d, i) : undefined);
    for (const prop of oversized) plan.rejected.push({ prop, reason: TOO_LARGE });
    for (const post of posts) {
      for (const { prop, entry } of post) { plan.opened[prop] = entry.base; plan.kinds[prop] = entry.valueKind; }
      plan.steps.push({
        step: { route: 'APPLY_CUSTOM_CHANGES', rid, changes: post.map(({ entry }) => ({ definition: entry.definition, accessor: entry.accessor, kind: entry.valueKind, value: entry.value })) },
        entries: post,
      });
    }
    plan.steps.push(...code);
    // The object's only write besides identity is one custom post: the
    // changed-since-opened check rides in it (the worker compares the
    // object read it makes for its gate), so no read of its own is needed.
    if (plan.steps.length === 1 && plan.steps[0].step.route === 'APPLY_CUSTOM_CHANGES') {
      const only = plan.steps[0].step;
      only.expect = Object.fromEntries(only.changes.map(c => [c.definition, plan.opened[c.definition]]));
    }
    if (identity.length) {
      // Only the edited fields: an untouched name or ID keeps what BMP holds.
      const fields: IdentityFields = {};
      const expect: IdentityFields = {};
      for (const { prop, entry } of identity) {
        if (entry.kind !== 'value') continue;
        const key = prop === 'id' ? 'businessId' : 'name';
        fields[key] = entry.value;
        expect[key] = entry.base;
      }
      plan.steps.push({ step: { route: 'SAVE_IDENTITY', rid, ...fields, expect }, entries: identity });
    }
  }
  return plans;
}

export interface SaveOutcome {
  ok: boolean;
  error?: string;
  /** True when the route refused the step before any write was sent
   *  (validation, lost connection, switched workspace). */
  notSent?: boolean;
  /** The write's answer did not arrive: BMP may have applied it. */
  unknown?: boolean;
  /** SAVE_IDENTITY found the edited field changed in BMP (nothing written).
   *  `prop` is the draft property (`name`, `id`). */
  conflict?: ValueChange[];
  /** The service worker refused these properties (property → reason). */
  propErrors?: Record<string, string>;
  /** The object as the route read it for its own check (a conflict). */
  object?: FullObject;
}

/** The window's line for a write whose answer did not arrive. */
export const LOST_RESPONSE = 'No response from the extension. BMP may have saved; the object was re-read.';

/** Chrome's errors for a message that never reached the service worker. */
const NOT_DELIVERED = /Could not establish connection|Receiving end does not exist/i;

/**
 * The outcome of an APPLY_CUSTOM_CHANGES request that threw in the window
 * (messaging.ts sendRequestBounded):
 *  - a REQUEST_FAILED reply (`runtime`, no cause): the worker refused the
 *    message before its handler answered (sender check, route, or a throw
 *    before the write; the handler answers every write it sends itself).
 *    Nothing was sent: "Not saved: <reason>" on every row of the post;
 *  - Chrome could not deliver the message at all: not sent either;
 *  - a time-out, no answer, or anything else: the request went out and its
 *    answer was lost, so BMP may have saved (re-read decides).
 */
export function customRequestFailure(e: unknown, changes: readonly Pick<CustomChange, 'definition'>[]): SaveOutcome {
  const err = e as { name?: unknown; kind?: unknown; cause?: unknown; message?: unknown } | null;
  const runtime = !!err && err.name === 'RuntimeRequestError' && err.kind === 'runtime';
  const message = typeof err?.message === 'string' && err.message ? err.message : 'The request was refused';
  const causeText = err?.cause instanceof Error ? err.cause.message : '';
  if (runtime && (err.cause === undefined || NOT_DELIVERED.test(causeText))) {
    const propErrors: Record<string, string> = {};
    for (const c of changes) propErrors[c.definition] ??= message;
    return { ok: false, notSent: true, error: message, ...(changes.length ? { propErrors } : {}) };
  }
  return { ok: false, error: LOST_RESPONSE, unknown: true };
}

/** The changed-since-opened check of one object, with the object as read
 *  (the review then shows it without another request). */
export type ObjectCheck = BaseCheck & { object?: FullObject };

export interface SavePort {
  run(step: SaveStep): Promise<SaveOutcome>;
  /** One read of the object, compared with the opened values. Without it no
   *  check is made (today's behaviour). */
  check?(rid: string, opened: Readonly<Record<string, string>>, kinds?: Readonly<Record<string, EditKind>>): Promise<ObjectCheck>;
}

/** Compare an object read with the values the draft opened. Both sides come
 *  from the same object read, so the text compares exactly ('' = missing). */
export function checkAgainstRead(
  opened: Readonly<Record<string, string>>,
  fresh: FullObject | undefined,
  error?: string,
  kinds: Readonly<Record<string, EditKind>> = {},
): ObjectCheck {
  if (!fresh) return { state: 'unreadable', error: error ?? 'The object could not be read.' };
  // Custom properties by kind, from `props` or `references`, ABSENT when
  // not set; built-ins as their text, as before.
  const read = (prop: string) => (kinds[prop] ? storedValue(fresh, prop, kinds[prop]) : baseText(fresh.props[prop]));
  const equal = (prop: string, a: string, b: string) => a === b
    || (!!kinds[prop] && a !== ABSENT && b !== ABSENT && storedEquals(kinds[prop], a, b));
  return { ...compareOpened(opened, read, equal), object: fresh };
}

/** Whether the re-read stores what a custom entry sent, compared by kind
 *  (a list item or single reference by its RID in `references`, a list of
 *  references as a set of RIDs; "not set" never matches a sent value). The
 *  server can answer ok without writing: only this read decides "saved".
 *  Never equal by default. */
export function customStored(entry: CustomEntry, prop: string, fresh: FullObject): boolean {
  return storedEquals(entry.valueKind, entry.value, storedValue(fresh, prop, entry.valueKind));
}

/** Whether a stored value is what was sent. Numbers compare as numbers and
 *  enum members by name (the pane's own rule); identity values are trimmed
 *  as the identity save trims them. A value the read cannot render as text
 *  (`unknown`, `list`: colour links and other objects) is not comparable and
 *  counts as stored. */
export function readBackEquals(prop: string, sent: string, stored: PropValue | undefined): boolean {
  if (stored && (stored.kind === 'unknown' || stored.kind === 'list')) return true;
  const text = baseText(stored);
  if (prop === 'name' || prop === 'id') return text.trim() === sent.trim();
  const kind = findPropDef(prop)?.kind;
  if ((kind === 'number' || kind === 'slider') && text !== '' && sent !== '') return Number(text) === Number(sent);
  if (stored?.kind === 'boolean') return text === String(sent === 'true' || sent === 'TRUE');
  return text === sent || paneValueEquals(prop, text, sent);
}

export interface ObjectResult {
  rid: string;
  /** Entries that were written. */
  saved: Array<{ prop: string; entry: DraftEntry }>;
  /** Nothing was written to this object: its values changed in BMP since it
   *  was opened, or the check could not read them. The user decides. */
  held?: ObjectCheck;
  /** Properties the service worker refused, with its reason. */
  propErrors?: Record<string, string>;
  /** Entries of the write whose answer did not arrive (may be stored). */
  unknown?: Array<{ prop: string; entry: DraftEntry }>;
  /** True when at least one write was sent to BMP (the object must be re-read).
   *  A step refused locally (`notSent`) does not count. */
  attempted: boolean;
  /** True when `error` is a local refusal: the step that stopped this object
   *  (or a rejected entry) was not sent at all. Absent with `error` means a
   *  write was sent and failed, or its outcome is unknown. */
  refused?: boolean;
  error?: string;
}

/** Run the plans. Objects run one after another (the transport serialises
 *  posts anyway); inside an object the first failed step stops that object,
 *  so its remaining entries stay in the draft.
 *
 *  Each object is first checked against its opened values (one read) unless
 *  it has only identity edits or `force` is set (Overwrite / Save anyway). A
 *  held object writes nothing; the other objects go on. */
export async function runSave(
  plans: readonly ObjectPlan[],
  port: SavePort,
  options: { force?: boolean } = {},
): Promise<ObjectResult[]> {
  const results: ObjectResult[] = [];
  for (const plan of plans) {
    const result: ObjectResult = { rid: plan.rid, saved: [], attempted: false };
    results.push(result);
    // Identity, and a custom post that carries `expect`, make their own check.
    const needsCheck = !options.force && !!port.check
      && plan.steps.some(s => s.step.route !== 'SAVE_IDENTITY' && !(s.step.route === 'APPLY_CUSTOM_CHANGES' && s.step.expect));
    if (needsCheck) {
      let check: ObjectCheck;
      try {
        check = await port.check!(plan.rid, plan.opened, plan.kinds);
      } catch (e) {
        check = { state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
      }
      if (check.state !== 'unchanged') {
        result.held = check;
        result.refused = true;
        continue;
      }
    }
    for (const { step: planned, entries } of plan.steps) {
      const step: SaveStep = options.force && planned.route === 'SAVE_IDENTITY'
        ? { route: 'SAVE_IDENTITY', rid: planned.rid,
          ...(planned.name !== undefined ? { name: planned.name } : {}),
          ...(planned.businessId !== undefined ? { businessId: planned.businessId } : {}) }
        // Overwrite: the custom post goes without its opened values.
        : options.force && planned.route === 'APPLY_CUSTOM_CHANGES'
          ? { route: 'APPLY_CUSTOM_CHANGES', rid: planned.rid, changes: planned.changes }
          : planned;
      let outcome: SaveOutcome;
      try {
        outcome = await port.run(step);
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (outcome.conflict?.length) {
        result.held = { state: 'changed', changes: outcome.conflict, ...(outcome.object ? { object: outcome.object } : {}) };
        result.refused = !result.attempted;
        break;
      }
      const refused = !outcome.ok && outcome.notSent === true;
      if (!refused) result.attempted = true;
      if (outcome.propErrors) result.propErrors = { ...result.propErrors, ...outcome.propErrors };
      if (!outcome.ok) {
        result.error = outcome.error || 'Save failed';
        if (refused) result.refused = true;
        if (outcome.unknown) result.unknown = entries;
        break;
      }
      result.saved.push(...entries);
    }
    if (result.held) continue;
    if (!result.error && plan.rejected.length) {
      result.error = plan.rejected[0].reason;
      result.refused = true;
    }
  }
  return results;
}
