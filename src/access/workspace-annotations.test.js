// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('authors descriptions, preserves existing notes, clears legacy labels, and undoes without data loss', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  const { snapshot } = clarityFixture();
  const annotations = [
    { comment: 'Separate rationale', notes: ['Keep these notes'], annotations: { owner: 'Team' } },
    { _comment: 'Legacy label', comment: 'Keep this separate comment' },
    { description: 'Current label', _comment: 'Older label', title: 'Keep this title' },
    { description: { owner: 'Team' }, _comment: 'Not a fallback for structured descriptions' },
    { _comment: { owner: 'Team' }, comment: 'Structured legacy metadata' },
  ];
  snapshot.model.policies = annotations.map((a, index) => ({ ...snapshot.model.policies[0],
    rid: String(100 + index), id: 'annotation_' + index, content: { Version: '1.0', Statement: [{ ...a,
      Subject: '*', Effect: 'Allow', Action: ['Read'], Resource: { All: [],
        notes: { Condition: { Left: 12 }, Any: [{ Condition: { Left: 'resource.type', Right: 'NotATypeFilter' } }] }
      } }] } }));
  const originals = structuredClone(snapshot.model.policies);
  let saved;
  const workspace = mountWorkspace({ snapshot, api: async () => [], persist: async factory => { saved = factory(); },
    busy: () => {}, notice: () => {} });
  const $ = selector => document.querySelector(selector);
  const click = async selector => {
    await vi.waitFor(() => expect($(selector)).not.toBeNull());
    $(selector).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const stored = index => saved.model.policies[index].content;
  const edit = async () => { await click('[data-command="rule-menu"]'); await click('[data-command="rule-name"]'); };
  const confirm = async text => {
    $('#rule-description').value = text;
    await click('#dialog button[type="submit"]'); await workspace.flush();
  };

  for (const index of [0, 1, 2, 4]) {
    workspace.enter({ kind: 'policy', rid: String(100 + index) });
    await edit();
    const original = originals[index].content;
    const note = original.Statement[0];
    expect($('#rule-description').value).toBe(note.description ?? (typeof note._comment === 'string' ? note._comment : ''));
    await workspace.flush(); expect(stored(index)).toEqual(original); // Opening never migrates metadata.
    await confirm('  Reviewed description\nDetailed rationale  ');
    const expected = { ...original, Statement: [{ ...note, description: 'Reviewed description\nDetailed rationale' }] };
    expect(stored(index)).toEqual(expected);
    expect($('.rule-picker strong').textContent).toBe('Reviewed description');
    if (index === 0) expect(stored(index).Statement[0]).not.toHaveProperty('_comment');
    await click('[data-view="json"]');
    await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull());
    expect(JSON.parse(EditorView.findFromDOM($('.cm-editor')).state.doc.toString())).toEqual(expected);
    const colored = [...document.querySelectorAll('.cm-editor .pbac-comment')].map(el => el.textContent).join('');
    expect(colored).toContain('"description"');
    expect(colored).toContain('Reviewed description');
    await click('[data-view="rules"]');
    await edit(); await confirm('');
    expect($('.rule-picker strong').textContent).toBe('Read'); // Clearing cannot resurrect _comment.
    expect(stored(index).Statement[0]).toEqual({ ...note, description: '' });
    await click('[data-command="undo"]'); await workspace.flush(); expect(stored(index)).toEqual(expected);
    await click('[data-command="undo"]'); await workspace.flush(); expect(stored(index)).toEqual(original);
  }

  workspace.enter({ kind: 'policy', rid: '103' });
  expect($('.rule-picker strong').textContent).toBe('Read');
  await edit();
  expect($('#rule-description')).toBeNull(); // Do not silently replace structured data with text.
  await click('#dialog button[type="submit"]');
  await vi.waitFor(() => expect($('.cm-editor')).not.toBeNull());
  expect(JSON.parse(EditorView.findFromDOM($('.cm-editor')).state.doc.toString())).toEqual(originals[3].content);
  await workspace.flush(); expect(stored(3)).toEqual(originals[3].content);
});
