// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('edits the clicked definition, adds nested delegations, and removes branches with undo', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  const { snapshot, classes } = clarityFixture();
  let saved;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] ?? [];
    throw Error('Unexpected operation: ' + request.operation);
  });
  const workspace = mountWorkspace({ snapshot, api, persist: async factory => { saved = factory(); }, busy: () => {}, notice: vi.fn() });
  const $ = selector => document.querySelector(selector);
  const assignment = snapshot.model.scope[0].rid, delegation = snapshot.model.scope[1].rid;
  const row = rid => $(`#tree [data-scope-node="${rid}"]`);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const click = async selector => {
    await vi.waitFor(() => expect($(selector), selector).not.toBeNull());
    $(selector).click(); await tick();
  };
  const menu = (rid, options = {}) => {
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 200, ...options });
    row(rid).dispatchEvent(event);
    return event;
  };
  const chooseDescendants = async () => {
    await vi.waitFor(() => expect($('#picker-results')).not.toBeNull());
    [...document.querySelectorAll('#picker-results button')].find(b => b.querySelector('strong')?.textContent === 'Descendant objects').click();
    await tick(); await workspace.flush();
  };

  workspace.enter({ kind: 'role', rid: snapshot.model.roles[0].rid });
  await vi.waitFor(() => expect(row(delegation)).not.toBeNull());
  // Opening a context menu must not select another record or hijack Shift+right-click.
  expect(menu(assignment, { shiftKey: true }).defaultPrevented).toBe(false);
  expect($('#menu').hidden).toBe(true);
  expect(menu(assignment).defaultPrevented).toBe(true);
  expect($('#menu').textContent).toContain('Edit assignment');
  expect($('#menu').textContent).toContain('Add delegation underneath');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect($('#menu').hidden).toBe(true);
  expect(document.activeElement).toBe(row(assignment));

  workspace.enter({ kind: 'policy', rid: snapshot.model.policies[0].rid });
  menu(assignment);
  await click('#menu [data-command="context-add-delegation"]');
  await chooseDescendants();
  const added = saved.model.scope.find(s => !snapshot.model.scope.some(original => original.rid === s.rid));
  expect(added).toMatchObject({ parent: assignment, kind: 'HierarchicalDownwardsRoleDelegationRule' });
  expect(row(added.rid).getAttribute('aria-selected')).toBe('true');
  expect($('#editor .definition-focus').dataset.scopeEditor).toBe(added.rid);
  expect($('#editor .record-name').value).toBe('Risk review');

  // Keyboard context menus have the same actions and preserve the exact parent.
  row(delegation).focus();
  row(delegation).dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  expect($('#menu').textContent).toContain('Edit delegation');
  await click('#menu [data-command="context-add-delegation"]');
  await chooseDescendants();
  const nested = saved.model.scope.find(s => s.parent === delegation);
  expect(nested.kind).toBe('HierarchicalDownwardsRoleDelegationRule');

  menu(delegation);
  await click('#menu [data-command="delete-scope"]');
  expect($('#dialog').open).toBe(true);
  expect($('#dialog').textContent).toContain('1 child rule');
  await click('#dialog button[type="submit"]');
  await workspace.flush();
  expect(saved.model.scope.some(s => s.rid === delegation || s.rid === nested.rid)).toBe(false);
  expect(saved.model.scope.some(s => s.rid === assignment || s.rid === added.rid)).toBe(true);
  await click('[data-command="undo"]'); await workspace.flush();
  expect(saved.model.scope.find(s => s.rid === nested.rid).parent).toBe(delegation);

  menu(added.rid);
  await click('#menu [data-command="delete-scope"]'); await workspace.flush();
  expect(saved.model.scope.some(s => s.rid === added.rid)).toBe(false);
  expect(document.activeElement).toBe(row(assignment));
  await click('[data-command="undo"]'); await workspace.flush();
  expect(saved.model.scope.some(s => s.rid === added.rid)).toBe(true);
  expect(api.mock.calls.every(([request]) => request.operation === 'schema')).toBe(true);
});
