// @vitest-environment happy-dom
// The redesigned Access workspace: statement rows, conditions, context panel,
// review, role page, blocked Rules and the saved-policies test banner.
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
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

it('blocks Rules for JSON that does not parse, names the line, and keeps the text', async () => {
  const { snapshot, $, click } = setup();
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="json"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull(), { timeout: 10_000 });
  const view = EditorView.findFromDOM($('.cm-editor'));
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{\n  "Version": "1.0",\n  "Statement": [\n    { "Effect": "Allow" "Subject": "*" }\n  ]\n}' } });
  await click('[data-view="rules"]');
  expect($('.error-state').textContent).toContain('The Statements view cannot be shown: the JSON does not parse.');
  expect($('.error-state').textContent).toContain('Line 4');
  expect($('.st-list')).toBeNull();
  await click('[data-command="json-goto-line"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull(), { timeout: 10_000 });
  expect(EditorView.findFromDOM($('.cm-editor')).state.doc.toString()).toContain('"Effect": "Allow" "Subject"');
});
