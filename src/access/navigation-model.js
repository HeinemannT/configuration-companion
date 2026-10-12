import {
  reverseChange
} from './history-model.js';

export function scopeOwner(model, rid) {
  const seen = new Set();
  let id = rid;
  while (id && !seen.has(id)) {
    if (model.roles.some(r => r.rid === id)) return id;
    seen.add(id);
    id = [...model.scope, ...model.globals].find(r => r.rid === id)?.parent;
  }
  return null;
}
export function roleDefinitions(model, roleRid) {
  const rows = [],
    seen = new Set([roleRid]), children = new Map();
  for (const row of model.scope) {
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent).push(row);
  }

  function visit(parent, depth) {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.rid)) continue;
      seen.add(row.rid);
      rows.push({
        ...row,
        depth
      });
      visit(row.rid, depth + 1);
    }
  }
  visit(roleRid, 1);
  return rows;
}

/** Routes carry view state only. Browser navigation must never restore a model. */
export function createViewNavigation(browserHistory, environment, restore, storage) {
  const key = route => JSON.stringify([route.surface, route.kind, route.rid,
    route.surface === 'record' && route.kind === 'role' ? route.scopeSelection ?? null : null]);
  const valid = entry => entry?.companionAccess === environment && Number.isInteger(entry.index) && entry.route;
  let active = valid(browserHistory.state) ? browserHistory.state : null;
  const token = active?.token ?? globalThis.crypto.randomUUID(), storageKey = 'companion.access.navigation:' + token;
  let extent = active?.index ?? 0;
  try { extent = Math.max(extent, Number(storage?.getItem(storageKey)) || 0); } catch { /* Navigation still works without preference storage. */ }
  return {
    sync(route, replace = false) {
      if (!active) {
        active = { companionAccess: environment, token, index: 0, route };
        browserHistory.replaceState(active, '');
      } else if (replace || key(route) === key(active.route)) {
        active = { ...active, token, route };
        browserHistory.replaceState(active, '');
      } else {
        active = { ...active, token, index: active.index + 1, route };
        extent = active.index;
        browserHistory.pushState(active, '');
      }
      try { storage?.setItem(storageKey, String(extent)); } catch { /* Optional. */ }
    },
    pop(entry) {
      if (!valid(entry)) return false;
      active = entry;
      extent = Math.max(extent, entry.index);
      restore(entry.route);
      return true;
    },
    get back() { return (active?.index ?? 0) > 0; },
    get forward() { return (active?.index ?? 0) < extent; },
  };
}
export function historyRecordIds(event) {
  return [...new Set(event.patch.flatMap(p => [p.rid, scopeOwner(event.before, p.rid), scopeOwner(event.after, p.rid)]).filter(Boolean))];
}
export function historyStep(model, event, validate = true) {
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const current = p => {
    const row = model[p.collection]?.find(r => r.rid === p.rid);
    return p.field === null ? row : row?.[p.field];
  };
  const applied = event.patch.every(p => equal(current(p), p.after));
  const undone = event.patch.every(p => equal(current(p), p.before));
  const kind = !applied && undone ? 'restore' : 'undo';
  const patch = kind === 'restore' ? event.patch.map(p => ({
    ...p,
    before: p.after,
    after: p.before
  })) : event.patch;
  const status = applied ? 'In draft' : undone ? 'Undone' : 'Changed later';
  if (!validate) return { kind, patch, status };
  const result = reverseChange(model, patch);
  if (event.patch.some(p => p.field !== null && !model[p.collection]?.some(r => r.rid === p.rid))) return {
    kind,
    patch,
    status: 'Record removed',
    reason: 'This record was removed. Restore its creation or undo its removal first.'
  };
  return {
    kind,
    patch,
    status,
    ...result
  };
}
