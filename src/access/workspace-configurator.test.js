// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('edits nested Create rules, typed values, history and policy placement without losing context', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes } = clarityFixture(), rid = snapshot.model.policies[0].rid;
  snapshot.model.folders.push({ rid: '9000000000000000040', id: 'review', name: 'Review policies', parent: '' });
  const resource = { All: [
    { All: [], description: 'Nested group' },
    { Condition: { Left: 'new.active', Comparison: 'Equal', Right: false }, comment: 'Preserve a boolean' },
    { Condition: { Left: 'new.tags', Comparison: 'NotContainsAny', Right: ['a,b', 'c'] } }
  ], description: 'Create eligibility' };
  snapshot.model.policies[0].content.Statement = [{ Subject: '*', Effect: 'Allow', Action: ['CREATE'], Resource: resource }];
  let saved;
  const workspace = mountWorkspace({ snapshot, api: async request => classes[request.type] || [],
    persist: async factory => { saved = factory(); }, busy: () => {}, notice: () => {} });
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { expect($(selector), selector).not.toBeNull(); $(selector).click(); await tick(); };
  const stored = () => saved.model.policies[0].content.Statement[0].Resource;
  const key = async value => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); await tick(); };
  await workspace.enter({ kind: 'policy', rid }); await tick();
  expect($('[aria-label="Comparison: Equal"]').textContent).toContain('is');
  expect($('[aria-label="Remove group"]')).not.toBeNull();
  await click('[aria-label="Remove group"]');
  expect(stored().All).toHaveLength(2);
  expect(stored().description).toBe('Create eligibility');
  await click('[data-command="undo"]'); expect(stored()).toEqual(resource);

  await click('[data-command="edit-condition-value"]');
  expect($('#node-json').value).toBe('false');
  $('#node-json').value = 'true';
  await click('#dialog-form button[type="submit"]');
  expect(stored().All[1].Condition.Right).toBe(true);
  expect(stored().All[1].comment).toBe('Preserve a boolean');
  expect(stored().All[2].Condition.Right).toEqual(['a,b', 'c']);
  await click('[data-command="undo"]'); expect(stored()).toEqual(resource);

  await click('.section-heading [data-command="add-condition"]');
  await click('[data-node="Condition"]');
  expect(stored().All.at(-1).Condition.Left).toBe('new.type');
  expect(stored().All.slice(0, 3)).toEqual(resource.All);
  await click('[data-command="undo"]');

  const history = '.history-actions [data-command="history"]';
  await click(history);
  expect($('#history-title')).not.toBeNull();
  expect($$('#tabs [data-command="history"]')).toHaveLength(0);
  expect($(history).getAttribute('aria-pressed')).toBe('true');
  await key('Escape');
  expect($('#history-title')).toBeNull();
  expect(document.activeElement).toBe($(history));
  expect($('[data-action="Create"]').checked).toBe(true);

  await click('[data-action="Update"]');
  await click('[data-command="review"]');
  expect($('#tabs .review-tab [aria-selected="true"]')).not.toBeNull();
  await click(history);
  const historyRoute = structuredClone(window.history.state);
  await click(history);
  expect($('#tabs .review-tab [aria-selected="true"]')).not.toBeNull();
  // Revisiting History through browser Back must retain its original return view.
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: historyRoute })); await tick();
  await key('Escape');
  expect($('#tabs .review-tab [aria-selected="true"]')).not.toBeNull();

  await workspace.enter({ kind: 'test', object: { rid: '8000000000000000001', name: 'Selected object', type: 'CeRiskAssessment' } }); await tick();
  await click(history);
  const testHistoryRoute = structuredClone(window.history.state);
  await click(history);
  expect($('#tabs [data-command="open-test"]').getAttribute('aria-selected')).toBe('true');
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: testHistoryRoute })); await tick();
  await key('Escape');
  expect($('#tabs [data-command="open-test"]').getAttribute('aria-selected')).toBe('true');
  expect($('#dock').innerText).toContain('Selected object');

  await click(`[data-open="${rid}"]`);
  await click('[data-command="record-more"]');
  expect($('#menu [data-command="context-move"]')).toBeNull();
  expect($('#editor [data-command="choose-folder"]')).toBeNull();
  const row = $(`#tree [data-drag-rid="${rid}"]`);
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await tick();
  await click('#menu [data-command="context-move"]');
  expect(document.body.classList.contains('tree-dragging')).toBe(true);
  $('[data-drop-folder="9000000000000000040"]').focus();
  await key('Enter');
  expect(saved.model.policies[0].parent).toBe('9000000000000000040');
  await click('[data-command="undo"]');
  expect(saved.model.policies[0].parent).toBe('');
});
