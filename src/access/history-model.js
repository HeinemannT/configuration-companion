import { changePatch } from './draft-patch';
export { changePatch, historyContext } from './draft-patch';
const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function brokenLinks(model) {
  const errors = new Set(),
    roles = model.roles ?? [],
    folders = model.folders ?? [],
    scope = model.scope ?? [],
    ids = new Set(roles.map(r => r.id));
  for (const [name, rows] of [
      ['roles', roles],
      ['folders', folders]
    ]) {
    const seenIds = new Set(), byRid = new Map(rows.map(r => [r.rid, r]));
    for (const r of rows) {
      if (seenIds.has(r.id)) errors.add(name + ':duplicate:' + r.id);
      seenIds.add(r.id);
      if (r.parent && !byRid.has(r.parent)) errors.add(name + ':parent:' + r.rid + ':' + r.parent);
      const seen = new Set([r.rid]);
      let p = r.parent;
      while (p) {
        if (seen.has(p)) {
          errors.add(name + ':cycle:' + r.rid);
          break;
        }
        seen.add(p);
        p = byRid.get(p)?.parent;
      }
    }
  }
  const folderIds = new Set(folders.map(f => f.rid)), scopeIds = new Set([...roles, ...scope].map(r => r.rid));
  for (const r of model.policies ?? [])
    if (r.parent && !folderIds.has(r.parent)) errors.add('policy:folder:' + r.rid + ':' + r.parent);
  for (const r of [...scope, ...model.globals ?? []])
    if (!scopeIds.has(r.parent)) errors.add('scope:parent:' + r.rid + ':' + r.parent);

  function walk(node, pid) {
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
export function reverseChange(model, patch) {
  const next = Object.fromEntries(Object.entries(model).map(([key, rows]) => [key, [...rows]]));
  const copied = new Set();
  for (const ch of patch) {
    const row = next[ch.collection]?.find(r => r.rid === ch.rid),
      now = ch.field === null ? row : row?.[ch.field];
    if (!equal(now, ch.after)) return {
      reason: 'A later edit changed ' + ch.name + (ch.field ? ' · ' + ch.field : '') + '. Undo that edit first.'
    };
  }
  for (const ch of patch) {
    const rows = next[ch.collection],
      i = rows.findIndex(r => r.rid === ch.rid);
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

function dependentRecords(before, after, patch) {
  const touched = new Set(patch.map(p => p.rid));
  const oldErrors = brokenLinks(before);
  const errors = [...brokenLinks(after)].filter(e => !oldErrors.has(e));
  // Every structural error records its owning RID. No per-record catalogue clones.
  return Object.entries(after).flatMap(([collection, rows]) => rows.filter(row => !touched.has(row.rid) && errors.some(error =>
    (error.startsWith((collection === 'policies' ? 'policy' : collection === 'globals' ? 'scope' : collection) + ':') &&
    error.includes(':' + row.rid + ':')) || error.endsWith(':' + row.rid) || error === collection + ':duplicate:' + row.id
  )).map(row => ({ collection, rid: row.rid, name: row.name || row.field || row.id || row.rid })));
}
export function discardRecord(model, baseline, collection, rid) {
  const patch = changePatch(baseline, model).filter(p => p.collection === collection && p.rid === rid);
  return {
    ...reverseChange(model, patch),
    patch
  };
}
export function conflictingJSONDrafts(patch, draftIds) {
  const roleIdentity = patch.some(p => p.collection === 'roles' && (p.field === null || p.field === 'id'));
  return [...draftIds].filter(rid => roleIdentity || patch.some(p => p.collection === 'policies' && p.rid === rid && (p.field === null || p
    .field === 'content')));
}
export function copyRoleDefinitions(model, sourceRid, targetRid, makeRid) {
  const rows = [],
    queue = [sourceRid],
    mapping = new Map([
      [sourceRid, targetRid]
    ]),
    visited = new Set();
  while (queue.length) {
    const parent = queue.shift();
    if (visited.has(parent)) continue;
    visited.add(parent);
    for (const row of model.scope.filter(r => r.parent === parent)) {
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
export function rolePolicyMatches(policy, roleId) {
  const result = [];
  for (const [index, statement] of(policy.content?.Statement ?? []).entries()) {
    const refs = [];

    function visit(value, path) {
      if (!value || typeof value !== 'object') return;
      for (const [key, v] of Object.entries(value)) {
        if ((key === 'Subject' || key === 'Roles') && (Array.isArray(v) ? v : [v]).some(t => t === 'role:' + roleId || (key === 'Roles' &&
            t === roleId))) refs.push([...path, key].join('.'));
        if (typeof v === 'object') visit(v, [...path, key]);
      }
    }
    visit(statement, []);
    if (refs.length) result.push({
      index,
      statement,
      refs
    });
  }
  return result;
}
