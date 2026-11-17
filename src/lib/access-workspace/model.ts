/** Data shared by the workspace and its environment-bound service worker. */
export type AccessCollection = 'roles' | 'policies' | 'scope' | 'folders' | 'globals';
export const COLLECTIONS: AccessCollection[] = ['roles', 'policies', 'scope', 'folders', 'globals'];
export const DELEGATIONS = ['InwardsReferenceRoleDelegationRule', 'OutwardsReferenceRoleDelegationRule', 'HierarchicalDownwardsRoleDelegationRule', 'HierarchicalUpwardsRoleDelegationRule'] as const;
export interface AccessRecord {
  rid: string; id: string; name: string; parent: string;
  kind?: string; source?: string; field?: string; referenceConfig?: string;
  enabled?: boolean; valid?: boolean; content?: Record<string, unknown>; invalidContent?: string;
  mode?: string; subject?: string; subjectId?: string; subjectName?: string;
}
export type AccessModel = Record<AccessCollection, AccessRecord[]>;
export interface AccessChoice { rid: string; id: string; name: string; type: string; path?: string; }
export interface AccessProperty {
  rid: string; accessor: string; label: string; configClass: string; system: boolean; targets?: string;
  reference?: boolean; principal?: boolean; multiselect?: boolean;
  listSet?: { rid: string; id: string; name: string; partial?: boolean; items: Array<AccessChoice & { token: string }> };
}
export interface AccessSnapshot {
  environment: string; name: string; loadedAt: string;
  roots: { roles: string; policies: string }; model: AccessModel;
  classes: Record<string, AccessProperty[]>; users: AccessChoice[]; groups: AccessChoice[];
  /** Live concrete subtype catalogue used for static policy coverage. */
  typeChildren?: Record<string, string[]>;
}
export interface ProposedValues {
  type: string; properties?: Record<string, string | number | boolean | null>;
  references?: Record<string, string | string[] | null>; parent_rid?: string | null;
}
export interface AccessTest { resource_rid: string; subject_rid: string; action: 'READ' | 'UPDATE' | 'DELETE' | 'CREATE'; proposed?: ProposedValues; }
export type AccessTask =
  | { operation: 'load' }
  | { operation: 'reconcile' }
  | { operation: 'schema'; type: string }
  | { operation: 'matrixMetadata'; references: string[] }
  | { operation: 'creation'; type: string; source?: string; fields?: string[] }
  | { operation: 'listItems'; set: string; query: string; selected?: string[] }
  | { operation: 'search'; query: string; type?: string; prototypes?: boolean; containers?: boolean; containerFor?: string }
  | { operation: 'principals'; query: string; kind: 'User' | 'Group' }
  | { operation: 'trace'; request: AccessTest }
  | { operation: 'performanceDiscover' }
  | { operation: 'performanceMeasure'; request: AccessTest }
  | { operation: 'apply'; baseline: AccessModel; draft: AccessModel };
export type AccessRequest = AccessTask
  | { operation: 'start'; id: string; task: AccessTask }
  | { operation: 'status'; id: string }
  | { operation: 'cancel'; id: string }
  | { operation: 'acknowledge'; id: string };
export const emptyModel = (): AccessModel => ({ roles: [], policies: [], scope: [], folders: [], globals: [] });
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export interface AccessChange { collection: AccessCollection; before?: AccessRecord; after?: AccessRecord; }
export function changes(before: AccessModel, after: AccessModel): AccessChange[] {
  return COLLECTIONS.flatMap(collection => {
    const old = new Map(before[collection].map(r => [r.rid, r]));
    const next = new Map(after[collection].map(r => [r.rid, r]));
    return [...new Set([...old.keys(), ...next.keys()])].flatMap(rid => canonical(old.get(rid)) === canonical(next.get(rid)) ? [] : [{ collection, before: old.get(rid), after: next.get(rid) }]);
  });
}
export function recordType(collection: AccessCollection, record: AccessRecord): string {
  return collection === 'roles' ? 'Role' : collection === 'policies' ? 'AccessPolicy' : collection === 'folders' ? 'Category' : record.kind ?? '';
}
