// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('retains prepared tests through both JSON acceptance paths and Apply without reviving old results', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes, object } = clarityFixture(), policy = snapshot.model.policies[0];
  const key = 'policy:' + policy.rid + ':0', objectKey = 'object:' + object.rid;
  const create = { resource: object.rid, proposed: JSON.stringify({ type: 'CeRiskAssessment', parent_rid: object.rid, properties: { count: 0 } }),
    createInitialized: true, createFields: ['count'], createNumberDrafts: { count: '1e' }, createLabels: { [object.rid]: object.name },
    result: { trace: { result: false } } };
  const prepared = { mode: 'role', subject: snapshot.model.roles[0].rid, action: 'Update', resource: object.rid,
    updateMode: 'custom', proposed: '{"type":"CeRiskAssessment","properties":{"name":"Prepared change"}}', rename: 'Remembered rename',
    scenarios: { Create: create }, result: null };
  let stored, resolveTrace, pending = true;
  const trace = { element: 'TraceRequest', result: true, timedOut: false, details: {}, children: [
    { element: 'Statement', result: true, timedOut: false, details: { policyRid: policy.rid, statementIndex: '0', effect: 'ALLOW' }, children: [] }
  ] };
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] || [];
    if (request.operation === 'trace') return pending ? new Promise(resolve => { resolveTrace = resolve; }) : structuredClone(trace);
    if (request.operation === 'apply') return { snapshot: { ...snapshot, model: structuredClone(request.draft) }, mapping: {}, operationId: 'receipt' };
    if (request.operation === 'acknowledge') return {};
    throw Error('Unexpected operation: ' + request.operation);
  });
  const workspace = mountWorkspace({ snapshot, api, notice: vi.fn(), busy: () => {}, persist: async read => { stored = read(); },
    saved: { model: structuredClone(snapshot.model), baseline: snapshot.model,
      state: { kind: 'policy', rid: policy.rid, empty: false, tabs: [{ kind: 'policy', rid: policy.rid }],
        tests: { $map: [[key, prepared], [objectKey, prepared]] }, testOpen: { $set: [key, objectKey] } },
      context: { objects: [object], prototypes: [], users: [], groups: [] } }
  });
  const $ = selector => document.querySelector(selector);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { expect($(selector), selector).not.toBeNull(); $(selector).click(); await tick(); };
  const request = (which = key) => stored.state.tests.$map.find(([k]) => k === which)[1];
  const editJSON = async content => {
    if (!$('.cm-editor')) await click('[data-view="json"]');
    await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull());
    const view = EditorView.findFromDOM($('.cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: JSON.stringify(content, null, 2) } });
    await tick();
  };
  await tick();
  await click('[data-command="prepare-check"]');
  expect(request().result.running).toBe(true);
  const content = { ...policy.content, description: 'First JSON acceptance' };
  await editJSON(content);
  await click('[data-command="apply-json"]');
  expect(request()).toMatchObject({ ...prepared, result: null, scenarios: { Create: { ...create, result: null } } });
  expect(stored.state.testOpen.$set).toContain(key);
  expect($('#dock').hidden).toBe(false);
  expect($('[data-check="proposed"]').value).toBe(prepared.proposed);
  resolveTrace(trace); await tick(); pending = false;
  expect(request().result).toBeNull();
  expect($('#check-result').textContent).toBe('');

  await click('[data-command="prepare-check"]');
  expect(request().result.trace.result).toBe(true);
  await editJSON({ ...content, description: 'Accepted by switching to Rules' });
  await click('[data-view="rules"]');
  expect(request().result).toBeNull();
  expect($('[data-check="proposed"]').value).toBe(prepared.proposed);
  await click('[data-command="test-action"][data-action-value="Create"]');
  expect(request()).toMatchObject({ ...create, result: null });
  expect($('[data-create-value="count"]').value).toBe('1e');
  await click('[data-command="test-action"][data-action-value="Update"]');
  expect(request().proposed).toBe(prepared.proposed);
  await click('[data-command="prepare-check"]');
  expect(request().result.trace.result).toBe(true);

  await click('[data-command="review"]');
  await click('[data-command="apply-workspace"]');
  expect(api.mock.calls.filter(([r]) => r.operation === 'apply')).toHaveLength(1);
  expect(api.mock.calls.some(([r]) => r.operation === 'acknowledge' && r.id === 'receipt')).toBe(true);
  for (const which of [key, objectKey]) {
    expect(request(which)).toMatchObject({ resource: object.rid, proposed: prepared.proposed, updateMode: 'custom', result: null, rerunRequired: true });
    expect(request(which).scenarios.Create).toMatchObject({ ...create, result: null, rerunRequired: true });
    expect(stored.state.testOpen.$set).toContain(which);
  }
  workspace.enter({ kind: 'test', object }); await tick();
  expect($('[data-check="proposed"]').value).toBe(prepared.proposed);
  expect($('#dock').textContent).toContain(object.name);
  expect($('#dock').textContent).toContain('Run this test again');
});
