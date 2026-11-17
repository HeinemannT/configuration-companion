/** Compact native metadata. Raw TypeKey map keys must survive deserialization. */
export interface BmpTypeFact { parents: string[]; concrete: boolean; idSpace?: string; }
export interface BmpTypeCatalogue { types: Record<string, BmpTypeFact>; models: Record<string, string[]>; }
export interface BmpReferenceFact { rid: string; type: string; model: string; }
export interface BmpReferenceResolution {
  references: Record<string, BmpReferenceFact | null>;
  unavailable: string[];
  problems: string[];
}

const record = (v: unknown): Record<string, any> => v && typeof v === 'object' ? v as Record<string, any> : {};
const name = (v: unknown): string => typeof v === 'string' ? v : String(record(v).typeId ?? record(v).name ?? '');
const items = (v: unknown): unknown[] => Array.isArray(v) ? v : Array.isArray(record(v).$elements) ? record(v).$elements : [];
export function javaMapEntries(v: unknown): Array<[unknown, any]> {
  const value = record(v);
  if (Array.isArray(value.$entries)) return value.$entries;
  if (value.$map && typeof value.$map === 'object') return Object.entries(value.$map);
  throw new Error('BMP returned an incomplete metadata map.');
}
export function commandResults(objects: unknown[], count: number): unknown[] {
  const error = objects.find(v => String(record(v).$class).includes('ExceptionResponse'));
  if (error) throw new Error(String(record(error).message ?? 'BMP metadata request failed.'));
  const responses = objects.flatMap(v => items(v));
  if (responses.length !== count || responses.some(v => !Object.hasOwn(record(v), 'response'))) throw new Error('BMP returned incomplete metadata responses.');
  return responses.map(v => record(v).response);
}
export function parseTypeCatalogue(value: unknown): BmpTypeCatalogue {
  const dto = record(value), types: Record<string, BmpTypeFact> = Object.create(null), models: Record<string, string[]> = Object.create(null);
  for (const [key, raw] of javaMapEntries(dto.types)) {
    const id = name(key), type = record(raw);
    if (!id || id !== name(type.key) || Object.hasOwn(types, id)) throw new Error('BMP returned invalid or duplicate type keys.');
    // An absent list is not proof of no ancestors. Negative type comparisons
    // depend on this distinction; reject contract drift before building a graph.
    if (!(Array.isArray(type.directSuperTypes) || Array.isArray(record(type.directSuperTypes).$elements)) || typeof type.concrete !== 'boolean') {
      throw new Error('BMP returned incomplete type ancestry or concrete metadata for ' + id + '.');
    }
    const parents = items(type.directSuperTypes).map(name);
    if (parents.some(parent => !parent)) throw new Error('BMP returned an invalid parent type for ' + id + '.');
    types[id] = { parents, concrete: type.concrete, idSpace: name(type.idSpace) || undefined };
  }
  if (!types.Identifiable) throw new Error('BMP type catalogue is incomplete.');
  for (const [key, raw] of javaMapEntries(dto.concreteTypesPerModel)) {
    for (const type of items(raw).map(name)) (models[type] ??= []).push(name(key));
  }
  return { types, models };
}
export function parseReferenceIdentity(value: unknown): BmpReferenceFact | null {
  if (value == null) return null;
  const values = Object.fromEntries(javaMapEntries(value).map(([k, v]) => [String(k), v]));
  const rid = String(values.getRid?.identifier ?? ''), type = name(values.getTypeKey), model = name(values.getModel);
  if (!/^\d+$/.test(rid) || !type || !model) throw new Error('BMP returned an incomplete reference identity.');
  return { rid, type, model };
}
