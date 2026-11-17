/**
 * Object window — reference values (one object, one user or group, a list
 * of objects) in words, and the state of their allowed objects.
 *
 * A reference value is property-schema's canonical string: one RID, the RIDs
 * of a list joined with commas (in the order the user built, the order of
 * the write), or ABSENT. A list compares as a set (`sameReferences`), so the
 * review lists what is added and removed, never a reordering.
 *
 * Names come from the property's allowed objects (RID, ID, name) and, for
 * objects outside that set, from the window's object summaries; an object
 * known to neither shows its RID.
 *
 * Pure: no DOM, no chrome.*.
 */

import type { ObjectSummary } from '../../lib/object-read';
import { ABSENT, referenceRids, type ListItem } from '../../lib/property-schema';
import { NOT_SET } from './prop-sections';

/** The allowed objects of one reference row (one object, one definition),
 *  read on demand through FETCH_ALLOWED_OBJECTS and kept for the window's
 *  life until an explicit refresh.
 *  - `loading`: the read is under way (`items` keeps an earlier answer);
 *  - `done`: `items` (at most LIST_ITEMS_MAX); `tooMany`: there are more,
 *    the row is read-only (REASON_TEXT['list-too-long']); `stale`: the
 *    object was saved since (the set depends on its data): the names still
 *    serve, the next loadAllowed reads the set again;
 *  - `error`: the read failed; the row cannot be edited until a retry. */
export type AllowedObjectsState =
  | { phase: 'loading'; items?: ListItem[] }
  | { phase: 'done'; items: ListItem[]; tooMany?: boolean; stale?: boolean }
  | { phase: 'error'; error: string };

/** The key of a row's allowed objects in `WindowModel.allowed`. */
export function allowedKey(rid: string, definition: string): string {
  return `${rid}:${definition}`;
}

/** One object of a reference value, named. `known`: false when neither the
 *  allowed objects nor the summaries know it (name and ID are then empty). */
export interface RefName {
  rid: string;
  name: string;
  id: string;
  known: boolean;
}

/** Name an object: allowed objects first, then the object summaries. */
export function refName(rid: string, items?: readonly ListItem[], summaries?: Readonly<Record<string, ObjectSummary>>): RefName {
  const item = items?.find(i => i.rid === rid);
  if (item) return { rid, name: item.name, id: item.id, known: true };
  const s = summaries?.[rid];
  if (s) return { rid, name: s.name, id: s.businessId, known: true };
  return { rid, name: '', id: '', known: false };
}

/** An object in words: "Name (ID)", the name or the ID alone when the other
 *  is empty, the RID when neither is known. */
export function refLabel(r: RefName): string {
  if (r.name && r.id && r.name !== r.id) return `${r.name} (${r.id})`;
  return r.name || r.id || r.rid;
}

/** A reference value in words: the objects as "Name (ID)", comma-separated,
 *  or "Not set". */
export function referenceText(value: string, items?: readonly ListItem[], summaries?: Readonly<Record<string, ObjectSummary>>): string {
  const rids = referenceRids(value);
  return rids.length ? rids.map(r => refLabel(refName(r, items, summaries))).join(', ') : NOT_SET;
}

/** What a change of a reference value does: objects added and removed (in
 *  the order of the new and the old value), and how many stay. */
export interface RefDiff {
  added: RefName[];
  removed: RefName[];
  kept: number;
}

export function referenceDiff(base: string, value: string, items?: readonly ListItem[], summaries?: Readonly<Record<string, ObjectSummary>>): RefDiff {
  const from = referenceRids(base);
  const to = referenceRids(value);
  const had = new Set(from);
  const has = new Set(to);
  return {
    added: [...new Set(to.filter(r => !had.has(r)))].map(r => refName(r, items, summaries)),
    removed: [...new Set(from.filter(r => !has.has(r)))].map(r => refName(r, items, summaries)),
    kept: [...has].filter(r => had.has(r)).length,
  };
}

/** The lines of a list change: `+ Name (ID)` per added object, then
 *  `− Name (ID)` (U+2212) per removed one. */
export function refDiffLines(diff: RefDiff): string[] {
  return [...diff.added.map(r => `+ ${refLabel(r)}`), ...diff.removed.map(r => `− ${refLabel(r)}`)];
}

/** Stored RIDs of a reference value that the allowed objects do not hold
 *  (no longer allowed for this object): a save that keeps them is refused
 *  by the gate ("Not one of the objects this property allows"). Empty
 *  while the allowed objects are not loaded. */
export function outsideAllowed(value: string, allowed: AllowedObjectsState | undefined): string[] {
  if (allowed?.phase !== 'done' || value === ABSENT) return [];
  const ok = new Set(allowed.items.map(i => i.rid));
  return referenceRids(value).filter(r => !ok.has(r));
}
