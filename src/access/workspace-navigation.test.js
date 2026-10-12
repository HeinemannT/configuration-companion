// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';

it('keeps definition routes, search context, and keyboard focus connected', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const model = {
    roles: [
      { rid: '9000000000000000001', id: 'everyone', name: 'Everyone', parent: '' },
      { rid: '9000000000000000002', id: 'reviewer', name: 'Reviewer', parent: '9000000000000000001' },
    ],
    scope: [
      { rid: 'a', id: 'owners', name: 'Owners', parent: '9000000000000000002', kind: 'RoleAssignment', source: 'CeRiskAssessment', field: 'owner' },
      { rid: 'd', id: 'related', name: 'Related controls', parent: 'a', kind: 'InwardsReferenceRoleDelegationRule', source: '', field: 'CeControlMeasure.relatedRisk' },
      { rid: 'h', id: 'descendants', name: 'Descendants', parent: 'd', kind: 'HierarchicalDownwardsRoleDelegationRule', source: '', field: '' },
    ],
    globals: [{ rid: 'g', id: 'member', name: 'Member', parent: '9000000000000000002', mode: 'User', subjectId: 'test_person' }],
    policies: [], folders: [],
  };
  const snapshot = { environment: 'navigation-test', name: 'Test', loadedAt: new Date().toISOString(),
    roots: { roles: 'roles', policies: 'policies' }, model, classes: {}, users: [], groups: [] };
  let resolveTrace;
  const object = { rid: '8000000000000000001', id: 'test_object', name: 'Test object', type: 'CeRiskAssessment' };
  const api = async request => {
    if (request.operation === 'search') return [object];
    if (request.operation === 'trace') return new Promise(resolve => { resolveTrace = resolve; });
    return [];
  };
  mountWorkspace({ snapshot, api, persist: async () => {}, busy: () => {}, notice: () => {} });
  document.querySelector('#tree [data-open="9000000000000000001"]').click();
  const query = document.querySelector('#search');
  const key = (element, value) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const firstIndex = window.history.state.index;
  query.value = 'relatedRisk';
  query.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.querySelector('#tree .tree-result-context').textContent).toBe('Everyone');
  expect(document.querySelector('#tree .search-path')).toBeNull();
  expect(document.querySelector('#tree [data-scope-node="a"]')).not.toBeNull();
  expect(document.querySelector('#tree [data-scope-node="d"]').dataset.searchMatch).toBe('true');
  expect(document.querySelector('#tree [data-scope-node="g"]')).toBeNull();
  query.focus(); key(query, 'Enter');
  await vi.waitFor(() => expect(window.history.state.route.scopeSelection).toBe('d'));
  expect(window.history.state.index).toBe(firstIndex + 1);
  const delegationRoute = structuredClone(window.history.state);
  expect(document.activeElement.closest('[data-scope-editor]').dataset.scopeEditor).toBe('d');
  expect(document.querySelector('#tree .context-owner').dataset.open).toBe('9000000000000000002');

  const name = document.querySelector('.record-name');
  name.focus(); key(name, 'Escape');
  expect(document.activeElement).toBe(name);
  expect(document.querySelector('.record-name')).toBe(name);
  name.value = 'Review owner'; name.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#editor').dispatchEvent(new Event('scroll'));
  expect(window.history.state.index).toBe(delegationRoute.index);
  document.querySelector('#tree [data-scope-node="a"]').click();
  await vi.waitFor(() => expect(window.history.state.route.scopeSelection).toBe('a'));
  const assignmentRoute = structuredClone(window.history.state);
  expect(assignmentRoute.index).toBe(delegationRoute.index + 1);
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: delegationRoute }));
  expect(document.querySelector('#tree [aria-selected="true"]').dataset.scopeNode).toBe('d');
  expect(document.querySelector('.definition-focus').dataset.scopeEditor).toBe('d');
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: assignmentRoute }));
  expect(document.querySelector('#tree [aria-selected="true"]').dataset.scopeNode).toBe('a');

  let owner = document.querySelector('#tree [data-open="9000000000000000002"]');
  owner.focus(); key(owner, 'ArrowLeft');
  owner = document.querySelector('#tree [data-open="9000000000000000002"]');
  expect(owner.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(owner);
  key(owner, 'ArrowRight');
  expect(document.activeElement.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('#tree [data-tree-kind="role"] .tree-row[tabindex="0"]')).toHaveLength(1);
  key(document.activeElement, ' ');
  expect(document.body.classList.contains('tree-dragging')).toBe(true);
  key(document.activeElement, 'Escape');
  expect(document.body.classList.contains('tree-dragging')).toBe(false);

  const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
  expect(tabs.filter(tab => tab.tabIndex === 0)).toHaveLength(1);
  expect(tabs.find(tab => tab.getAttribute('aria-selected') === 'true').getAttribute('aria-controls')).toBe('editor');
  tabs[0].focus(); key(tabs[0], 'ArrowRight');
  expect(document.activeElement).toBe(tabs[1]);
  expect(document.querySelectorAll('#tabs [tabindex="0"]')).toHaveLength(1);

  document.querySelector('.test-trigger').click();
  await vi.waitFor(() => expect(document.querySelector('#dock').hidden).toBe(false));
  document.querySelector('[data-command="close-test"]').click();
  await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('.test-trigger')));
  expect(document.querySelector('#dock').hidden).toBe(true);
  query.value = 'reviewer'; query.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.querySelector('#tree [data-scope-node="a"] small').textContent).toBe('CeRiskAssessment');
  expect(document.querySelector('#tree [data-scope-node="h"] small')).toBeNull();

  const id = document.querySelector('#business-id');
  id.focus(); id.value = 'pending_id'; id.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.querySelector('#pending-review').textContent).toContain('Review pending edits');
  key(id, 'Escape');
  expect(id.value).toBe('reviewer');
  expect(document.activeElement).toBe(id);

  document.querySelector('.test-trigger').click();
  document.querySelector('[data-command="choose-object"]').click();
  await vi.waitFor(() => expect(document.querySelector('#picker-query')).not.toBeNull());
  const objectQuery = document.querySelector('#picker-query');
  objectQuery.value = 'test_object'; objectQuery.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[data-command="picker-select"]')).not.toBeNull());
  document.querySelector('[data-command="picker-select"]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-command="prepare-check"]').disabled).toBe(false));
  document.querySelector('[data-command="prepare-check"]').click();
  await vi.waitFor(() => expect(resolveTrace).toBeTypeOf('function'));
  document.querySelector('[data-command="history"]').click();
  await vi.waitFor(() => expect(document.querySelector('#dock').hidden).toBe(true));
  resolveTrace({ element: 'TraceRequest', result: true, details: {}, children: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#dock').hidden).toBe(true);
});
