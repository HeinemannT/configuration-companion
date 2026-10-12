// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';

it('uses the shared preference on restore and history navigation without hiding unfinished JSON', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.setItem('companion.access.editor', 'json');
  // BMP ignores annotation values, including structured metadata. Rules must
  // not crash by assuming every _comment is a string.
  const content = { Version: '1.0', Statement: [{ _comment: { owner: 'Team' }, description: 'Keep this metadata', Subject: '*', Action: ['Read'], Effect: 'Allow', Resource: { All: [] } }] };
  const policies = ['1', '2', '3'].map(rid => ({ rid, id: 'policy_' + rid, name: 'Policy ' + rid, parent: '', enabled: true, content }));
  policies[1] = { ...policies[1], content: {}, invalidContent: '{' };
  const model = { roles: [], policies, scope: [], folders: [], globals: [] };
  const snapshot = { environment: 'preference-test', name: 'Test', loadedAt: '', roots: { roles: '10', policies: '11' }, model, users: [], groups: [], classes: {} };
  const saved = { version: 1, snapshot, model, baseline: model, state: { kind: 'policy', rid: '1', empty: false, view: 'rules', raw: { $map: [['3', '{ unfinished']] } } };
  const workspace = mountWorkspace({ snapshot, saved, api: async () => [], persist: async () => {}, busy: () => {}, notice: vi.fn() });
  const mode = () => document.querySelector('[data-view][aria-pressed=true]')?.dataset.view;
  expect(mode()).toBe('json'); // An older workspace cannot override the newer global preference.
  document.querySelector('[data-view=rules]').click();
  expect(mode()).toBe('rules');
  expect(document.querySelector('.rule-picker strong').textContent).toBe('Keep this metadata');
  expect(localStorage.getItem('companion.access.editor')).toBe('rules');
  const firstRoute = structuredClone(window.history.state);

  workspace.enter({ kind: 'policy', rid: '2' });
  expect(mode()).toBe('json'); // A broken policy needs the text editor, without changing the preference.
  expect(localStorage.getItem('companion.access.editor')).toBe('rules');
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: firstRoute }));
  expect(mode()).toBe('rules');

  workspace.enter({ kind: 'policy', rid: '3' });
  expect(mode()).toBe('json');
  await vi.waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('unfinished'));
  expect(localStorage.getItem('companion.access.editor')).toBe('rules');
  workspace.enter({ kind: 'policy', rid: '1' });
  expect(mode()).toBe('rules');
  document.querySelector('[data-view=json]').click();
  expect(localStorage.getItem('companion.access.editor')).toBe('json');
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: firstRoute }));
  expect(mode()).toBe('json');
});
