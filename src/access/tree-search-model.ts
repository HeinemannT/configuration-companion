import { queryMatches, recordSearchRank } from './interaction-model';
import type { PolicyJson } from './schema-model';

/** Search role definitions without treating global memberships as tree records. */
export function roleSearchResults(model: PolicyJson, query: string, describe: (row: PolicyJson) => string = () => '') {
  const children = new Map<unknown, PolicyJson[]>();
  for (const row of model.scope) {
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent)!.push(row);
  }
  return model.roles.flatMap((role: PolicyJson) => {
    const roleMatch = queryMatches(query, role.name, role.id, role.rid);
    const matches = new Set<string>(), definitions = new Set<string>(), visited = new Set<string>([role.rid]);
    function visit(parent: string, ancestors: string[]): void {
      for (const row of children.get(parent) ?? []) {
        if (visited.has(row.rid)) continue;
        visited.add(row.rid);
        if (queryMatches(query, row.name, row.id, row.rid, row.source, row.field, row.kind, describe(row))) {
          matches.add(row.rid);
          for (const rid of [...ancestors, row.rid]) definitions.add(rid);
        }
        visit(row.rid, [...ancestors, row.rid]);
      }
    }
    visit(role.rid, []);
    return roleMatch || matches.size ? [{ role, roleMatch, matches, definitions }] : [];
  }).sort((a: PolicyJson, b: PolicyJson) => (a.roleMatch ? recordSearchRank(a.role, query) : 4) - (b.roleMatch ? recordSearchRank(b.role, query) : 4));
}
