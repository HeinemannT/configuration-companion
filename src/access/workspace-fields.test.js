// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it.each(['scalar', 'array'])('offers native fields without waiting for schema and preserves %s values through source edits and Undo', async shape => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot } = clarityFixture(), policy = snapshot.model.policies[0];
  const original = { Left: 'resource.parent', Comparison: shape === 'array' ? 'ContainsAny' : '=', Right: shape === 'array' ? ['Organisation:headquarters'] : 'Organisation:headquarters' };
  policy.content.Statement[0].Resource.All[1] = { Condition: original };
  let saved, resolveSchema;
  const api = vi.fn(() => new Promise(resolve => { resolveSchema = resolve; }));
  const workspace = mountWorkspace({ snapshot, api, persist: async factory => { saved = factory(); }, busy: () => {}, notice: vi.fn() });
  workspace.enter({ kind: 'policy', rid: policy.rid });
  const $ = selector => document.querySelector(selector);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { expect($(selector), selector).not.toBeNull(); $(selector).click(); await tick(); };
  const field = '[data-command="schema-property"][data-path=\'["All",1]\']';
  await click(field);
  expect($('#picker-types .schema-scope').textContent).toBe('resourcenew');
  expect($('#picker-results').textContent).toContain('resource.linkedTo');
  expect($('#picker-results').textContent).toContain('resource.createdBy');
  expect(api).toHaveBeenCalledTimes(1);
  expect($('#editor').textContent).not.toContain('not in the loaded');
  await click('[data-command="schema-scope"][data-scope="new"]');
  expect($('#picker-results').textContent).toContain('new.parent');
  expect([...document.querySelectorAll('#picker-results small')].map(e => e.textContent)).not.toContain('new');
  // Resolve the abandoned resource class while browsing new: its rows must not leak.
  resolveSchema([{ accessor: 'oldContextField', label: 'Wrong context' }]); await tick();
  expect($('#picker-results').textContent).not.toContain('Wrong context');
  const row = [...document.querySelectorAll('#picker-results button')].find(button => button.querySelector('small')?.textContent === 'new.parent');
  row.click(); await tick();
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition).toEqual({ ...original, Left: 'new.parent', Right: shape === 'array' ? [] : '' });
  expect(document.activeElement?.getAttribute('aria-label')).toBe(shape === 'array' ? 'Edit condition value as JSON' : 'Condition value');
  await click('[data-command="undo"]');
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition).toEqual(original);
  // Changing only source retains the value; property changes clear it deliberately.
  await click('[data-command="schema-source"][data-path=\'["All",1]\']');
  const source = [...document.querySelectorAll('#picker-results button')].find(button => button.querySelector('strong')?.textContent === 'new');
  source.click(); await tick();
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition).toEqual({ ...original, Left: 'new.parent' });
  await click('[data-command="undo"]');
  await click(field);
  const bare = [...document.querySelectorAll('#picker-results button')].find(button => button.querySelector('small')?.textContent === 'resource');
  bare.click(); await tick();
  expect(saved.model.policies[0].content.Statement[0].Resource.All[1].Condition.Left).toBe('resource');
  expect($(field).textContent).toContain('resource');
  expect($('#editor').textContent).not.toContain('not in the loaded');
});
