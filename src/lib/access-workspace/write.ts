import { validateBusinessId, validateRid } from '../ec-guards';
import { canonical, changes, COLLECTIONS, DELEGATIONS, recordType, type AccessModel, type AccessRecord, type AccessSnapshot, type AccessCollection } from './model';
import { literal, rawPolicyText } from './read';

export function validateModel(model: AccessModel, previous?: AccessModel): void {
  const all = new Map<string, { record: AccessRecord; collection: AccessCollection }>();
  const old = new Map(COLLECTIONS.flatMap(c => (previous?.[c] ?? []).map(r => [r.rid, r] as const)));
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(model?.[collection]) || model[collection].length > 100_000) throw new Error('Invalid or oversized access draft.');
    const ids = new Set<string>();
    for (const record of model[collection]) {
      if (!record || typeof record.rid !== 'string' || all.has(record.rid)) throw new Error('Duplicate or missing record identifier.');
      if (collection !== 'globals') {
        if (!/^(?:\d+|draft:[A-Za-z0-9_-]+)$/.test(record.rid)) throw new Error('Invalid record identifier.');
        if (typeof record.id !== 'string' || !record.id || record.id.length > 500) throw new Error('A business ID is required.');
        if (ids.has(record.id)) throw new Error(`Duplicate business ID: ${record.id}`);
        ids.add(record.id);
        if (typeof record.name !== 'string' || record.name.length > 1000 || typeof record.parent !== 'string') throw new Error('Invalid record name or parent.');
      }
      all.set(record.rid, { record, collection });
    }
  }
  // Roles and definitions share BMP's ROLE id space; folders/policies share ACCESSPOLICY.
  for (const collections of [['roles', 'scope'], ['policies', 'folders']] as AccessCollection[][]) {
    const ids = collections.flatMap(c => model[c].map(r => r.id));
    if (new Set(ids).size !== ids.length) throw new Error('Business IDs must be unique within the role or policy catalogue.');
  }
  const checkedParents = new Set<string>();
  for (const [rid, { record: r, collection }] of all) {
    const edited = !previous || canonical(old.get(rid)) !== canonical(r);
    const parent = all.get(r.parent);
    if (collection === 'globals') {
      validateRid(r.subject ?? '');
      if (!['User', 'Group'].includes(r.mode ?? '') || parent?.collection !== 'roles') throw new Error('Choose a saved user/group and a role for the global assignment.');
      continue;
    }
    if (collection === 'roles' && r.parent && parent?.collection !== 'roles') throw new Error('A role must be placed under another role or at the root.');
    if (['policies', 'folders'].includes(collection) && r.parent && parent?.collection !== 'folders') throw new Error('Choose an existing policy folder.');
    if (collection === 'scope') {
      if (r.kind === 'RoleAssignment' ? parent?.collection !== 'roles' : !DELEGATIONS.includes(r.kind as typeof DELEGATIONS[number]) || parent?.collection !== 'scope') throw new Error('Assignments belong to roles; delegations belong to assignments or other delegations.');
      if (edited && (r.kind === 'RoleAssignment' || r.kind?.includes('Reference')) && (!r.source || !r.field)) throw new Error(`Select the source type and reference for ${r.name}.`);
    }
    if (edited && collection === 'policies' && !r.invalidContent) {
      if (!r.content || !Array.isArray(r.content.Statement)) throw new Error(`Policy ${r.name} needs a Statement array.`);
      if (typeof r.enabled !== 'boolean') throw new Error('Policy enabled must be true or false.');
      if (JSON.stringify(r.content).length > 1_000_000) throw new Error('Policy JSON exceeds 1 MB.');
    }
    const seen = new Set([rid]); let cursor = r.parent;
    while (cursor && !checkedParents.has(cursor)) { if (seen.has(cursor)) throw new Error('The draft contains a hierarchy cycle.'); seen.add(cursor); cursor = all.get(cursor)?.record.parent ?? ''; }
    for (const id of seen) checkedParents.add(id);
  }
  const memberships = model.globals.map(r => r.subject + ':' + r.parent);
  if (new Set(memberships).size !== memberships.length) throw new Error('This principal already has that global role.');
}

/** Compare only records being edited; unrelated server edits are preserved. */
export function assertNoConflicts(baseline: AccessModel, draft: AccessModel, live: AccessModel): void {
  for (const change of changes(baseline, draft)) {
    const record = change.before ?? change.after!;
    if (change.before) {
      const actual = live[change.collection].find(r => r.rid === record.rid);
      if (canonical(actual) !== canonical(change.before)) throw new Error(`${record.name || record.id || record.subjectName} changed in BMP. Reload and reconcile this draft before applying.`);
    } else if (change.collection !== 'globals' && live[change.collection].some(r => r.id === record.id)) throw new Error(`Business ID ${record.id} is already in use in BMP.`);
    if (!change.after) {
      const extraChildren = COLLECTIONS.flatMap(c => live[c]).filter(r => r.parent === record.rid && !COLLECTIONS.flatMap(c => baseline[c]).some(b => b.rid === r.rid));
      if (extraChildren.length) throw new Error(`${record.name} has new children or assignments in BMP. Reload before deleting.`);
    }
  }
}

export interface ApplyPlan { code: string; preview: string; finish?: string; temporaryIds: Record<string, string>; receipts: { preview: string; apply: string; finish: string } }

export function buildApplyCode(baseline: AccessModel, draft: AccessModel, snapshot: AccessSnapshot): string {
  return buildApplyPlan(baseline, draft, snapshot).preview;
}

export function buildApplyPlan(baseline: AccessModel, draft: AccessModel, snapshot: AccessSnapshot): ApplyPlan {
  validateModel(draft, baseline);
  const delta = changes(baseline, draft);
  for (const d of delta) if (d.after && d.collection !== 'globals' && d.before?.id !== d.after.id) validateBusinessId(d.after.id);
  if (delta.length > 200) throw new Error('Apply at most 200 record changes at once.');
  for (const d of delta.filter(d => d.collection === 'roles' && d.before && (!d.after || d.before.id !== d.after.id))) {
    const oldId = d.before!.id;
    const referenced = (value: unknown): boolean => !!value && typeof value === 'object' && Object.entries(value).some(([key, val]) =>
      ['Subject', 'Roles'].includes(key) && (Array.isArray(val) ? val : [val]).some(v => v === 'role:' + oldId || key === 'Roles' && v === oldId) || typeof val === 'object' && referenced(val));
    if (draft.policies.some(p => referenced(p.content))) throw new Error(`Policies still reference role ${oldId}. Update those references before renaming or deleting it.`);
  }
  const lines: string[] = []; const vars = new Map<string, string>();
  const previewOverrides = new Map<number, string>(), previewPolicies = new Map<string, string>();
  const temporaryIds: Record<string, string> = {};
  const resolve = (rid: string): string => vars.get(rid) ?? `lookup(${validateRid(rid)})`;
  const root = (collection: AccessCollection) => collection === 'roles' ? snapshot.roots.roles : snapshot.roots.policies;
  const refFor = (r: AccessRecord): string | null => {
    if (r.kind !== 'RoleAssignment' && !r.kind?.includes('Reference')) return null;
    const field = snapshot.classes[r.source ?? '']?.find(p => p.accessor === r.field?.split('.').at(-1));
    if (!field || field.reference === false || !/Reference|System/.test(field.configClass)) throw new Error(`Unknown reference ${r.source}.${r.field}. Load its live schema and choose a property.`);
    if (r.kind === 'RoleAssignment' && field.principal === false) throw new Error(`${r.field} must refer only to users or groups.`);
    if (r.kind === 'RoleAssignment' && field.targets && !/^\[?(?:(?:User|Group|Principal)[,\s]*)+\]?$/.test(field.targets)) throw new Error(`${r.field} must refer only to users or groups.`);
    return field.rid;
  };
  const props = (collection: AccessCollection, r: AccessRecord, id = r.id, before?: AccessRecord) => {
    const values: string[] = [];
    if (!before || before.id !== id) values.push(`id := ${literal(id)}`);
    if (!before || before.name !== r.name) values.push(`name := ${literal(r.name)}`);
    if (collection === 'policies') {
      if (r.invalidContent) throw new Error(`Fix the invalid JSON in ${r.name} before applying it.`);
      if (!before || before.enabled !== r.enabled) values.push(`enabled := ${r.enabled}`);
      if (!before || canonical(before.content) !== canonical(r.content)) values.push(`contentAsString := ${literal(JSON.stringify(r.content))}`);
    }
    if (collection === 'scope' && (!before || before.source !== r.source || before.field !== r.field)) { const ref = refFor(r); if (ref) values.push(`referenceConfig := lookup(${validateRid(ref)})`); }
    return values.join(', ');
  };
  // error() logs and CONTINUES on BMP. Every mutation must be gated explicitly.
  const guard = (condition: string, label: string) => `IF ${condition} THEN\n _accessValid := false\n error(${literal(label + ' changed in BMP. Reload and reconcile before applying.')})\nENDIF`;
  // Membership uses literal equality; EC '=' treats * in strings as a pattern.
  const differs = (expression: string, expected: string) => `(LIST(${literal(expected)}) CONTAINS ${expression}.whenMissing("")) = false`;
  const recordGuards = (collection: AccessCollection, before: AccessRecord, after?: AccessRecord) => {
    const object = `lookup(${validateRid(before.rid)})`;
    const checks = [guard(`${object} = MISSING`, before.name), guard([
      differs(`${object}.id`, before.id), differs(`${object}.name`, before.name),
      `(LIST(${literal(validateRid(before.parent || root(collection)))}) CONTAINS str(${object}.parent.rid)) = false`,
      differs(`${object}.className`, recordType(collection, before)),
      ...(collection === 'policies' ? [`${object}.enabled != ${before.enabled}`] : []),
      ...(collection === 'scope' && before.referenceConfig ? [`(LIST(${literal(validateRid(before.referenceConfig))}) CONTAINS str(${object}.referenceConfig.rid.whenMissing(0))) = false`] : []),
    ].join(' OR '), before.name)];
    if (collection === 'policies' && (!after || canonical(before.content) !== canonical(after.content))) {
      const text = rawPolicyText.get(before);
      if (text === undefined) throw new Error('Reload this policy before changing its JSON.');
      checks.push(`_policyText := output(${object}.contentAsString)`, guard(differs('_policyText', text), before.name));
    }
    return checks;
  };
  // All preconditions run before the first mutation. This closes the preview gap,
  // but EC does not provide an atomic compare-and-set against other clients.
  for (const d of delta) {
    if (d.collection === 'globals') continue;
    if (d.before) lines.push(...recordGuards(d.collection, d.before, d.after));
    if (d.after && (!d.before || d.before.id !== d.after.id)) lines.push(guard(`root.${['roles', 'scope'].includes(d.collection) ? 'role' : 'accessPolicy'}.descendants.filter(id = ${literal(d.after.id)}).size() > 0`, d.after.id));
  }
  const principals = new Set(delta.filter(d => d.collection === 'globals').flatMap(d => [d.before?.subject, d.after?.subject].filter((s): s is string => !!s)));
  for (const subject of principals) {
    const expected = baseline.globals.filter(g => g.subject === subject).map(g => g.parent);
    const object = `lookup(${validateRid(subject)})`;
    lines.push(guard(`${object}.roles.size() != ${expected.length}${expected.map(rid => ` OR (${object}.roles.calculate(str(self.rid)) CONTAINS ${literal(validateRid(rid))}) = false`).join('')}`, 'Global assignments'));
  }
  const preconditions = lines.splice(0);
  const replaced = delta.filter(d => d.collection === 'scope' && d.before && d.after && d.before.kind !== d.after.kind);
  const pending = delta.filter(d => d.collection !== 'globals' && d.after && !d.before).concat(replaced);
  let index = 0;
  while (pending.length) {
    const pos = pending.findIndex(d => !pending.some(p => p.after!.rid === d.after!.parent));
    if (pos < 0) throw new Error('New records have unresolved parents.');
    const d = pending.splice(pos, 1)[0], r = d.after!, variable = `_access${index++}`;
    const replacement = !!d.before;
    const id = replacement ? 'companion_replace_' + crypto.randomUUID().replaceAll('-', '') : r.id;
    if (replacement) temporaryIds[r.rid] = id;
    lines.push(`${variable} := ${resolve(r.parent || root(d.collection))}.add(${recordType(d.collection, r)}, ${props(d.collection, r, id)})`);
    vars.set(r.rid, variable);
  }
  for (const d of delta.filter(d => d.before && d.after && d.collection !== 'globals' && !replaced.includes(d))) {
    const r = d.after!;
    if (d.before!.parent !== r.parent || vars.has(r.parent)) lines.push(`${resolve(r.rid)}.move(${resolve(r.parent || root(d.collection))})`);
    const values = props(d.collection, r, r.id, d.before);
    if (values) {
      if (d.collection === 'policies' && canonical(d.before!.content) !== canonical(r.content)) {
        // contentAsString writes a serialized configuration blob. On BMP this
        // can survive Calculate rollback even though ordinary fields revert.
        // Validate changed JSON on a disposable policy with its own RID; keep
        // the real policy's exact-text guard intact for the committing command.
        const variable = `_accessPolicyPreview${previewPolicies.size}`;
        const id = 'companion_preview_' + crypto.randomUUID().replaceAll('-', '');
        previewPolicies.set(r.rid, variable);
        previewOverrides.set(lines.length, `${variable} := ${resolve(r.parent || root(d.collection))}.add(AccessPolicy, ${props(d.collection, { ...r, enabled: false }, id)})`);
      }
      lines.push(`${resolve(r.rid)}.change(${values})`);
    }
  }
  for (const d of replaced) {
    for (const child of draft.scope.filter(r => r.parent === d.after!.rid && !r.rid.startsWith('draft:'))) lines.push(`${resolve(child.rid)}.move(${resolve(d.after!.rid)})`);
  }
  // Write each affected principal once, preserving fresh unrelated memberships.
  for (const subject of principals) {
    if (![...snapshot.users, ...snapshot.groups].some(p => p.rid === subject)) throw new Error('The selected user or group no longer exists.');
    const roleIds = new Set(snapshot.model.globals.filter(g => g.subject === subject).map(g => g.parent));
    for (const d of delta.filter(d => d.collection === 'globals')) {
      if (d.before?.subject === subject) roleIds.delete(d.before.parent);
      if (d.after?.subject === subject) roleIds.add(d.after.parent);
    }
    lines.push(`${resolve(subject)}.change(roles := LIST(${[...roleIds].map(resolve).join(', ')}))`);
  }
  const deleted = delta.filter(d => d.before && !d.after && d.collection !== 'globals');
  const beforeAll = COLLECTIONS.flatMap(c => baseline[c]);
  const depth = (r: AccessRecord) => { let n = 0, p = r.parent; const seen = new Set<string>(); while (p && !seen.has(p)) { seen.add(p); n++; p = beforeAll.find(x => x.rid === p)?.parent ?? ''; } return n; };
  // BMP may delete a moved child's old cached subtree when move + delete share
  // a command. Commit moves first, verify them, then delete in a fresh command.
  const finish: string[] = [];
  for (const d of [...deleted, ...replaced].sort((a, b) => depth(b.before!) - depth(a.before!))) {
    finish.push(...recordGuards(d.collection, d.before!), guard(`lookup(${validateRid(d.before!.rid)}).children().size() > 0`, d.before!.name), `IF _accessValid THEN\n lookup(${validateRid(d.before!.rid)}).delete()\nENDIF`);
  }
  const previewFinish = [...finish];
  for (const d of replaced) finish.push(`IF _accessValid THEN\n root.role.descendants.filter(id = ${literal(temporaryIds[d.after!.rid])}).first().change(id := ${literal(d.after!.id)})\nENDIF`);
  for (const d of replaced) previewFinish.push(`IF _accessValid THEN\n ${resolve(d.after!.rid)}.change(id := ${literal(d.after!.id)})\nENDIF`);
  for (const d of delta.filter(d => d.collection === 'policies' && d.after)) {
    const preview = previewPolicies.get(d.after!.rid);
    if (preview) previewOverrides.set(lines.length, `IF ${preview}.valid = false THEN\n error(${literal('Invalid policy: ' + d.after!.name)})\nENDIF`);
    lines.push(`IF ${resolve(d.after!.rid)}.valid = false THEN\n error(${literal('Invalid policy: ' + d.after!.name)})\nENDIF`);
  }
  const nonce = crypto.randomUUID();
  const receipts = { preview: 'ACCESS_PREVIEW_' + nonce, apply: 'ACCESS_APPLY_' + nonce, finish: 'ACCESS_FINISH_' + nonce };
  // One guard per mutation also avoids an empty IF in deletion-only staging.
  const gated = (body: string[], receipt: string) => ['_accessValid := true', ...preconditions, ...body.map(statement => `IF _accessValid THEN\n${statement}\nENDIF`), literal(receipt)].join('\n');
  return { code: gated(lines, receipts.apply), preview: gated([...lines.map((line, i) => previewOverrides.get(i) ?? line), ...previewFinish], receipts.preview), finish: finish.length ? ['_accessValid := true', ...finish, literal(receipts.finish)].join('\n') : undefined, temporaryIds, receipts };
}
