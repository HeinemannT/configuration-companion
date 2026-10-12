// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('round-trips native enum casing through JSON, Rules, action edits and undo without data loss', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  const { snapshot, classes } = clarityFixture();
  const content = { Version: '1.0', Statement: [{ Subject: '*', Effect: 'deny', Action: ['read', 'UPDATE'], Resource: {
    HasAccessTo: { Reference: 'resource.parent', Action: 'READ', Grouping: 'any' }, All: null, Any: null
  } }] };
  snapshot.model.policies[0].content = structuredClone(content);
  let saved;
  const workspace = mountWorkspace({ snapshot, api: async request => classes[request.type] || [],
    persist: async factory => { saved = factory(); }, busy: () => {}, notice: () => {} });
  const $ = selector => document.querySelector(selector);
  const click = async selector => {
    await vi.waitFor(() => expect($(selector)).not.toBeNull()); $(selector).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const stored = () => saved.model.policies[0].content;
  await click('[data-open="9000000000000000004"]');
  await click('[data-view="json"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull());
  // Simulate an actual JSON draft, then take the production JSON -> Rules path.
  const view = EditorView.findFromDOM($('.cm-editor'));
  view.dispatch({ changes: { from: 1, insert: '\n ' } });
  await click('[data-view="rules"]');
  expect($('[data-effect="Deny"]').getAttribute('aria-pressed')).toBe('true');
  expect($('[data-action="Read"]').checked).toBe(true);
  expect($('[data-action="Update"]').checked).toBe(true);
  // happy-dom 20 mis-selects options after an empty first option; verify the
  // emitted selection here and the actual control in native Chrome QA.
  expect($('select[aria-label="Nested action"] option[selected]').value).toBe('Read');
  expect($('[aria-label="Related-object grouping"]').value).toBe('Any');
  await workspace.flush(); expect(stored()).toEqual(content);
  await click('[data-action="Delete"]');
  await workspace.flush(); expect(stored().Statement[0].Action).toEqual(['read', 'UPDATE', 'Delete']);
  await click('[data-view="json"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull());
  expect(JSON.parse(EditorView.findFromDOM($('.cm-editor')).state.doc.toString())).toEqual({ ...content,
    Statement: [{ ...content.Statement[0], Action: ['read', 'UPDATE', 'Delete'] }] });
  await click('[data-view="rules"]');
  await click('[data-command="undo"]'); await workspace.flush(); expect(stored()).toEqual(content);
  await click('[data-action="Read"]'); await workspace.flush(); expect(stored().Statement[0].Action).toEqual(['UPDATE']);
  await click('[data-command="undo"]'); await workspace.flush(); expect(stored()).toEqual(content);
  // Choosing the inherited action removes the optional field, rather than
  // emitting an empty string (which native PBAC rejects).
  const nested = $('[aria-label="Nested action"]'); nested.value = '';
  nested.dispatchEvent(new Event('change', { bubbles: true })); await workspace.flush();
  expect(stored().Statement[0].Resource.HasAccessTo).not.toHaveProperty('Action');
  await click('[data-command="undo"]'); await workspace.flush(); expect(stored()).toEqual(content);
  await click('[data-command="check"]');
  expect($('[data-action-value="Read"]').getAttribute('aria-pressed')).toBe('true');
});
