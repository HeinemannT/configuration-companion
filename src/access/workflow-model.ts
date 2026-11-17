import { scopeOwner } from './navigation-model';
import { resolveUser } from './principal-model';
import { testContextRids } from './create-test-model';
import type { PolicyJson } from './schema-model';

export function unfinishedIdEdits(model: PolicyJson, drafts: Map<string, string>) {
  return ['roles', 'policies'].flatMap(collection => model[collection].filter((record: PolicyJson) =>
    drafts.has(record.rid) && drafts.get(record.rid) !== record.id
  ).map((record: PolicyJson) => ({ record, kind: collection === 'roles' ? 'role' : 'policy', value: drafts.get(record.rid) })));
}

/** What the badge and the review title count: the review's entries, plus each open JSON
 *  edit and unfinished ID edit, which the review lists in a section of their own. */
export const unsavedTotal = (entries: number, jsonEdits: number, idEdits: number): number => entries + jsonEdits + idEdits;

export function pendingRecordCount(changes: PolicyJson[], jsonDrafts: PolicyJson[], idEdits: PolicyJson[]): number {
  return new Set([...changes.map(change => change.r.rid), ...jsonDrafts.map(record => record.rid),
    ...idEdits.map(edit => edit.record.rid)]).size;
}

export function changedRoleOwners(model: PolicyJson, baseline: PolicyJson, changes: PolicyJson[]): Set<string> {
  const owners = new Set<string>();
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
export function matchingSavedStatement(policy: PolicyJson, savedPolicy: PolicyJson, index: number): PolicyJson {
  if (!Number.isInteger(index) || index < 0) return null;
  const draft = policy?.content?.Statement?.[index], saved = savedPolicy?.content?.Statement?.[index];
  return draft && saved && JSON.stringify(draft) === JSON.stringify(saved) ? saved : null;
}

/** Retain all prepared inputs, including inactive Create/Update scenarios.
 * Detach the request so an older async trace cannot restore an invalid result. */
export function withoutTestResults(test: PolicyJson, rerunRequired = false): PolicyJson {
  const next = structuredClone(test);
  for (const scenario of [next, ...Object.values(next.scenarios ?? {})]) {
    scenario.result = null;
    scenario.rerunRequired = rerunRequired;
  }
  return next;
}

export function testsAfterApply(tests: Map<string, PolicyJson>, open: Set<string>, model: PolicyJson, mapping: Record<string, string> = {}) {
  const retained = new Map<string, PolicyJson>(), retainedOpen = new Set<string>();
  for (const [key, test] of tests) {
    let nextKey = key;
    if (key.startsWith('matrix:')) {
      const [, role, type] = key.split(':');
      const rid = mapping[role] ?? role;
      if (!model.roles.some((r: PolicyJson) => r.rid === rid)) continue;
      nextKey = `matrix:${rid}:${type}`;
    } else if (!key.startsWith('object:')) {
      const match = /^(role|policy):(.+):(\d+)$/.exec(key);
      if (!match) continue;
      const [, kind, previousRid, statement] = match,
        rid = mapping[previousRid] ?? previousRid,
        record = model[kind === 'role' ? 'roles' : 'policies'].find((row: PolicyJson) => row.rid === rid);
      if (!record || kind === 'policy' && !record.content?.Statement?.[Number(statement)]) continue;
      nextKey = `${kind}:${rid}:${statement}`;
    }
    const next = withoutTestResults(test, true);
    if (next.mode === 'role') {
      next.subject = mapping[next.subject] ?? next.subject;
      if (!model.roles.some((role: PolicyJson) => role.rid === next.subject)) next.subject = '';
    }
    retained.set(nextKey, next);
    if (open.has(key)) retainedOpen.add(nextKey);
  }
  return { tests: retained, testOpen: retainedOpen };
}

export function selectedTestContext(tests: PolicyJson[], context: PolicyJson, users: PolicyJson[], refreshedUsers: PolicyJson[]) {
  const resources = new Set(tests.flatMap(test => testContextRids(test))),
    userIds = new Set(tests.filter((test: PolicyJson) => test.mode === 'user').map(test => test.userId));
  return {
    objects: context.objects.filter((object: PolicyJson) => resources.has(object.rid)),
    prototypes: context.prototypes.filter((object: PolicyJson) => resources.has(object.rid)),
    users: users.filter((user: PolicyJson) => userIds.has(user.id) || resources.has(user.rid)).map((user: PolicyJson) => resolveUser(refreshedUsers, user.id) ?? user)
  };
}
