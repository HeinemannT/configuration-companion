import { scopeOwner } from './navigation-model.js';
import { resolveUser } from './principal-model.js';
import { testContextRids } from './create-test-model.js';

export function unfinishedIdEdits(model, drafts) {
  return ['roles', 'policies'].flatMap(collection => model[collection].filter(record =>
    drafts.has(record.rid) && drafts.get(record.rid) !== record.id
  ).map(record => ({ record, kind: collection === 'roles' ? 'role' : 'policy', value: drafts.get(record.rid) })));
}

export function pendingRecordCount(changes, jsonDrafts, idEdits) {
  return new Set([...changes.map(change => change.r.rid), ...jsonDrafts.map(record => record.rid),
    ...idEdits.map(edit => edit.record.rid)]).size;
}

export function changedRoleOwners(model, baseline, changes) {
  const owners = new Set();
  for (const change of changes) {
    if (!['scope', 'globals'].includes(change.key)) continue;
    for (const source of [model, baseline]) {
      const owner = scopeOwner(source, change.r.rid);
      if (owner) owners.add(owner);
    }
  }
  return owners;
}

// Without persisted rule IDs, only an unchanged rule at the same position is
// safe to attribute to the saved policy. Never infer identity after JSON edits.
export function matchingSavedStatement(policy, savedPolicy, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  const draft = policy?.content?.Statement?.[index], saved = savedPolicy?.content?.Statement?.[index];
  return draft && saved && JSON.stringify(draft) === JSON.stringify(saved) ? saved : null;
}

/** Retain all prepared inputs, including inactive Create/Update scenarios.
 * Detach the request so an older async trace cannot restore an invalid result. */
export function withoutTestResults(test, rerunRequired = false) {
  const next = structuredClone(test);
  for (const scenario of [next, ...Object.values(next.scenarios ?? {})]) {
    scenario.result = null;
    scenario.rerunRequired = rerunRequired;
  }
  return next;
}

export function testsAfterApply(tests, open, model, mapping = {}) {
  const retained = new Map(), retainedOpen = new Set();
  for (const [key, test] of tests) {
    let nextKey = key;
    if (!key.startsWith('object:')) {
      const match = /^(role|policy):(.+):(\d+)$/.exec(key);
      if (!match) continue;
      const [, kind, previousRid, statement] = match,
        rid = mapping[previousRid] ?? previousRid,
        record = model[kind === 'role' ? 'roles' : 'policies'].find(row => row.rid === rid);
      if (!record || kind === 'policy' && !record.content?.Statement?.[Number(statement)]) continue;
      nextKey = `${kind}:${rid}:${statement}`;
    }
    const next = withoutTestResults(test, true);
    if (next.mode === 'role') {
      next.subject = mapping[next.subject] ?? next.subject;
      if (!model.roles.some(role => role.rid === next.subject)) next.subject = '';
    }
    retained.set(nextKey, next);
    if (open.has(key)) retainedOpen.add(nextKey);
  }
  return { tests: retained, testOpen: retainedOpen };
}

export function selectedTestContext(tests, context, users, refreshedUsers) {
  const resources = new Set(tests.flatMap(testContextRids)),
    userIds = new Set(tests.filter(test => test.mode === 'user').map(test => test.userId));
  return {
    objects: context.objects.filter(object => resources.has(object.rid)),
    prototypes: context.prototypes.filter(object => resources.has(object.rid)),
    users: users.filter(user => userIds.has(user.id) || resources.has(user.rid)).map(user => resolveUser(refreshedUsers, user.id) ?? user)
  };
}
