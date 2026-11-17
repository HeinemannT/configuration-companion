import { changePatch, type DraftChange } from './draft-patch';
import type { PolicyJson } from './schema-model';
export { changePatch, historyContext } from './draft-patch';
const copy = (v: PolicyJson) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function brokenLinks(model: PolicyJson): Set<string> {
  const errors = new Set<string>(),
    roles = model.roles ?? [],
    folders = model.folders ?? [],
    scope = model.scope ?? [],
    ids = new Set(roles.map((r: PolicyJson) => r.id));
  for (const [name, rows] of [
      ['roles', roles],
      ['folders', folders]
    ]) {
    const seenIds = new Set(), byRid = new Map<string, PolicyJson>(rows.map((r: PolicyJson): [string, PolicyJson] => [r.rid, r]));
    for (const r of rows) {
      if (seenIds.has(r.id)) errors.add(name + ':duplicate:' + r.id);
      seenIds.add(r.id);
      if (r.parent && !byRid.has(r.parent)) errors.add(name + ':parent:' + r.rid + ':' + r.parent);
      const seen = new Set<string>([r.rid]);
      let p: string = r.parent;
      while (p) {
        if (seen.has(p)) {
          errors.add(name + ':cycle:' + r.rid);
          break;
        }
        seen.add(p);
        p = byRid.get(p)?.parent as string;
      }
    }
  }
  const folderIds = new Set(folders.map((f: PolicyJson) => f.rid)), scopeIds = new Set([...roles, ...scope].map((r: PolicyJson) => r.rid));
  for (const r of model.policies ?? [])
    if (r.parent && !folderIds.has(r.parent)) errors.add('policy:folder:' + r.rid + ':' + r.parent);
  for (const r of [...scope, ...model.globals ?? []])
    if (!scopeIds.has(r.parent)) errors.add('scope:parent:' + r.rid + ':' + r.parent);

  function walk(node: PolicyJson, pid: string): void {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'Subject' || key === 'Roles') {
        for (const token of Array.isArray(value) ? value : [value]) {
          if (typeof token !== 'string') continue;
          const id = token.startsWith('role:') ? token.slice(5) : key === 'Roles' ? token : null;
          if (id && !ids.has(id)) errors.add('policy:role:' + pid + ':' + id);
        }
      }
      if (typeof value === 'object') walk(value, pid);
    }
  }
  for (const p of model.policies ?? []) walk(p.content, p.rid);
  return errors;
}
export function reverseChange(model: PolicyJson, patch: DraftChange[]): { reason?: string; dependents?: unknown; model?: PolicyJson } {
  const next = Object.fromEntries(Object.entries<PolicyJson[]>(model).map(([key, rows]) => [key, [...rows]]));
  const copied = new Set<string>();
  for (const ch of patch) {
    const row = next[ch.collection]?.find((r: PolicyJson) => r.rid === ch.rid),
      now = ch.field === null ? row : row?.[ch.field];
    if (!equal(now, ch.after)) return {
      reason: 'A later edit changed ' + ch.name + (ch.field ? ' · ' + ch.field : '') + '. Undo that edit first.'
    };
  }
  for (const ch of patch) {
    const rows = next[ch.collection],
      i = rows.findIndex((r: PolicyJson) => r.rid === ch.rid);
    if (ch.field === null) {
      if (ch.before === undefined) {
        if (i >= 0) rows.splice(i, 1);
      } else if (i < 0) rows.push(copy(ch.before));
      else rows[i] = copy(ch.before);
    } else {
      if (i < 0) return {
        reason: 'The edited record no longer exists.'
      };
      if (!copied.has(ch.rid)) { rows[i] = copy(rows[i]); copied.add(ch.rid); }
      if (ch.before === undefined) delete rows[i][ch.field];
      else rows[i][ch.field] = copy(ch.before);
    }
  }
  const existing = brokenLinks(model);
  if ([...brokenLinks(next)].some(x => !existing.has(x))) return {
    reason: 'A later change depends on this edit. Undo the dependent change first.',
    dependents: dependentRecords(model, next, patch)
  };
  return {
    model: next
  };
}

function dependentRecords(before: PolicyJson, after: PolicyJson, patch: DraftChange[]) {
  const touched = new Set(patch.map(p => p.rid));
  const oldErrors = brokenLinks(before);
  const errors = [...brokenLinks(after)].filter(e => !oldErrors.has(e));
  // Every structural error records its owning RID. No per-record catalogue clones.
  return Object.entries<PolicyJson[]>(after).flatMap(([collection, rows]) => rows.filter(row => !touched.has(row.rid) && errors.some(error =>
    (error.startsWith((collection === 'policies' ? 'policy' : collection === 'globals' ? 'scope' : collection) + ':') &&
    error.includes(':' + row.rid + ':')) || error.endsWith(':' + row.rid) || error === collection + ':duplicate:' + row.id
  )).map(row => ({ collection, rid: row.rid, name: row.name || row.field || row.id || row.rid })));
}
export function discardRecord(model: PolicyJson, baseline: PolicyJson, collection: string, rid: string) {
  const patch = changePatch(baseline, model).filter(p => p.collection === collection && p.rid === rid);
  return {
    ...reverseChange(model, patch),
    patch
  };
}
export function conflictingJSONDrafts(patch: DraftChange[], draftIds: Iterable<string>): string[] {
  const roleIdentity = patch.some(p => p.collection === 'roles' && (p.field === null || p.field === 'id'));
  return [...draftIds].filter(rid => roleIdentity || patch.some(p => p.collection === 'policies' && p.rid === rid && (p.field === null || p
    .field === 'content')));
}
export function copyRoleDefinitions(model: PolicyJson, sourceRid: string, targetRid: string, makeRid: () => string) {
  const rows: PolicyJson[] = [],
    queue: string[] = [sourceRid],
    mapping = new Map<string, string>([
      [sourceRid, targetRid]
    ]),
    visited = new Set<string>();
  while (queue.length) {
    const parent = queue.shift() as string;
    if (visited.has(parent)) continue;
    visited.add(parent);
    for (const row of model.scope.filter((r: PolicyJson) => r.parent === parent)) {
      const rid = makeRid();
      mapping.set(row.rid, rid);
      rows.push({
        ...copy(row),
        rid,
        id: 'draft_definition_' + rid.replace(/[^a-zA-Z0-9_]/g, '_'),
        parent: mapping.get(parent)
      });
      queue.push(row.rid);
    }
  }
  return rows;
}
