// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('searches a remote list, resolves selected items and cancels obsolete picker requests', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes } = clarityFixture();
  const property = classes.CeRiskAssessment.find(p => p.listSet), selected = property.listSet.items.slice(0, 2);
  property.listSet = { ...property.listSet, partial: true, items: [] };
  const remote = { rid: '8000000000000000001', id: 'remote', name: 'Remote', type: 'ListPropertySetItem', token: 'ListPropertySetItem:remote' };
  let saved;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type];
    if (request.operation === 'listItems') return { choices: request.query ? [remote] : selected.slice(0, 1), hasMore: !request.query, selected };
    throw Error('Unexpected request');
  });
  const workspace = mountWorkspace({ snapshot, api, persist: async factory => { saved = factory(); }, busy: () => {}, notice: vi.fn() });
  const $ = selector => document.querySelector(selector);
  $('[data-open="9000000000000000004"]').click();
  await vi.waitFor(() => expect($('[data-command="schema-value"][data-path=\'["All",1]\']')).not.toBeNull());
  $('[data-command="schema-value"][data-path=\'["All",1]\']').click();
  await vi.waitFor(() => expect($('#picker-selection')?.textContent).toContain('Central'), { timeout: 2000 });
  expect($('#picker-footer').textContent).toContain('refine search');
  const firstSignal = api.mock.calls.find(([request]) => request.operation === 'listItems')[1].signal;
  const query = $('#picker-query'); query.value = 'remote'; query.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect($('#picker-results')?.textContent).toContain('Remote'), { timeout: 2000 });
  expect(firstSignal.aborted).toBe(true);
  const currentSignal = api.mock.calls.filter(([request]) => request.operation === 'listItems').at(-1)[1].signal;
  [...document.querySelectorAll('#picker-results button')].find(button => button.querySelector('strong')?.textContent === 'Remote').click();
  await vi.waitFor(() => expect($('#picker-selection').textContent).toContain('remote'));
  query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect($('#picker')).toBeNull());
  expect(currentSignal.aborted).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  await workspace.flush();
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition.Right).toContain(remote.token);
});
