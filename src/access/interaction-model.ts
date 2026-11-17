import type { PolicyJson } from './schema-model';
export { policyDiagnostics } from './pbac-validation';

export function ancestry<T extends { rid: string; parent?: string }>(records: T[], rid: string): T[] {
  const out: T[] = [],
    seen = new Set<string>();
  let row = records.find(r => r.rid === rid);
  while (row && !seen.has(row.rid)) {
    seen.add(row.rid);
    out.unshift(row);
    row = records.find(r => r.rid === row?.parent);
  }
  return out;
}
export function moveProblem(roles: PolicyJson[], rid: string, parent: string | undefined): string {
  const role = roles.find(r => r.rid === rid);
  if (!role) return 'Role is no longer available.';
  if (parent && !roles.some(r => r.rid === parent)) return 'Parent is no longer available.';
  if (parent === rid) return 'A role cannot be its own parent.';
  if (parent && ancestry(roles, parent).some(r => r.rid === rid)) return 'A child cannot become its own ancestor.';
  if ((role.parent || '') === (parent || '')) return 'Already under this parent.';
  return '';
}
export function renameRoleReferences(content: PolicyJson, oldId: string, newId: string): { content: PolicyJson; count: number } {
  let count = 0;
  const visit = (value: PolicyJson): PolicyJson => {
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (key === 'Subject' || key === 'Roles') {
        const replace = (t: PolicyJson) => {
          if (t === 'role:' + oldId || (key === 'Roles' && t === oldId)) {
            count++;
            return t.startsWith('role:') ? 'role:' + newId : newId;
          }
          return t;
        };
        return [key, Array.isArray(v) ? v.map(replace) : replace(v)];
      }
      return [key, Array.isArray(v) ? v.map((x: PolicyJson) => x && typeof x === 'object' ? visit(x) : x) : v && typeof v === 'object' ? visit(
        v) : v
      ];
    }));
  };
  return {
    content: visit(content),
    count
  };
}
export function referencedRoleIds(content: PolicyJson): string[] {
  const out = new Set<string>();

  function walk(v: PolicyJson): void {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'Roles' || k === 'Subject')
        for (const t of Array.isArray(x) ? x : [x])
          if (typeof t === 'string' && (k === 'Roles' || t.startsWith('role:'))) out.add(t.replace(/^role:/, ''));
      if (typeof x === 'object') walk(x);
    }
  }
  walk(content);
  return [...out];
}
export function queryMatches(query: string, ...values: unknown[]): boolean {
  const text = values.filter(Boolean).join(' ').toLocaleLowerCase();
  const terms = query.match(/"[^"]+"|\S+/g) ?? [];
  return terms.every((t: string) => text.includes(t.replace(/^"|"$/g, '').toLocaleLowerCase()));
}
export function policyMatches(policy: PolicyJson, query: string, roles: PolicyJson[]): boolean {
  const ids = referencedRoleIds(policy.content);
  const names = roles.filter((r: PolicyJson) => ids.includes(r.id)).map((r: PolicyJson) => r.name).join(' ');
  return queryMatches(query, policy.name, policy.id, policy.rid, JSON.stringify(policy.content), names);
}

export function objectMatches(object: PolicyJson, query: string): boolean {
  return queryMatches(query, object.name, object.path, object.type) || queryMatches(query, object.id) || queryMatches(query, object.rid);
}
export function recordSearchRank(record: PolicyJson, query: string): number {
  const q = query.trim().replace(/^"|"$/g, '').toLowerCase();
  if (!q) return 0;
  if ([record.id, record.rid].some(v => String(v ?? '').toLowerCase() === q)) return 0;
  if (String(record.name).toLowerCase() === q) return 1;
  return String(record.name).toLowerCase().startsWith(q) ? 2 : 3;
}
export function suggestedBusinessId(name: string, kind = 'record'): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return !name.trim() ? '' : !base ? kind : /^[a-z_]/.test(base) ? base : kind + '_' + base;
}
export function businessIdError(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? '' : 'Start the ID with a letter or underscore. Use only letters, numbers, and underscores.';
}
