// @vitest-environment happy-dom
// The badge and the review count the same things: with a JSON edit open, the
// review lists that edit, so nothing is counted that the review does not show.
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('counts an open JSON edit the same in the badge and the review, and lists it there', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes } = clarityFixture();
  const api = vi.fn(async request => request.operation === 'schema' ? classes[request.type] || [] : []);
  const workspace = mountWorkspace({ snapshot, api, notice: vi.fn(), busy: () => {}, persist: async () => {} });
  const $ = selector => document.querySelector(selector), all = selector => [...document.querySelectorAll(selector)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { await vi.waitFor(() => expect($(selector), selector).not.toBeNull()); $(selector).click(); await tick(); };

  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  await click('[data-action="Update"]');
  await click('[data-view="json"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull(), { timeout: 10_000 });
  const view = EditorView.findFromDOM($('.cm-editor'));
  view.dispatch({ changes: { from: 0, insert: '{"broken": ' } });
  await tick();
  expect($('#pending-review b').textContent).toBe('2 unsaved changes');
  await click('#pending-review [data-command="review"]');
  expect($('.review-title b').textContent).toBe('Review 2 unsaved changes');
  // One statement card and one JSON edit, which is listed for what it is.
  expect(all('.rv')).toHaveLength(1);
  const json = all('.draft-recovery .raw-draft-row');
  expect(json).toHaveLength(1);
  expect(json[0].querySelector('small').textContent).toBe('JSON edit in progress, not yet a change · ' + policy.id);
  expect($('.draft-recovery h2').textContent).toBe('Unsaved JSON changes');
  expect(json[0].querySelector('button').textContent).toBe('Open unsaved change');
});
