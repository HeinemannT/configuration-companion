import type { ObjectReference } from '../types';

/** Navigation only: opening Access must never submit or apply a change. */
export type AccessDestination =
  | { kind: 'role'; rid: string }
  | { kind: 'policy'; rid: string; statement?: number }
  | { kind: 'test'; object: { rid: string; id?: string; name?: string; type?: string } };

export function accessDestinationForObject(object: ObjectReference): AccessDestination {
  if (object.type === 'Role') return { kind: 'role', rid: object.rid };
  if (object.type === 'AccessPolicy') return { kind: 'policy', rid: object.rid };
  return { kind: 'test', object: { rid: object.rid, id: object.businessId, name: object.name, type: object.type } };
}

export function parseAccessDestination(value: unknown): AccessDestination | undefined {
  if (!value || typeof value !== 'object') return;
  const d = value as Record<string, unknown>;
  const rid = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
  if ((d.kind === 'role' || d.kind === 'policy') && rid(d.rid)) {
    if (d.kind === 'role') return { kind: 'role', rid: d.rid };
    return { kind: 'policy', rid: d.rid, ...(Number.isSafeInteger(d.statement) && (d.statement as number) >= 0 ? { statement: d.statement as number } : {}) };
  }
  if (d.kind === 'test' && d.object && typeof d.object === 'object') {
    const o = d.object as Record<string, unknown>;
    if (!rid(o.rid)) return;
    return { kind: 'test', object: { rid: o.rid, ...Object.fromEntries(['id', 'name', 'type'].flatMap(k => typeof o[k] === 'string' ? [[k, o[k]]] : [])) } };
  }
}

export function policyDestination(details: Record<string, string>): AccessDestination | undefined {
  return parseAccessDestination({ kind: 'policy', rid: details.policyRid,
    statement: /^\d+$/.test(details.statementIndex ?? '') ? Number(details.statementIndex) : undefined });
}
