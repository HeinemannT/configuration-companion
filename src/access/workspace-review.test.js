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

it('reviews changes as sentences, steps through them and reverts one, then saves through Apply', async () => {
  const { snapshot, api, $, $$, click, stored } = setup();
  api.mockImplementation(async request => request.operation === 'apply' ? { snapshot: { ...snapshot, model: structuredClone(request.draft) }, mapping: {} } : []);
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  await click('[data-action="Update"]');
  await click('[data-command="add-statement"]');
  await click('[data-command="policy-changes"]');
  expect($('.policy-changes').textContent).toContain('Update added for Risk review.');
  // Only the differing value is shown, on the After side; the Before side has nothing and is left out.
  const first = $('.policy-changes .rv-delta');
  expect([first.querySelector('.rv-field').textContent, [...first.querySelectorAll('.bf > span:first-child')].map(s => s.textContent), first.querySelector('.rv-vals').textContent]).toEqual(['Can', ['After'], '+added: Update']);
  expect($('.policy-changes .rv-target').textContent).toBe('Saves to Interaction QA · policy Risk review access risk_review_policy, statement 1');
  await click('[data-command="review"]');
  expect($('.review-title').textContent).toContain('Review 2 unsaved changes');
  expect($$('.rv')).toHaveLength(2);
  expect($('.rv.sel').textContent).toContain('statement 1');
  await click('[data-command="review-step"][data-step="1"]');
  expect($('.rv.sel').textContent).toContain('new statement 3');
  expect($('.rv.sel .rv-diffs').textContent).toBe('Added statement 3. It applies to every user.');
  await click('.rv.sel [data-command="revert-statement-change"]');
  expect(stored().policies[0].content.Statement).toHaveLength(2);
  expect($('.review-title').textContent).toContain('Review 1 unsaved change');
  expect($('.review-page').textContent).toContain('Statements have no IDs.');
  await click('[data-command="apply-workspace"]');
  const apply = api.mock.calls.map(([r]) => r).find(r => r.operation === 'apply');
  expect(apply.draft.policies[0].content.Statement[0].Action).toEqual(['Read', 'Update']);
});
