/**
 * Change record: what the object window wrote to a server, with the value
 * before and after, newest last. One list per server profile in local
 * storage. It is a record only: nothing is read from the server for it and
 * nothing is written back from it.
 *
 * Bounded: the newest CHANGES_MAX records, each value cut at VALUE_MAX
 * characters (a cut value says so).
 */

import { log } from './logger';

export const CHANGES_MAX = 200;
export const VALUE_MAX = 2000;

/** One written property as the window reports it. */
export interface ChangeInput {
  rid: string;
  name?: string;
  businessId?: string;
  objectType?: string;
  prop: string;
  /** The property's label in the window. */
  label?: string;
  before: string;
  after: string;
  /** The override was reset to the template value (`after` is empty). */
  reset?: true;
  /** Sent, but the stored value could not be confirmed. */
  unchecked?: true;
}

export interface ChangeRecord extends ChangeInput {
  id: number;
  at: number;
  /** BMP user the write ran as. */
  actor?: string;
  /** Which values were cut at VALUE_MAX. */
  cut?: 'before' | 'after' | 'both';
}

export const changesKey = (profileId: string): string => `crev_${profileId}_changes`;

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

/** Validate and bound one reported change; null when it is not one. */
export function toRecord(input: unknown, id: number, at: number, actor?: string): ChangeRecord | null {
  const i = input as Partial<ChangeInput> | null;
  if (!i || typeof i.rid !== 'string' || !/^-?\d{1,20}$/.test(i.rid) || typeof i.prop !== 'string' || !i.prop || i.prop.length > 200) return null;
  if (typeof i.before !== 'string' || typeof i.after !== 'string') return null;
  const cutBefore = i.before.length > VALUE_MAX;
  const cutAfter = i.after.length > VALUE_MAX;
  const name = text(i.name, 400);
  const businessId = text(i.businessId, 400);
  const objectType = text(i.objectType, 200);
  const label = text(i.label, 400);
  return {
    id, at, rid: i.rid, prop: i.prop,
    ...(name ? { name } : {}), ...(businessId ? { businessId } : {}), ...(objectType ? { objectType } : {}), ...(label ? { label } : {}),
    before: i.before.slice(0, VALUE_MAX), after: i.after.slice(0, VALUE_MAX),
    ...(i.reset === true ? { reset: true as const } : {}),
    ...(i.unchecked === true ? { unchecked: true as const } : {}),
    ...(actor ? { actor } : {}),
    ...(cutBefore || cutAfter ? { cut: cutBefore && cutAfter ? 'both' as const : cutBefore ? 'before' as const : 'after' as const } : {}),
  };
}

/** `list` with `inputs` appended, cut to the newest CHANGES_MAX. */
export function appendChanges(list: readonly ChangeRecord[], inputs: readonly unknown[], at: number, actor?: string): ChangeRecord[] {
  let id = list.reduce((m, r) => Math.max(m, r.id), 0);
  const out = [...list];
  for (const input of inputs.slice(0, CHANGES_MAX)) {
    const rec = toRecord(input, id + 1, at, actor);
    if (rec) { out.push(rec); id++; }
  }
  return out.slice(-CHANGES_MAX);
}

/** Says when a value was cut; empty otherwise. */
export function cutNote(rec: ChangeRecord, side: 'before' | 'after'): string {
  return rec.cut === side || rec.cut === 'both' ? `Only the first ${VALUE_MAX} characters were kept.` : '';
}

// One writer at a time: a save reports several objects in a row.
let queue: Promise<unknown> = Promise.resolve();

export async function readChanges(profileId: string): Promise<ChangeRecord[]> {
  const key = changesKey(profileId);
  const got = await chrome.storage.local.get(key);
  const list = got[key] as ChangeRecord[] | undefined;
  return Array.isArray(list) ? list : [];
}

export function recordChanges(profileId: string, inputs: readonly unknown[], actor?: string): Promise<ChangeRecord[]> {
  const run = queue.then(async () => {
    const next = appendChanges(await readChanges(profileId), inputs, Date.now(), actor);
    await chrome.storage.local.set({ [changesKey(profileId)]: next });
    return next;
  });
  queue = run.catch(e => log.swallow('changes:record', e));
  return run;
}

export function clearChanges(profileId: string): Promise<void> {
  const run = queue.then(() => chrome.storage.local.remove(changesKey(profileId)));
  queue = run.catch(e => log.swallow('changes:clear', e));
  return run;
}
