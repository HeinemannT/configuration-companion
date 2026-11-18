/**
 * "Used by": the one-line answer above the groups, from what the code copy,
 * the reference scan and the instance count found. It never says "unused":
 * IDs that code builds at run time cannot be found.
 *
 * Pure: no DOM, no chrome.*.
 */

export interface UseFacts {
  /** Objects whose code calls it; null when code was not checked. */
  inCode: readonly string[] | null;
  /** Referrers listed by the scan. */
  listed: readonly string[];
  /** Referrers counted by the scan, also past the list's cap. */
  total: number;
  /** Objects linked to it as their template; undefined when not counted. */
  instances?: number;
  /** The instances known by RID (the first few): one that the scan also lists counts once. */
  instanceRids?: readonly string[];
}

export interface UseSummary {
  found: boolean;
  headline: string;
  notes: string[];
}

const objects = (n: number) => `${n} ${n === 1 ? 'object' : 'objects'}`;

export function useSummary(f: UseFacts): UseSummary {
  const listed = new Set(f.listed);
  const total = Math.max(f.total, listed.size);
  const codeOnly = (f.inCode ?? []).filter(rid => !listed.has(rid)).length;
  // Past the cap the scan's count may already hold the objects found in code.
  const capped = total > listed.size;
  const linked = Math.max(0, (f.instances ?? 0) - (f.instanceRids ?? []).filter(rid => listed.has(rid)).length);
  const n = (capped ? total : total + codeOnly) + linked;
  const notes: string[] = [];
  if (f.instances) notes.push(`It is the template of ${objects(f.instances)}.`);
  if (!f.inCode) notes.push('Code was not checked.');
  if (!n) {
    notes.push('IDs that code builds at run time cannot be found.');
    return { found: false, headline: 'Nothing found that refers to this object.', notes };
  }
  const verb = n === 1 ? 'refers' : 'refer';
  return { found: true, headline: `${capped && codeOnly ? 'At least ' : ''}${objects(n)} ${verb} to this object.`, notes };
}
