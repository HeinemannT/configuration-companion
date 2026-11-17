import type { BmpClient } from '../bmp-client';
import type { BmpTypeCatalogue, BmpReferenceFact } from '../bmp-type-catalogue';
export interface MatrixMetadata extends BmpTypeCatalogue {
  references: Record<string, BmpReferenceFact | null>;
  problems: string[];
  unavailable: string[];
  unsupported: string[];
}
/** Optional enrichment, isolated from editable snapshots and undo history. An
 * unavailable reference is deliberately different from a confirmed missing one. */
export async function readMatrixMetadata(client: BmpClient, tokens: string[], signal?: AbortSignal): Promise<MatrixMetadata> {
  if (!Array.isArray(tokens) || tokens.length > 2000 || tokens.some(t => typeof t !== 'string' || t.length > 600)) throw new Error('Too many or invalid policy references.');
  const catalogue = await client.fetchTypeCatalogue(signal);
  const refs = [...new Set(tokens)].flatMap(token => {
    const match = /^([A-Za-z]+):([^:]+)$/.exec(token);
    const space = match && catalogue.types[match[1]]?.idSpace;
    return match && space ? [{ token, space, id: match[2] }] : [];
  });
  const eligible = new Set(refs.map(r=>r.token)), unsupported = [...new Set(tokens)].filter(token=>!eligible.has(token));
  let references: MatrixMetadata['references'] = {}, problems: string[] = [], unavailable: string[] = [];
  try { ({ references, problems, unavailable } = await client.resolvePolicyReferences(refs, signal)); }
  catch (error) {
    signal?.throwIfAborted();
    problems = ['Object references could not be resolved: ' + (error instanceof Error ? error.message : String(error))];
    unavailable = refs.map(r=>r.token);
  }
  return { ...catalogue, references, problems, unavailable, unsupported };
}
