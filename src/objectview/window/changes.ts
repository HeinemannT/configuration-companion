/**
 * Object window: what a save reports to the change record
 * (lib/change-record.ts). One entry per property that was sent: the value
 * the window opened, the value it wrote, and whether the re-read confirmed
 * it. A write that the re-read shows as not stored is left out.
 *
 * Pure: no DOM, no chrome.*.
 */

import type { ChangeInput } from '../../lib/change-record';
import type { FullObject } from '../../lib/object-read';
import type { DraftEntry } from './draft';
import { customStored, readBackEquals, type ObjectResult } from './save-plan';

type Sent = { prop: string; entry: DraftEntry };

/** Whether the re-read holds what was sent; undefined when it cannot tell. */
function stored(prop: string, entry: DraftEntry, obj: FullObject | undefined): boolean | undefined {
  if (!obj) return undefined;
  if (entry.kind === 'custom') return customStored(entry, prop, obj);
  if (entry.kind === 'value') return readBackEquals(prop, entry.value, obj.props[prop]);
  return true;
}

export function changeInputs(
  results: readonly ObjectResult[],
  fresh: Readonly<Record<string, FullObject>>,
  objects: Readonly<Record<string, FullObject>>,
  label: (rid: string, prop: string) => string,
  /** A value as the window shows it (a list item's name instead of its RID). */
  shown: (rid: string, prop: string, entry: DraftEntry, value: string) => string,
): ChangeInput[] {
  const out: ChangeInput[] = [];
  for (const r of results) {
    const o = objects[r.rid];
    const add = ({ prop, entry }: Sent, lost: boolean) => {
      const ok = stored(prop, entry, fresh[r.rid]);
      // A lost answer that the re-read shows as not stored was not a change.
      if (lost && ok === false) return;
      out.push({
        rid: r.rid,
        ...(o?.name ? { name: o.name } : {}), ...(o?.businessId ? { businessId: o.businessId } : {}), ...(o?.type ? { objectType: o.type } : {}),
        prop, label: label(r.rid, prop),
        before: shown(r.rid, prop, entry, entry.base),
        after: entry.kind === 'reset' ? '' : shown(r.rid, prop, entry, entry.value),
        ...(entry.kind === 'reset' ? { reset: true as const } : {}),
        ...(ok ? {} : { unchecked: true as const }),
      });
    };
    for (const s of r.saved) add(s, false);
    for (const s of r.unknown ?? []) add(s, true);
  }
  return out;
}
