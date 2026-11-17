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

it('makes the All/Any heading the control and keeps what Rules cannot show as untouched JSON', async () => {
  const odd = { Condition: { Left: 'resource.status', Comparison: '=', Right: { nested: [1, 2] } }, comment: 'kept' };
  const { snapshot, $, $$, click, stored } = setup(({ snapshot }) => {
    snapshot.model.policies[0].content.Statement[0].Resource.All.push(structuredClone(odd));
  });
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  const heading = $('.gk[data-path="[]"]');
  expect(heading.textContent).toContain('All of');
  expect(heading.getAttribute('aria-label')).toContain('Every item below must match');
  expect($$('.raw-block')).toHaveLength(1);
  expect($('.raw-block').textContent).toContain('Shown as JSON');
  await click('.gk[data-path="[]"]');
  expect(stored().policies[0].content.Statement[0].Resource.Any).toHaveLength(3);
  expect(JSON.stringify(stored().policies[0].content.Statement[0].Resource.Any[2])).toBe(JSON.stringify(odd));
  await click('[data-command="remove-condition"][data-path=\'["Any",0]\']');
  expect(JSON.stringify(stored().policies[0].content.Statement[0].Resource.Any[1])).toBe(JSON.stringify(odd));
});
