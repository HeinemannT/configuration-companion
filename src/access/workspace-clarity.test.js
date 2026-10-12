// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('keeps reference browsing atomic, list identities visible, and effect/test state connected', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  const { snapshot, classes, object } = clarityFixture();
  let saved, slowSchema;
  let failTask = true;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') {
      if (request.type === 'CeTask' && failTask) throw Error('Offline');
      if (request.type === 'CeTask') return new Promise(resolve => { slowSchema = resolve; });
      return classes[request.type];
    }
    if (request.operation === 'search') return [object];
    if (request.operation === 'trace') return { element: 'TraceRequest', result: true, details: {}, children: [] };
    throw Error('Unexpected request: ' + request.operation);
  });
  const workspace = mountWorkspace({ snapshot, api, persist: async factory => { saved = factory(); }, busy: () => {}, notice: vi.fn() });
  workspace.enter({ kind: 'role', rid: snapshot.model.roles[0].rid });
  const $ = selector => document.querySelector(selector);
  const click = async selector => { await vi.waitFor(() => expect($(selector), selector).not.toBeNull()); $(selector).click(); await new Promise(resolve => setTimeout(resolve, 0)); };
  const close = () => $('#picker-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const selectLabel = async text => {
    const button = [...document.querySelectorAll('#picker-results button')].find(button => button.querySelector('strong')?.textContent === text);
    expect(button, text).not.toBeUndefined(); button.click(); await new Promise(resolve => setTimeout(resolve, 0));
  };
  const delegation = () => saved.model.scope.find(row => row.id === 'related_controls');
  const referenceButton = '[data-scope-editor="9000000000000000003"] [data-command="reference-choose"]';
  await vi.waitFor(() => expect($(referenceButton)).not.toBeNull());
  expect($('textarea[data-rid="9000000000000000003"]').value).toBe('CeControlMeasure.relatedRisk');
  await click(referenceButton);
  await vi.waitFor(() => expect($('.reference-context code').textContent).toBe('CeControlMeasure'));
  expect($('#picker-results [aria-selected="true"] strong').textContent).toBe('Related risk');
  expect(api).toHaveBeenCalledWith({ operation: 'schema', type: 'CeControlMeasure' });
  await click('[data-command="reference-types"]');
  await selectLabel('CeTask');
  expect($('#picker-results').textContent).toContain('Could not load references: Offline');
  failTask = false;
  await click('[data-command="reference-retry"]');
  expect($('#picker-results').textContent).toContain('Loading references');
  expect(document.activeElement).toBe($('#picker-query'));
  close();
  slowSchema(classes.CeTask); await new Promise(resolve => setTimeout(resolve, 0));
  expect($('#picker')).toBeNull();
  await workspace.flush();
  expect(delegation()).toEqual(snapshot.model.scope[1]);
  expect(workspace.hasDraft()).toBe(false);
  // Reopening starts at the stored class, not the abandoned browse destination.
  await click(referenceButton);
  expect($('.reference-context code').textContent).toBe('CeControlMeasure');
  await click('[data-command="reference-types"]'); await selectLabel('CeTask');
  expect($('#picker-results [aria-selected="true"]')).toBeNull();
  await selectLabel('Assigned risk');
  await workspace.flush();
  expect(delegation()).toMatchObject({ source: 'CeTask', field: 'assignedRisk', referenceConfig: '' });
  expect($('textarea[data-rid="9000000000000000003"]').value).toBe('CeTask.assignedRisk');
  await click('[data-command="undo"]'); await workspace.flush();
  expect(delegation()).toEqual(snapshot.model.scope[1]);
  // IDs remain editable; returning to the picker uses the manually chosen class.
  const input = $('textarea[data-rid="9000000000000000003"]'); input.focus(); input.value = 'CeTask.relatedRisk';
  input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  await workspace.flush(); expect(delegation()).toMatchObject({ source: 'CeTask', field: 'relatedRisk' });
  await click(referenceButton); expect($('.reference-context code').textContent).toBe('CeTask'); close();
  await click('[data-command="undo"]');

  await click('[data-open="9000000000000000004"]');
  await vi.waitFor(() => expect($('.list-value-preview')?.textContent).toContain('scope_regional'));
  expect($('.list-value-preview').textContent).toContain('scope_global');
  expect($('.list-value-preview').textContent).toContain('+1 more');
  expect($('#editor').textContent).toContain('1 selected value not found');
  await click('[data-command="schema-value"][data-path=\'["All",1]\']');
  expect($('#picker-selection').textContent).toContain('scope_global');
  expect($('#picker-selection').textContent).toContain('scope_regional');
  await click('[data-command="picker-unselect"][data-token="ListPropertySetItem:scope_global"]');
  close(); await workspace.flush();
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition.Right).toHaveLength(3);
  await click('[data-command="schema-value"][data-path=\'["All",1]\']');
  await click('[data-command="picker-unselect"][data-token="ListPropertySetItem:scope_global"]');
  $('#picker-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect($('#picker')).toBeNull()); await workspace.flush();
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition.Right).toEqual([
    'ListPropertySetItem:scope_regional', 'ListPropertySetItem:removed'
  ]);
  await click('[data-command="undo"]');


  await click('[data-command="check"]');
  expect($('.test-saved-scope').textContent).toBe('All saved policies');
  expect($('.test-seed').textContent).toBe('Inputs from rule 1');
  await click('[data-command="test-action"][data-action-value="Update"]');
  expect($('.test-seed').textContent).toBe('Rule 1 · custom inputs');
  await click('[data-command="test-action"][data-action-value="Read"]');
  await click('[data-command="choose-object"]');
  const query = $('#picker-query'); query.value = 'risk'; query.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect($('#picker-results button')).not.toBeNull());
  await selectLabel(object.name);
  await click('[data-command="prepare-check"]');
  await vi.waitFor(() => expect($('.result-line')?.textContent).toContain('Overall accessAllowed'));
  expect($('.test-saved-scope').textContent).toBe('All saved policies');
  await click('[data-command="rule-effect"][data-effect="Deny"]'); await workspace.flush();
  expect(saved.model.policies[0].content.Statement[0].Effect).toBe('Deny');
  expect($('.effect-note').textContent).toContain('Does not override grants');
  expect($('.test-draft-note').textContent).toBe('Draft edits excluded');
  expect($('.result-stale').textContent).toContain('run again');
  expect($('.object-picker strong').textContent).toBe(object.name);
  await click('[data-command="undo"]'); await workspace.flush();
  expect(saved.model.policies[0].content.Statement[0].Effect).toBe('Allow');
  expect($('[data-effect="Allow"]').getAttribute('aria-pressed')).toBe('true');
  expect(saved.journal.some(event => event.message === 'Rule 1 effect: Deny')).toBe(true);
  // Rules each retain their own inputs; rule 2 does not inherit rule 1's object/result.
  await click('[data-command="choose-rule"]');
  expect($('#picker-results').textContent).toContain('Rule 2 · Deny');
  await click('[data-command="picker-select"][data-index="1"]');
  await click('[data-command="check"]');
  expect($('.test-seed').textContent).toBe('Inputs from rule 2');
  expect($('.result-line')).toBeNull();
  expect($('[data-command="prepare-check"]').disabled).toBe(true);
  expect(api.mock.calls.filter(([request]) => request.operation === 'trace')).toHaveLength(1);
});
