import type { BmpClient } from '../bmp-client';
import { canonical, changes, type AccessModel, type AccessRequest, type AccessTask, type AccessSnapshot } from './model';
import { readAccess, readSchema, searchAccessObjects, searchAccessPrincipals, readAccessPrincipals, searchListItems, type ReadContext } from './read';
import { assertNoConflicts, buildApplyPlan, validateModel } from './write';
import { traceAccess } from './trace';
import { shareRead } from './requests';
import { requireReceipt } from './response';
import { readJournal, writeJournal, removeJournal, type ApplyJournal } from './journal';
import { startOperation, operationStatus, cancelOperation, releaseOperation } from './operations';

const applying = new Set<string>();
export const recoveryKey = (environment: string) => 'access-pending:' + environment;
async function recovery(environment: string): Promise<{ id?: string } | undefined> {
  return (await chrome.storage.local.get(recoveryKey(environment)))[recoveryKey(environment)] as { id?: string } | undefined;
}

/** Merge only the user's changes into a fresh read, preserving concurrent unrelated edits. */
export function mergeDraft(baseline: AccessModel, draft: AccessModel, live: AccessModel): AccessModel {
  const merged = structuredClone(live);
  for (const d of changes(baseline, draft)) {
    const rid = (d.before ?? d.after)!.rid;
    merged[d.collection] = merged[d.collection].filter(r => r.rid !== rid);
    if (d.after) merged[d.collection].push(d.after);
  }
  validateModel(merged, live);
  return merged;
}

/** Resolve newly created and replacement RIDs after BMP assigns them. */
export function verifyApplied(baseline: AccessModel, draft: AccessModel, saved: AccessModel, pending?: { temporaryIds: Record<string, string> }): Record<string, string> {
  const mapping: Record<string, string> = {};
  const delta = changes(baseline, draft);
  for (const d of delta) if (d.after && d.collection !== 'globals') {
    const actual = saved[d.collection].find(r => r.id === (pending?.temporaryIds[d.after!.rid] ?? d.after!.id));
    if (!actual) throw new Error(`BMP did not save ${d.after.name}.`);
    mapping[d.after.rid] = actual.rid;
  }
  // Retained branches also require verification when their parent's native RID changes.
  for (const collection of ['roles', 'policies', 'scope', 'folders'] as const) {
    for (const r of draft[collection]) if (mapping[r.parent] && mapping[r.parent] !== r.parent && !delta.some(d => d.after?.rid === r.rid)) {
      delta.push({ collection, before: baseline[collection].find(b => b.rid === r.rid), after: r });
      mapping[r.rid] = r.rid;
    }
  }
  for (const d of delta) {
    if (!d.after) {
      if (pending && d.collection !== 'globals') continue;
      if (saved[d.collection].some(r => r.rid === d.before!.rid)) throw new Error(`BMP did not remove ${d.before!.name || d.before!.subjectName}.`);
      continue;
    }
    const expected = d.after;
    const parent = mapping[expected.parent] ?? expected.parent;
    if (d.collection === 'globals') {
      if (!saved.globals.some(g => g.subject === expected.subject && g.parent === parent)) throw new Error('BMP did not save the global assignment.');
      continue;
    }
    const actual = saved[d.collection].find(r => r.rid === mapping[expected.rid]);
    if (!actual || actual.name !== expected.name || actual.parent !== parent ||
      d.collection === 'scope' && (actual.kind !== expected.kind || actual.field !== expected.field?.split('.').at(-1) || actual.source !== expected.source) ||
      d.collection === 'policies' && (actual.enabled !== expected.enabled || canonical(actual.content) !== canonical(expected.content))) {
      throw new Error(`BMP returned different values for ${expected.name}. Reload to reconcile.`);
    }
  }
  return mapping;
}

export async function handleAccessRequest(client: BmpClient, environment: string, name: string, request: AccessRequest, assertEnvironment: () => void): Promise<unknown> {
  if (request.operation === 'status') return operationStatus(request.id, environment);
  if (request.operation === 'cancel') { cancelOperation(request.id, environment); return {}; }
  if (request.operation === 'acknowledge') {
    const journal = await readJournal(request.id);
    if (journal?.environment === environment && journal.phase === 'complete') {
      const pending = await recovery(environment);
      if (pending?.id === request.id) await chrome.storage.local.remove(recoveryKey(environment));
      await removeJournal(request.id);
    }
    releaseOperation(request.id, environment); return {};
  }
  if (request.operation === 'start') {
    assertEnvironment();
    if (await readJournal(request.id)) return { id: request.id };
    startOperation(request.id, environment, request.task.operation === 'apply', context => runTask(client, environment, name, request.task, assertEnvironment, context, request.id));
    return { id: request.id };
  }
  return runTask(client, environment, name, request, assertEnvironment);
}

async function runTask(client: BmpClient, environment: string, name: string, request: AccessTask, assertEnvironment: () => void, context: ReadContext = {}, operationId: string = crypto.randomUUID()): Promise<unknown> {
  assertEnvironment();
  if (request.operation === 'schema') return shareRead(client, 'schema:' + request.type, signal => readSchema(client, request.type, signal), context.signal);
  if (request.operation === 'search') return shareRead(client, canonical(request), signal => searchAccessObjects(client, request.query, request.type, request.prototypes, signal, request.containers, request.containerFor), context.signal);
  if (request.operation === 'principals') return shareRead(client, canonical(request), signal => searchAccessPrincipals(client, request.query, request.kind, signal), context.signal);
  if (request.operation === 'listItems') return shareRead(client, canonical(request), signal => searchListItems(client, request.set, request.query, signal, request.selected), context.signal);
  if (request.operation === 'trace') return traceAccess(client, request.request, assertEnvironment);
  if (request.operation === 'load') {
    const snapshot = await readAccess(client, environment, name, context);
    const pending = await recovery(environment);
    const journal = pending?.id ? await readJournal(pending.id) : undefined;
    return { snapshot, recoveryRequired: !!pending && journal?.phase !== 'complete', receipt: journal?.phase === 'complete' ? { ...journal.result, draft: journal.submittedDraft } : undefined };
  }
  if (request.operation === 'reconcile') {
    if (applying.has(environment)) throw new Error('Wait for the current apply to finish before reloading.');
    applying.add(environment);
    try {
      // A fresh, explicit server reload is required before retrying an uncertain write.
      const snapshot = await readAccess(client, environment, name, context);
      assertEnvironment();
      const pending = await recovery(environment);
      await chrome.storage.local.remove(recoveryKey(environment));
      if (pending?.id) await removeJournal(pending.id);
      return { snapshot };
    } finally { applying.delete(environment); }
  }
  if (applying.has(environment)) throw new Error('An apply is already running for this environment.');
  applying.add(environment);
  try {
    if ((await chrome.storage.local.get(recoveryKey(environment)))[recoveryKey(environment)]) throw new Error('A previous apply needs reconciliation. Reload from BMP before applying again.');
    validateModel(request.baseline, request.baseline); validateModel(request.draft, request.baseline);
    if (changes(request.baseline, request.draft).length > 200) throw new Error('Apply at most 200 record changes at once.');
    context.progress?.('Checking for changes in BMP…');
    const live = await readAccess(client, environment, name, context);
    assertEnvironment();
    const known = new Set([...live.users, ...live.groups].map(p => p.rid));
    const subjects = changes(request.baseline, request.draft).filter(d => d.collection === 'globals' && d.after?.subject && !known.has(d.after.subject)).map(d => d.after!.subject!);
    const principals = await readAccessPrincipals(client, subjects);
    for (const p of principals.choices) (p.type === 'User' ? live.users : live.groups).push(p);
    // A newly chosen principal can gain another role after the inventory read.
    // Preserve the fresh memberships before merging our requested changes.
    live.model.globals.push(...principals.memberships);
    assertNoConflicts(request.baseline, request.draft, live.model);
    // Every edited RID must belong to the access catalogue returned by BMP.
    for (const d of changes(request.baseline, request.draft)) if (d.before && !live.model[d.collection].some(r => r.rid === d.before!.rid)) throw new Error('An edited record no longer exists.');
    const merged = mergeDraft(request.baseline, request.draft, live.model);
    const sourceTypes = new Set(changes(live.model, merged).filter(d => d.collection === 'scope' && d.after?.source).map(d => d.after!.source!));
    for (const type of sourceTypes) live.classes[type] = await readSchema(client, type);
    const plan = buildApplyPlan(live.model, merged, live);
    context.progress?.('Previewing changes in BMP…');
    const preview = await client.executeEc(plan.preview, undefined, false, undefined, 120_000);
    requireReceipt(preview, plan.receipts.preview);
    assertEnvironment();
    // Persist the complete intent before dispatch. Never replay it automatically.
    const journal: ApplyJournal = { id: operationId, environment, at: new Date().toISOString(), phase: 'writing', baseline: live.model, draft: merged, submittedDraft: request.draft, temporaryIds: plan.temporaryIds };
    await writeJournal(journal);
    await chrome.storage.local.set({ [recoveryKey(environment)]: { id: operationId, at: journal.at } });
    assertEnvironment();
    context.progress?.('Saving changes in BMP…');
    const applied = await client.executeEc(plan.code, undefined, true, undefined, 120_000);
    requireReceipt(applied, plan.receipts.apply);
    journal.phase = 'verifying'; await writeJournal(journal);
    if (plan.finish) {
      const staged = await readAccess(client, environment, name, context);
      verifyApplied(live.model, merged, staged.model, { temporaryIds: plan.temporaryIds });
      // Refuse to cascade-delete a branch added while this apply was running.
      const removed = new Set(changes(live.model, merged).filter(d => d.before && (!d.after || plan.temporaryIds[d.before.rid])).map(d => d.before!.rid));
      if (Object.values(staged.model).flat().some(r => removed.has(r.parent) && !removed.has(r.rid))) throw new Error('A branch still belongs to a record pending deletion. Reload from BMP to reconcile before continuing.');
      // This finishes an already-started apply against the captured environment,
      // including when the sidebar switches connection during the operation.
      journal.phase = 'finishing'; await writeJournal(journal);
      context.progress?.('Finishing verified moves and deletions…');
      const finished = await client.executeEc(plan.finish, undefined, true, undefined, 120_000);
      requireReceipt(finished, plan.receipts.finish);
    }
    context.progress?.('Verifying saved changes…');
    const snapshot: AccessSnapshot = await readAccess(client, environment, name, context);
    const mapping = verifyApplied(live.model, merged, snapshot.model);
    const result = { snapshot, mapping, operationId };
    journal.phase = 'complete'; journal.result = result; await writeJournal(journal);
    // Keep the receipt until the tab has durably saved its new baseline.
    return result;
  } finally { applying.delete(environment); }
}
