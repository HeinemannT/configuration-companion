// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';
import { encodeWorkspaceState, decodeWorkspaceState, recoverAppliedWorkspace } from './workspace-state.js';

function interruptedApply() {
  const { snapshot, classes, object } = clarityFixture();
  const draft = structuredClone(snapshot.model), role = draft.roles[0], policy = draft.policies[0];
  const mapping = { 'draft:role': role.rid, 'draft:policy': policy.rid };
  role.rid = 'draft:role'; policy.rid = 'draft:policy';
  const create = { resource: object.rid, proposed: JSON.stringify({ type: object.type, parent_rid: object.rid, properties: { count: 0 } }),
    createInitialized: true, createFields: ['count'], createNumberDrafts: { count: '1e' },
    createLabels: { [object.rid]: object.name }, result: { trace: { result: false } } };
  const test = { mode: 'role', subject: role.rid, action: 'Update', resource: object.rid, updateMode: 'custom',
    proposed: '{unfinished', rename: 'Prepared name', scenarios: { Create: create }, result: { running: true } };
  const saved = { version: 1, revision: 8, snapshot, model: draft, baseline: snapshot.model,
    history: [1], future: [], journal: [{ id: 1 }], historySequence: 1,
    context: { objects: [object], prototypes: [], users: [], groups: [] },
    state: encodeWorkspaceState({ kind: 'policy', rid: policy.rid, empty: false,
      tabs: [{ kind: 'role', rid: role.rid }, { kind: 'policy', rid: policy.rid }],
      tests: new Map([[`policy:${policy.rid}:0`, test], [`role:${role.rid}:0`, test], [`object:${object.rid}`, test],
        ['policy:deleted:0', test], [`policy:${policy.rid}:9`, test]]),
      testOpen: new Set([`policy:${policy.rid}:0`, `role:${role.rid}:0`, `object:${object.rid}`, 'policy:deleted:0']),
      raw: new Map(), idDraft: new Map(), view: 'json', technical: true, collapsedSections: new Set(['scope']) }) };
  return { saved, receipt: { snapshot, mapping, draft: structuredClone(draft) }, classes, object, test, create };
}

it('reopens a completed Apply with its prepared tests, open docks and inactive Create values', async () => {
  const { saved, receipt, classes, object, test, create } = interruptedApply();
  const before = structuredClone(saved), recovered = recoverAppliedWorkspace(saved, receipt);
  expect(saved).toEqual(before);
  expect(recovered).toMatchObject({ revision: 9, history: [], future: [], journal: [], historySequence: 0 });
  const state = decodeWorkspaceState(recovered.state), { roles, policies } = receipt.snapshot.model;
  const keys = [`policy:${policies[0].rid}:0`, `role:${roles[0].rid}:0`, `object:${object.rid}`];
  expect(state.rid).toBe(policies[0].rid);
  expect(state.tabs.map(tab => tab.rid)).toEqual([roles[0].rid, policies[0].rid]);
  expect([...state.tests.keys()]).toEqual(keys);
  expect([...state.testOpen]).toEqual(keys);
  expect(state.technical).toBe(true);
  expect(state.view).toBe('json');
  expect(state.collapsedSections).toEqual(new Set(['scope']));
  for (const key of keys) expect(state.tests.get(key)).toEqual({ ...test, subject: roles[0].rid, result: null, rerunRequired: true,
    scenarios: { Create: { ...create, result: null, rerunRequired: true } } });

  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  let stored;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] ?? [];
    throw Error('Unexpected operation: ' + request.operation);
  });
  const workspace = mountWorkspace({ snapshot: receipt.snapshot, saved: recovered, api,
    notice: vi.fn(), busy: vi.fn(), persist: async read => { stored = read(); } });
  await workspace.flush();
  expect(document.querySelector('#dock').hidden).toBe(false);
  expect(document.querySelector('[data-check="proposed"]').value).toBe('{unfinished');
  expect(document.querySelector('#dock').textContent).toContain('Run this test again');
  document.querySelector('[data-command="test-action"][data-action-value="Create"]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-create-value="count"]')?.value).toBe('1e'));
  await workspace.flush();
  const active = stored.state.tests.$map.find(([key]) => key === keys[0])[1];
  expect(active.createLabels[object.rid]).toBe(object.name);
  expect(active.result).toBeNull();
  expect(api.mock.calls.every(([request]) => request.operation === 'schema')).toBe(true);
});

it('leaves a newer local draft untouched instead of recovering an older receipt over it', () => {
  const { saved, receipt } = interruptedApply();
  saved.model.policies[0].name = 'A newer local edit';
  const before = structuredClone(saved);
  expect(recoverAppliedWorkspace(saved, receipt)).toBeUndefined();
  expect(saved).toEqual(before);
});
