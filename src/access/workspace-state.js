import { canonical } from '../lib/access-workspace/model';
import { testsAfterApply } from './workflow-model.js';

// Keep the persisted v1 format in one place. Recovery must use the same Map/Set
// representation as the live workspace, including inactive test scenarios.
export function encodeWorkspaceState(state) {
  return JSON.parse(JSON.stringify(state, (_key, value) => value instanceof Map
    ? { $map: [...value] } : value instanceof Set ? { $set: [...value] } : value));
}

export function decodeWorkspaceState(state) {
  return JSON.parse(JSON.stringify(state ?? {}), (_key, value) => value && Array.isArray(value.$map)
    ? new Map(value.$map) : value && Array.isArray(value.$set) ? new Set(value.$set) : value);
}

/** The shared transition for a verified Apply, live or recovered after closing
 * the tab. Replace test objects so pending traces cannot repopulate old results. */
export function stateAfterApply(state, model, mapping = {}) {
  const map = rid => mapping[rid] ?? rid;
  return {
    rid: map(state.rid),
    tabs: (state.tabs ?? []).map(tab => ({ ...tab, rid: map(tab.rid) })),
    ...testsAfterApply(state.tests ?? new Map(), state.testOpen ?? new Set(), model, mapping),
    raw: new Map(),
    idDraft: new Map(),
  };
}

/** A receipt can replace only its exact submitted draft. The caller persists
 * this result before acknowledging the receipt to the service worker. */
export function recoverAppliedWorkspace(saved, receipt) {
  if (canonical(saved.model) !== canonical(receipt.draft)) return undefined;
  const state = decodeWorkspaceState(saved.state);
  return {
    ...saved,
    model: receipt.snapshot.model,
    baseline: receipt.snapshot.model,
    snapshot: receipt.snapshot,
    revision: (saved.revision ?? 0) + 1,
    history: [], future: [], journal: [], historySequence: 0,
    state: encodeWorkspaceState({ ...state, ...stateAfterApply(state, receipt.snapshot.model, receipt.mapping) }),
  };
}
