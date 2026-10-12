// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('keeps overall tests available after a JSON reorder without attributing the saved rule to a different draft', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes, object } = clarityFixture(), policy = snapshot.model.policies[0];
  const key = 'policy:' + policy.rid + ':0';
  const trace = { element: 'TraceRequest', result: true, timedOut: false, details: {}, children: [
    { element: 'Statement', result: true, timedOut: false, details: { policyRid: policy.rid, statementIndex: '0', effect: 'ALLOW' }, children: [] }
  ] };
  let stored;
  const notice = vi.fn();
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] || [];
    if (request.operation === 'trace') return structuredClone(trace);
    throw Error('Unexpected operation: ' + request.operation);
  });
  const workspace = mountWorkspace({ snapshot, api, notice, busy: () => {}, persist: async read => { stored = read(); },
    saved: { model: structuredClone(snapshot.model), baseline: snapshot.model,
      state: { kind: 'policy', rid: policy.rid, empty: false, tabs: [{ kind: 'policy', rid: policy.rid }], testOpen: { $set: [key] },
        tests: { $map: [[key, { mode: 'role', subject: snapshot.model.roles[0].rid, action: 'Read', resource: object.rid, proposed: '{}', result: null }]] } },
      context: { objects: [object], prototypes: [], users: [], groups: [] } }
  });
  const $ = selector => document.querySelector(selector);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { expect($(selector), selector).not.toBeNull(); $(selector).click(); await tick(); };
  const editJSON = async content => {
    await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull());
    const view = EditorView.findFromDOM($('.cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: JSON.stringify(content, null, 2) } });
    await tick();
  };
  await click('[data-command="prepare-check"]');
  expect($('.selected-rule-result').textContent).toContain('Granted access');
  expect($('.trace-open').disabled).toBe(false);
  await click('[data-view="json"]');
  const reordered = { ...policy.content, Statement: [...policy.content.Statement].reverse() };
  await editJSON(reordered);
  expect($('.selected-rule-result')).toBeNull();
  expect($('.trace-open').disabled).toBe(true);
  // Returning to the exact model text restores safe attribution without a new request.
  await editJSON(policy.content);
  expect($('.selected-rule-result')).not.toBeNull();
  expect($('.trace-open').disabled).toBe(false);
  await editJSON(reordered);
  await click('[data-command="apply-json"]');
  await click('[data-command="prepare-check"]');
  expect($('#check-result').textContent).toContain('Allowed');
  expect($('.selected-rule-result')).toBeNull();
  expect($('.trace-open').disabled).toBe(true);
  expect(stored.state.tests.$map.find(([k]) => k === key)[1].result.selectedRule).toBeNull();

  // An external trace link is subject to the same guard as the disabled button.
  workspace.enter({ kind: 'policy', rid: policy.rid, statement: 1 }); await tick();
  expect(notice).toHaveBeenLastCalledWith(expect.stringContaining('saved rule differs'));
  expect(stored.state.statement).toBe(0);
  await click('[data-command="undo"]');
  await click('[data-command="prepare-check"]');
  expect($('.selected-rule-result').textContent).toContain('Granted access');
  expect($('.trace-open').disabled).toBe(false);
  expect(api.mock.calls.filter(([r]) => r.operation === 'trace')).toHaveLength(3);
});
