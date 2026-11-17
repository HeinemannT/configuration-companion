import type { EcResult } from './bmp-client';
import type { ObjectReference } from './types';

const ACTIVITY_DETAIL_LIMIT = 4_000;

export function boundedActivityDetail(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= ACTIVITY_DETAIL_LIMIT
    ? text
    : `${text.slice(0, ACTIVITY_DETAIL_LIMIT)}\n… output truncated`;
}

/** Keep actual BMP output useful without copying noisy WARNING entries or source code into storage. */
export function ecActivityDetail(result: EcResult): string | undefined {
  const entries = result.outputEntries
    ?.filter(entry => entry.logType.toUpperCase() !== 'WARNING')
    .map(entry => `${entry.result ? 'RESULT' : entry.logType || 'OUTPUT'}: ${entry.message}`);
  if (entries?.length) return boundedActivityDetail(entries.join('\n'));
  // When BMP supplied structured entries, never fall back to the flattened
  // log: it would re-introduce warnings that were deliberately filtered.
  if (!result.ok) {
    return boundedActivityDetail(result.error || (result.outputEntries?.length ? undefined : result.log));
  }
  return undefined;
}

/** The object of an activity entry: what the worker's cache knows, else what
 *  the sending window knew (`known`, display only). The RID stays in the
 *  entry's metadata. */
export function activityObject(
  rid: string,
  cached?: { businessId?: string; name?: string; type?: string } | null,
  known?: { businessId?: string; name?: string; type?: string },
): ObjectReference {
  const businessId = cached?.businessId || known?.businessId;
  const name = cached?.name || known?.name;
  const type = cached?.type || known?.type;
  return {
    rid,
    ...(businessId ? { businessId } : {}),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
  };
}

const RID_SHAPED = /^-?\d{4,}$/;

/** The object as the Log sentence names it: name (and type), else its ID
 *  (and type), else its type. Never a bare RID: an RID-shaped fallback is
 *  replaced by "a <type>" / "an object". */
export function activityObjectLabel(object: ObjectReference | undefined, fallback: string): string {
  const who = object?.name || object?.businessId;
  if (who) return object?.type ? `${who} (${object.type})` : who;
  if (RID_SHAPED.test(fallback.trim())) return object?.type ? `a ${object.type}` : 'an object';
  return fallback;
}
