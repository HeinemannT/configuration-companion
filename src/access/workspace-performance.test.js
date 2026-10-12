// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('retains tree nodes on navigation, invalidates on edits, and preserves draft/history revisions', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes } = clarityFixture();
  snapshot.model.roles.push({ rid: '9000000000000000010', id: 'child', name: 'Child', parent: snapshot.model.roles[0].rid });
  let saved;
  const workspace = mountWorkspace({ snapshot, api: async request => classes[request.type] || [],
    persist: async read => { saved = read(); }, busy: () => {}, notice: vi.fn() });
  const $ = selector => document.querySelector(selector);
  const root = '#tree [data-open="9000000000000000001"]', policy = '#tree [data-open="9000000000000000004"]';
  const click = async selector => { $(selector).click(); await new Promise(resolve => setTimeout(resolve, 0)); };
  await click(policy); await vi.waitFor(() => expect($('.list-value-preview')?.textContent).toContain('scope_regional'));
  await click(root); await workspace.flush();
  const rootNode = $(root), initialRevision = saved.revision;
  await click(policy); expect($(root)).toBe(rootNode); expect(saved.revision).toBe(initialRevision);
  await click(root); expect($(root)).toBe(rootNode);
  expect([...document.querySelectorAll('#tree [role="tree"]')].every(tree => tree.querySelectorAll('.tree-row[tabindex="0"]').length === 1)).toBe(true);
  const name = $('[data-record="name"]'); name.value = 'Edited role'; name.dispatchEvent(new Event('input', { bubbles: true }));
  await workspace.flush(); expect(saved.model.roles[0].name).toBe('Edited role'); expect(saved.revision).toBeGreaterThan(initialRevision);
  const editedRevision = saved.revision;
  await click(policy); expect($(root)).not.toBe(rootNode); expect($(root).textContent).toContain('Edited role');
  expect($(root).querySelector('.changed')).not.toBeNull(); expect(saved.revision).toBe(editedRevision);
  await click('[data-command="undo"]'); await workspace.flush(); expect(saved.model.roles[0].name).toBe('Risk review');
  expect($(root).querySelector('.changed')).toBeNull(); expect(saved.revision).toBeGreaterThan(editedRevision);
  await click('[data-command="redo"]'); await workspace.flush(); expect(saved.model.roles[0].name).toBe('Edited role');
  await click('[data-command="undo"]'); await click(root);
  // Expansion must rebuild even without a model revision and retain keyboard focus.
  const beforeCollapse = $(root); beforeCollapse.focus();
  beforeCollapse.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  expect($(root)).not.toBe(beforeCollapse); expect($(root).getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe($(root));
  $(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect($('#tree [data-open="9000000000000000010"]')).not.toBeNull();
  await click('[data-scope-node="9000000000000000003"]');
  expect($('#tree [data-scope-node="9000000000000000003"]').getAttribute('aria-selected')).toBe('true');
  expect($(root).classList.contains('context-owner')).toBe(true);
  await click(policy); expect($(root).classList.contains('context-owner')).toBe(false);
  expect($('#tree [data-scope-node="9000000000000000003"]').getAttribute('aria-selected')).toBe('false');
});
