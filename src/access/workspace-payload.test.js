// @vitest-environment happy-dom
// Pins what the Access workspace sends to the server. The interface may change;
// the apply payload and the access-test request for the same edits must not.
// The stored snapshot was recorded before the Access workspace redesign.
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

function setup(saved) {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  const calls = [];
  const api = vi.fn(async request => {
    calls.push(structuredClone(request));
    if (request.operation === 'schema') return fixture.classes[request.type] || [];
    if (request.operation === 'trace') return { element: 'TraceRequest', result: true, timedOut: false, details: {}, children: [] };
    if (request.operation === 'apply') return { snapshot: { ...fixture.snapshot, model: structuredClone(request.draft) }, mapping: {}, operationId: 'receipt' };
    if (request.operation === 'acknowledge') return {};
    if (request.operation === 'search') return [fixture.object];
    return [];
  });
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice: vi.fn(), busy: () => {}, persist: async () => {}, saved: saved?.(fixture) });
  const $ = selector => document.querySelector(selector);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { await vi.waitFor(() => expect($(selector), selector).not.toBeNull()); $(selector).click(); await tick(); };
  return { ...fixture, api, calls, workspace, $, tick, click };
}

it('sends the same apply payload for representative policy edits', async () => {
  const { snapshot, calls, $, tick, click } = setup();
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  await click('[data-action="Delete"]');
  // The effect is no longer an edit: the server is grant-only, so Deny is not offered.
  await click('[data-command="logic-group"][data-value="Any"]');
  await click('[data-record="enabled"]');
  // Copy the first statement (after the edits above) to the end of the list.
  // Earlier UI: the rule menu's Duplicate. Redesign: the row's Duplicate tool.
  if ($('[data-command="statement-duplicate"][data-index="0"]')) await click('[data-command="statement-duplicate"][data-index="0"]');
  else { await click('[data-command="rule-menu"]'); await click('[data-command="copy-statement"]'); }
  // A JSON-only edit with a property the Rules view does not represent.
  await click('[data-view="json"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull(), { timeout: 10_000 });
  const view = EditorView.findFromDOM($('.cm-editor'));
  const content = JSON.parse(view.state.doc.toString());
  content.Statement[1].Resource = { All: [content.Statement[1].Resource, { Condition: { Left: 'resource.status', Comparison: '!=', Right: 'Retired', Extra: [1, 'two'] }, description: 'kept here' }] };
  content.Statement[1]['X-Note'] = { kept: true };
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: JSON.stringify(content, null, 2) } });
  await tick();
  await click('[data-command="apply-json"]');
  await click('[data-view="rules"]');
  await click('[data-command="review"]');
  await click('[data-command="apply-workspace"]');
  const applied = calls.filter(call => call.operation === 'apply');
  expect(applied).toHaveLength(1);
  expect(applied[0].baseline).toEqual(snapshot.model);
  expect(JSON.stringify(applied[0].draft, null, 1)).toMatchSnapshot();
});

it('sends a stored Deny statement back unchanged when other edits are saved', async () => {
  const { snapshot, calls, $, click } = setup();
  const policy = snapshot.model.policies[0], storedDeny = structuredClone(policy.content.Statement[1]);
  expect(storedDeny.Effect).toBe('Deny');
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  // Shown as it is, read-only, with the plain note and one way out.
  expect($('[data-statement-row="1"]').closest('.st-item').querySelector('.st-ignored').textContent)
    .toContain('The server ignores this statement. Deny grants nothing and blocks nothing.');
  await click('[data-command="select-statement"][data-index="1"]');
  expect($('#st-detail .effect-value').textContent).toBe('Deny');
  expect($('[data-command="rule-effect"]')).toBeNull();
  // An ordinary edit elsewhere, then load the JSON and apply it unchanged.
  await click('[data-command="select-statement"][data-index="0"]');
  await click('[data-action="Delete"]');
  await click('[data-view="json"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull(), { timeout: 10_000 });
  expect(JSON.parse(EditorView.findFromDOM($('.cm-editor')).state.doc.toString()).Statement[1]).toEqual(storedDeny);
  await click('[data-view="rules"]');
  await click('[data-command="review"]');
  await click('[data-command="apply-workspace"]');
  const applied = calls.filter(call => call.operation === 'apply');
  expect(applied).toHaveLength(1);
  const sent = applied[0].draft.policies.find(p => p.rid === policy.rid).content.Statement;
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(storedDeny);
  expect(sent[0].Action).toEqual(['Read', 'Delete']);
});

it('sends the same access-test request for a prepared check', async () => {
  const { snapshot, object, calls, click } = setup(({ snapshot, object }) => {
    const policy = snapshot.model.policies[0], key = 'policy:' + policy.rid + ':0';
    const prepared = { mode: 'role', subject: snapshot.model.roles[0].rid, action: 'Update', resource: object.rid,
      updateMode: 'custom', proposed: '{"type":"CeRiskAssessment","properties":{"name":"Prepared change"}}', result: null };
    return { model: structuredClone(snapshot.model), baseline: snapshot.model,
      state: { kind: 'policy', rid: policy.rid, empty: false, tabs: [{ kind: 'policy', rid: policy.rid }],
        tests: { $map: [[key, prepared]] }, testOpen: { $set: [key] } },
      context: { objects: [object], prototypes: [], users: [], groups: [] } };
  });
  expect(snapshot && object).toBeTruthy();
  await click('[data-command="prepare-check"]');
  const traces = calls.filter(call => call.operation === 'trace');
  expect(traces).toHaveLength(1);
  expect(JSON.stringify(traces[0])).toMatchSnapshot();
});
