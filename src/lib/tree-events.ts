/**
 * BMP's change feed (`TreeEventCommand`): the command Config Studio polls to
 * keep its tree current. No Extended Code, no script text.
 *
 * What the server does with it (verified live on BMP 5.6.9.2 and 5.6.17.6):
 *  - The request is a record with one primitive long, `lastEventPackId`
 *    (serialVersionUID 0).
 *  - `-1` answers one empty pack whose id is a fresh watermark (the call
 *    itself takes an id). `n` answers every pack stored after `n`. Stateless
 *    and global (no listener, no session state); the packs are built with the
 *    caller's access.
 *  - The answer is an ArrayList of `TreeEventPack`: `packId` (long),
 *    `propertiesChanged` (type definitions changed), and the lists
 *    `addEvents` (parentRid, rid), `deleteEvents` (rid), `relocateEvents`
 *    (rid, parentRid, oldParentId), `reorderEvents` (parentRid, childRids),
 *    `updateEvents` (rid). Only RIDs: no type, no property, no time.
 *  - Packs are kept for about 60 to 120 s. There is no gap signal: an old
 *    watermark gets whatever is left. Pack ids have holes (every `-1` by any
 *    client takes one), so only time can tell that events may be lost.
 *  - An edit of a code property gives one pack with one update event for the
 *    edited object's own RID, about 30 ms after the save answered.
 *  - Blind spots: an object added outside its parent's "children" slot is
 *    announced only as an update of the parent; a template edit does not
 *    announce the objects linked to it.
 *
 * The generic reader decodes the answer from the stream's own descriptors;
 * only the request class is registered. RIDs and pack ids are Java longs:
 * strings end to end here, never JS numbers. Pure: no chrome.*, no transport.
 */

import { registerType, SC_SERIALIZABLE, type JavaClassDesc } from './java-serial';
import { registerBmpTypes } from './bmp-types';

export const TREE_EVENT_COMMAND_CLASS = 'com.corporater.bmp.dto.command.tree.TreeEventCommand';

/** A record (serialVersionUID 0) with one primitive long. */
export const TREE_EVENT_COMMAND: JavaClassDesc = {
  name: TREE_EVENT_COMMAND_CLASS, uid: 0n, flags: SC_SERIALIZABLE,
  fields: [{ name: 'lastEventPackId', type: 'J' }],
  parent: null,
};

let registered = false;
/** Idempotent. */
export function registerTreeEventCommand(): void {
  if (registered) return;
  registerBmpTypes();
  registerType({ desc: TREE_EVENT_COMMAND });
  registered = true;
}

const LONG_TEXT = /^-?\d{1,20}$/;

/** A pack id (or -1) as a Java long, range-checked. Never through a JS number. */
export function packIdLong(id: string): bigint {
  if (!LONG_TEXT.test(id)) throw new Error(`Not a pack id: ${id}`);
  const n = BigInt(id);
  if (n > 9223372036854775807n || n < -9223372036854775808n) throw new Error(`Pack id out of range: ${id}`);
  return n;
}

/** One TreeEventCommand: every pack after `lastPackId` ('-1': a fresh watermark). */
export function makeTreeEventCommand(lastPackId: string): Record<string, unknown> {
  return { $type: TREE_EVENT_COMMAND_CLASS, lastEventPackId: packIdLong(lastPackId) };
}

// ── answer ──────────────────────────────────────────────────────

interface Obj { $class?: string; [k: string]: unknown }
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** A long as the reader gives it: a bigint (primitive field), a boxed
 *  `java.lang.Long` (`{ value }`), a Rid (`{ identifier }`). */
function longText(v: unknown): string | null {
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'string' && LONG_TEXT.test(v)) return v;
  if (isObj(v)) {
    for (const k of ['value', 'identifier'] as const) {
      const x = v[k];
      if (typeof x === 'bigint') return String(x);
      if (typeof x === 'string' && LONG_TEXT.test(x)) return x;
    }
  }
  return null;
}

/** A list as the reader gives it: an ArrayList (`$elements`), an immutable
 *  list's proxy (`$elements`, or a `delegate`), a plain array. */
function listItems(v: unknown, depth = 0): unknown[] {
  if (Array.isArray(v)) return v;
  if (!isObj(v) || depth > 3) return [];
  if (Array.isArray(v.$elements)) return v.$elements;
  if (v.delegate !== undefined) return listItems(v.delegate, depth + 1);
  return [];
}

const rids = (list: unknown, field: string): string[] =>
  listItems(list).flatMap(e => { const r = isObj(e) ? longText(e[field]) : null; return r ? [r] : []; });

export interface TreeEventPack {
  packId: string;
  propertiesChanged: boolean;
  /** Objects added in a "children" slot, with their parent. */
  added: Array<{ rid: string; parent: string | null }>;
  deleted: string[];
  /** Objects moved, with the new and the old parent. */
  relocated: Array<{ rid: string; parent: string | null; oldParent: string | null }>;
  /** Parents whose children were reordered. */
  reordered: string[];
  updated: string[];
}

export type TreeEventAnswer =
  | { ok: true; packs: TreeEventPack[] }
  | { ok: false; message: string; stackTrace?: string };

const FAILURE = /ExceptionResponse$|Exception$|Error$/;

/** The objects of one TreeEventCommand answer. Every TreeEventPack is
 *  collected wherever the stream holds it (inside the answer list and its
 *  response wrapper); an exception object is the failure. */
export function decodeTreeEvents(objects: readonly unknown[]): TreeEventAnswer {
  const packs: TreeEventPack[] = [];
  const seen = new Set<unknown>();
  let failure: { message: string; stackTrace?: string } | null = null;
  const walk = (o: unknown, depth: number): void => {
    if (!isObj(o) || seen.has(o) || depth > 8 || failure) return;
    seen.add(o);
    const cls = String(o.$class ?? '');
    if (FAILURE.test(cls)) {
      failure = { message: String(o.message ?? o.detailMessage ?? cls), ...(typeof o.stackTrace === 'string' ? { stackTrace: o.stackTrace } : {}) };
      return;
    }
    if (cls.endsWith('.TreeEventPack')) {
      const packId = longText(o.packId);
      if (packId == null) return;
      packs.push({
        packId,
        propertiesChanged: o.propertiesChanged === true,
        added: listItems(o.addEvents).flatMap(e => { const r = isObj(e) ? longText(e.rid) : null; return r && isObj(e) ? [{ rid: r, parent: longText(e.parentRid) }] : []; }),
        deleted: rids(o.deleteEvents, 'rid'),
        relocated: listItems(o.relocateEvents).flatMap(e => { const r = isObj(e) ? longText(e.rid) : null; return r && isObj(e) ? [{ rid: r, parent: longText(e.parentRid), oldParent: longText(e.oldParentId) }] : []; }),
        reordered: rids(o.reorderEvents, 'parentRid'),
        updated: rids(o.updateEvents, 'rid'),
      });
      return;
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
      else walk(v, depth + 1);
    }
  };
  for (const o of objects) walk(o, 0);
  if (failure) return { ok: false, ...(failure as { message: string; stackTrace?: string }) };
  packs.sort((a, b) => (BigInt(a.packId) < BigInt(b.packId) ? -1 : BigInt(a.packId) > BigInt(b.packId) ? 1 : 0));
  return { ok: true, packs };
}

/** What a failed answer means for the command: `unsupported` when the
 *  server does not know the class or speaks another form of it. */
export function classifyTreeEventFailure(message: string, stackTrace = ''): 'unsupported' | 'failed' {
  const text = `${message}\n${stackTrace}`;
  if (/local class incompatible/i.test(text)) return 'unsupported';
  if (/ClassNotFoundException/.test(text) && text.includes('TreeEventCommand')) return 'unsupported';
  if (message.trim() === TREE_EVENT_COMMAND_CLASS) return 'unsupported';
  return 'failed';
}

/** The larger of two pack ids (as text). */
export function laterPackId(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}
