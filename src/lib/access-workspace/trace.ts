import type { BmpClient } from '../bmp-client';
import { validateEcIdentifier, validateRid } from '../ec-guards';
import type { AccessTest, ProposedValues } from './model';
import type { AccessTraceUpdates } from '../bmp-types';
import { readTypeFields } from './requests';

export function normalizeProposed(proposed: ProposedValues, fields: Array<{ id: string; businessId: string; reference: boolean; multiselect: boolean }>): AccessTraceUpdates {
  validateEcIdentifier(proposed.type);
  const result: AccessTraceUpdates = { type: proposed.type, properties: {}, references: {} };
  const seen = new Set<string>();
  for (const [kind, values] of Object.entries({ properties: proposed.properties, references: proposed.references })) {
    if (!values) continue;
    if (typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 100) throw new Error('Proposed values must be an object with at most 100 fields.');
    for (const [key, value] of Object.entries(values)) {
      const field = fields.find(f => f.businessId === key || f.id === key);
      if (!field || ['type', 'parent'].includes(key) || seen.has(field.id)) throw new Error(`Unknown or duplicate field: ${key}`);
      seen.add(field.id);
      if (field.reference !== (kind === 'references')) throw new Error(`${key} belongs in ${field.reference ? 'references' : 'properties'}.`);
      if (kind === 'properties') {
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${key} must be a scalar value.`);
        if (typeof value === 'string' && value.length > 10000 || typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid value for ${key}.`);
        result.properties![field.id] = value as string | number | boolean | null;
      } else {
        const refs = value === null ? [] : Array.isArray(value) ? value : [value];
        if (refs.length > 100 || refs.some(r => typeof r !== 'string')) throw new Error(`${key} requires RID strings.`);
        refs.forEach(r => validateRid(r as string));
        if (!field.multiselect && refs.length > 1) throw new Error(`${key} accepts one reference.`);
        result.references![field.id] = value === null ? null : field.multiselect ? refs as string[] : refs[0] as string ?? null;
      }
    }
  }
  if (proposed.parent_rid !== undefined) result.parent_rid = proposed.parent_rid === null ? null : validateRid(proposed.parent_rid);
  return result;
}

export async function traceAccess(client: BmpClient, request: AccessTest, assertEnvironment: () => void) {
  if (typeof request.resource_rid !== 'string' || typeof request.subject_rid !== 'string') throw new Error('Resource and subject RIDs must be strings.');
  validateRid(request.resource_rid); validateRid(request.subject_rid);
  if (!['READ', 'CREATE', 'UPDATE', 'DELETE'].includes(request.action)) throw new Error('Unknown access action.');
  if (['CREATE', 'UPDATE'].includes(request.action) && !request.proposed) throw new Error('Create and Update tests require proposed values.');
  if (request.proposed && !['CREATE', 'UPDATE'].includes(request.action)) throw new Error('Read and Delete do not use proposed values.');
  const updates = request.proposed ? normalizeProposed(request.proposed, await readTypeFields(client, request.proposed.type)) : undefined;
  assertEnvironment();
  const trace = await client.fetchAccessTrace(request.resource_rid, request.subject_rid, request.action, undefined, updates);
  if (!trace) throw new Error('BMP returned no access decision.');
  return trace;
}
