// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';

it('starts without an arbitrary record, opens exact targets, and carries object context without editing', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const role = { rid: '9000000000000000001', id: 'reader', name: 'Reader', parent: '' };
  const rule = { Subject: ['role:reader'], Action: ['Read'], Effect: 'Allow', Resource: { All: [] } };
  const model = { roles: [role], policies: [{ rid: '9000000000000000002', id: 'read', name: 'Read policy', parent: '', enabled: true, content: { Statement: [rule, rule] } }], scope: [], folders: [], globals: [] };
  const snapshot = { environment: 'entry-test', name: 'Test', loadedAt: '', roots: { roles: '1', policies: '2' }, model, users: [], groups: [], classes: {} };
  const api = vi.fn(async () => []);
  let saved;
  const view = mountWorkspace({ snapshot, api, persist: async data => { saved = data(); }, busy: () => {}, notice: vi.fn() });
  view.focusArrival();
  expect(document.activeElement.id).toBe('search');
  expect(document.querySelectorAll('#tabs [role=tab]')).toHaveLength(0);
  expect(document.querySelector('.record-name')).toBeNull();
  expect(api).not.toHaveBeenCalled();

  view.enter({ kind: 'role', rid: role.rid });
  const input = document.querySelector('.record-name');
  input.value = 'Local edit'; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const search = document.querySelector('#search'); search.value = 'unrelated'; search.dispatchEvent(new Event('input', { bubbles: true }));
  view.enter({ kind: 'policy', rid: model.policies[0].rid, statement: 1 });
  expect(document.querySelector('.rule-index').textContent).toBe('2/2');
  expect(search.value).toBe('');
  const policyRoute = structuredClone(window.history.state);

  const object = { rid: '9000000000000000003', id: 'object', name: 'Selected object', type: 'Organisation' };
  view.enter({ kind: 'test', object });
  expect(document.querySelector('#dock').hidden).toBe(false);
  expect(document.querySelector('.workarea').classList.contains('object-testing')).toBe(true);
  expect(document.querySelector('[data-command=choose-object]').textContent).toContain('Selected object');
  expect(document.activeElement.dataset.command).toBe('choose-test-user');
  expect(document.querySelector('[data-command=prepare-check]').disabled).toBe(true);
  expect(window.history.state.route.surface).toBe('test');
  const testRoute = structuredClone(window.history.state);
  // Browser history only changes the view; it does not roll back the edit.
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: policyRoute }));
  expect(document.querySelector('.rule-index').textContent).toBe('2/2');
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: testRoute }));
  expect(document.querySelector('[data-command=choose-object]').textContent).toContain('Selected object');
  document.querySelector('[data-command=close-test]').click();
  await vi.waitFor(() => expect(document.querySelector('.workarea').classList.contains('object-testing')).toBe(false));
  view.enter({ kind: 'role', rid: role.rid });
  expect(document.querySelector('.record-name').value).toBe('Local edit');
  await view.flush();
  expect(saved.model.roles[0].name).toBe('Local edit');
  expect(api.mock.calls.some(([request]) => request.operation === 'apply' || request.operation === 'trace')).toBe(false);
});
