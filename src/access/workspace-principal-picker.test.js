// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('keeps a failed user query visible, retries in place and selects by normal ID', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes } = clarityFixture();
  const user = { rid: '9223372036854775806', id: 'alex', name: 'Alex Reviewer', type: 'User' };
  let fail = false, hold = false, release, saved;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] ?? [];
    if (request.operation === 'principals') {
      if (hold) return new Promise(resolve => { release = resolve; });
      if (fail) throw Error('Connection lost');
      return { choices: request.query === 'alex' ? [user] : [], hasMore: false };
    }
    throw Error('Unexpected request: ' + request.operation);
  });
  const workspace = mountWorkspace({ snapshot, api, persist: async read => { saved = read(); }, busy: () => {}, notice: vi.fn() });
  const $ = selector => document.querySelector(selector);
  const click = async selector => { expect($(selector), selector).not.toBeNull(); $(selector).click(); await new Promise(resolve => setTimeout(resolve, 0)); };
  const settle = () => vi.waitFor(() => expect($('#picker-footer')?.textContent).not.toContain('Searching…'));
  await workspace.enter({ kind: 'role', rid: snapshot.model.roles[0].rid });
  const roleRoute = structuredClone(window.history.state);
  await click('[data-command="check"]'); await click('[data-command="test-mode"]'); await settle();
  fail = true;
  const query = $('#picker-query'); query.value = 'alex'; query.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect($('#picker-results [role="alert"]').textContent).toBe('Connection lost');
  expect($('#picker-results').textContent).not.toContain('No matches');
  expect($('#picker-footer').textContent).toContain('Search failed');
  expect($('#picker-results [role="option"]')).toBeNull();
  const calls = api.mock.calls.filter(([request]) => request.operation === 'principals').length;
  await new Promise(resolve => setTimeout(resolve, 260));
  expect(api.mock.calls.filter(([request]) => request.operation === 'principals')).toHaveLength(calls);
  fail = false;
  await click('[data-command="reference-retry"]');
  expect(document.activeElement).toBe(query);
  expect(query.value).toBe('alex');
  await settle();
  expect($('#picker-results').textContent).toContain(user.name);
  expect($('#picker-results [role="alert"]')).toBeNull();
  expect($('#picker-footer [data-command="reference-retry"]')).toBeNull();
  query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect($('#picker')).toBeNull());
  expect($('[data-command="choose-test-user"]').textContent).toContain(user.id);
  await workspace.flush();
  expect(saved.state.tests.$map.some(([, request]) => request.userId === user.id && request.subject === user.rid)).toBe(true);

  // Back/Forward must close the chooser before dropping its owning state.
  hold = true;
  await workspace.enter({ kind: 'policy', rid: snapshot.model.policies[0].rid });
  await click('[data-command="check"]');
  await click($('[data-command="choose-test-user"]') ? '[data-command="choose-test-user"]' : '[data-command="test-mode"]');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const signal = api.mock.calls.filter(([request]) => request.operation === 'principals').at(-1)[1].signal;
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: roleRoute }));
  expect($('#picker')).toBeNull();
  expect(signal.aborted).toBe(true);
  release({ choices: [user], hasMore: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect($('#picker')).toBeNull();
});
