// @vitest-environment happy-dom
// The redesigned Access workspace: statement rows, conditions, context panel,
// review, role page, blocked Rules and the saved-policies test banner.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

function setup(adjust = () => {}) {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  adjust(fixture);
  let saved;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return fixture.classes[request.type] || [];
    if (request.operation === 'trace') return { element: 'TraceRequest', result: false, timedOut: false, details: {}, children: [] };
    if (request.operation === 'search') return [fixture.object];
    return [];
  });
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice: vi.fn(), busy: () => {}, persist: async read => { saved = read(); } });
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { await vi.waitFor(() => expect($(selector), selector).not.toBeNull()); $(selector).click(); await tick(); };
  const key = async (el, init) => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); await tick(); };
  return { ...fixture, api, workspace, $, $$, tick, click, key, stored: () => saved.model };
}

it('runs tests against saved policies, says so while the draft differs, and answers Not granted', async () => {
  const { snapshot, object, $, tick, click } = setup();
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  await click('[data-action="Update"]');
  await click('[data-command="check"]');
  expect($('#policy-tab-test').getAttribute('aria-selected')).toBe('true');
  expect($('.workarea').classList.contains('test-full')).toBe(true);
  expect($('.test-banner').textContent).toContain('Tests run against the saved policies on Interaction QA. 1 unsaved change is not included.');
  await click('[data-command="choose-object"]');
  const query = $('#picker-query'); query.value = 'risk'; query.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect($('#picker-results button')).not.toBeNull());
  [...document.querySelectorAll('#picker-results button')].find(b => b.querySelector('strong')?.textContent === object.name).click();
  await tick();
  await click('[data-command="prepare-check"]');
  await vi.waitFor(() => expect($('.result-line.answer strong')?.textContent).toBe('Not granted'));
  expect($('.answer-note').textContent).toContain('Access is grant-only: without a grant there is no access.');
  expect($('.answer-note').textContent).not.toContain('Deny');
});
