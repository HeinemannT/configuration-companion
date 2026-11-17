// @vitest-environment happy-dom
/**
 * The most important keys of each window, after the keyboard scheme: one
 * registry (lib/shortcuts.ts), app keys ahead of CodeMirror's defaults,
 * Escape one layer at a time, and no key taken from a text field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { baseKeymapBindings } from '../editor-core/cm-scaffold';
import { cmBindings, matchesShortcut, setPlatformForTests, sheetGroups, shortcutLabel, whichShortcut } from '../lib/shortcuts';
import { ContentState } from '../content-state';
import { setInputModality, showTooltipForElement, wireObjectPopover } from '../content-tooltip';
import { createCodeEditor } from '../objectview/window/code-edit';

vi.mock('../lib/messaging', () => ({ sendRequest: vi.fn(), sendFireForget: vi.fn() }));

const ROOT = join(__dirname, '../..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => setPlatformForTests('other'));
afterEach(() => {
  setPlatformForTests(null);
  document.body.replaceChildren();
});

describe('Extended Code editor and studio', () => {
  function view(run: () => boolean): EditorView {
    const parent = document.createElement('div');
    document.body.append(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: 'a := 1',
        extensions: [Prec.high(keymap.of(cmBindings([{ id: 'editor.preview', run }]))), keymap.of([...baseKeymapBindings])],
      }),
    });
  }

  it('runs Preview on Ctrl+Enter ahead of CodeMirror (no blank line is inserted)', () => {
    const run = vi.fn(() => true);
    const v = view(run);
    press(v.contentDOM, { key: 'Enter', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe('a := 1');
    v.destroy();
  });

  it('keeps F5 as a second Preview key, and both windows put their keys ahead of the defaults', () => {
    expect(cmBindings([{ id: 'editor.preview', run: () => true }]).map(b => b.key)).toEqual(['Ctrl-Enter', 'F5']);
    for (const file of ['src/editor/editor.ts', 'src/studio/studio.ts']) {
      const text = src(file);
      expect(text, file).toContain('Prec.high(keymap.of(cmBindings([');
      expect(text.indexOf('Prec.high(keymap.of(cmBindings(['), file).toBeLessThan(text.indexOf('...baseKeymapBindings'));
    }
  });

  it('binds the wraps to Alt+Shift+C / Alt+Shift+E, Save to Cmd+S on a Mac', () => {
    expect(cmBindings([{ id: 'editor.wrapIf', run: () => true }, { id: 'editor.wrapEach', run: () => true }]).map(b => b.key)).toEqual(['Alt-Shift-c', 'Alt-Shift-e']);
    setPlatformForTests('mac');
    expect(cmBindings([{ id: 'editor.save', run: () => true }, { id: 'studio.preview', run: () => true }]).map(b => b.key)).toEqual(['Meta-s', 'Meta-Enter']);
  });
});

describe('object window', () => {
  it('finishes an in-place code edit on Ctrl+Enter and cancels it on Escape', () => {
    const onDone = vi.fn(), onCancel = vi.fn(), onChange = vi.fn();
    const ed = createCodeEditor({ label: 'expression', code: 'x := 1', plain: true, onDone, onCancel, onChange } as Parameters<typeof createCodeEditor>[0]);
    document.body.append(ed.el);
    const content = ed.el.querySelector('.cm-content')!;
    press(content, { key: 'Enter', ctrlKey: true });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(ed.getDoc()).toBe('x := 1');
    press(content, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    ed.destroy();
  });

  it('keeps Back / Forward out of text fields and editors; Ctrl+S saves', () => {
    const input = document.createElement('input');
    const tree = document.createElement('div'); tree.tabIndex = 0;
    document.body.append(input, tree);
    const ids = ['object.back', 'object.forward', 'object.save'] as const;
    const seen: Array<string | null> = [];
    for (const [t, init] of [[input, { key: 'ArrowLeft', altKey: true }], [tree, { key: 'ArrowLeft', altKey: true }], [tree, { key: ']', ctrlKey: true }], [input, { key: 's', ctrlKey: true }]] as const) {
      t.addEventListener('keydown', e => seen.push(whichShortcut(e as KeyboardEvent, ids)), { once: true });
      press(t, init);
    }
    expect(seen).toEqual([null, 'object.back', 'object.forward', 'object.save']);
  });

  it('never lets Escape close the window while a card or a peek is open (layer order)', () => {
    const text = src('src/objectview/window/view.ts');
    expect(text).toContain("kind: 'peek', name: 'card-and-peeks', phase: 'capture'");
    expect(src('src/objectview/window/main.ts')).toContain("kind: 'window', name: 'object-window'");
  });
});

describe('code search and Compare', () => {
  it('code search: / focuses the field outside it, F8 / Shift+F8 step, Alt+Enter opens the editor', () => {
    const btn = document.createElement('button');
    const input = document.createElement('input');
    document.body.append(btn, input);
    const ids = ['codesearch.search', 'codesearch.next', 'codesearch.prev', 'codesearch.openEditor'] as const;
    const got: Array<string | null> = [];
    for (const [t, init] of [[btn, { key: '/' }], [input, { key: '/' }], [input, { key: 'F8' }], [input, { key: 'F8', shiftKey: true }], [input, { key: 'Enter', altKey: true }]] as const) {
      t.addEventListener('keydown', e => got.push(whichShortcut(e as KeyboardEvent, ids)), { once: true });
      press(t, init);
    }
    expect(got).toEqual(['codesearch.search', null, 'codesearch.next', 'codesearch.prev', 'codesearch.openEditor']);
  });

  it('Compare: F8 and Alt+Down step, Back never fires in the picker field, Escape is wired to the window', () => {
    const input = document.createElement('input');
    document.body.append(input);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'F8' }), 'compare.next')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }), 'compare.prev')).toBe(true);
    let back: boolean | null = null;
    input.addEventListener('keydown', e => { back = matchesShortcut(e, 'compare.back'); }, { once: true });
    press(input, { key: 'ArrowLeft', altKey: true });
    expect(back).toBe(false);
    const diff = src('src/diff/diff.ts');
    expect(diff).toContain("kind: 'window', name: 'compare'");
    expect(diff).toContain('escLayers.listen(document)');
  });
});

describe('Inspect mode on the page', () => {
  let state: ContentState;
  let tooltip: HTMLElement;
  beforeEach(() => {
    state = new ContentState();
    tooltip = document.createElement('div');
    tooltip.id = 'crev-tooltip';
    document.documentElement.append(tooltip);
    wireObjectPopover(state, tooltip);
  });
  afterEach(() => { state.resetAll(); tooltip.remove(); });

  function badge(rid: string): HTMLElement {
    const label = document.createElement('span');
    label.className = 'crev-label';
    label.dataset.crevLabel = rid;
    const stub = document.createElement('span');
    stub.className = 'crev-stub';
    stub.tabIndex = 0;
    label.append(stub);
    document.body.append(label);
    return stub;
  }

  it('F8 / Shift+F8 move between badges while Inspect is on, and leave the page key alone otherwise', () => {
    const a = badge('1'), b = badge('2');
    const field = document.createElement('input');
    document.body.append(field);
    state.inspectActive = true;
    a.focus();
    expect(press(a, { key: 'F8' }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
    press(b, { key: 'F8', shiftKey: true });
    expect(document.activeElement).toBe(a);
    // In a page field the key belongs to the page.
    field.focus();
    expect(press(field, { key: 'F8' }).defaultPrevented).toBe(false);
    state.inspectActive = false;
    a.focus();
    expect(press(a, { key: 'F8' }).defaultPrevented).toBe(false);
  });

  it('F8 closes the card of the previous badge (a hover card no longer covers the next badge)', () => {
    const a = badge('1'), b = badge('2');
    state.inspectActive = true;
    setInputModality(false);
    showTooltipForElement(state, a.closest<HTMLElement>('.crev-label')!, '1'); // opened by hovering
    expect(tooltip.classList.contains('crev-visible')).toBe(true);
    a.focus();
    press(a, { key: 'F8' });
    expect(document.activeElement).toBe(b);
    // The previous card is gone; a card shown now belongs to the focused badge.
    expect(state.tooltipLabelEl).not.toBe(a.closest('.crev-label'));
    if (tooltip.classList.contains('crev-visible')) expect(state.tooltipLabelEl).toBe(b.closest('.crev-label'));
  });

  it('documents the badge keys in the side panel cheat sheet, not on the badge card', () => {
    expect(shortcutLabel('inspect.open')).toBe('Alt+Enter');
    const rows = sheetGroups('sidepanel', { platform: 'other' }).flatMap(g => g.rows.map(r => r.keys.join(' or ')));
    expect(rows).toEqual(expect.arrayContaining(['Space', 'Alt+Enter', 'F8', 'Shift+F8']));
    expect(src('src/lib/object-card.ts')).not.toContain("'inspect.next'");
  });
});

describe('Blueprint and the Access workspace', () => {
  it('Blueprint: undo / redo / delete only outside text fields, Cmd+Y is not redo on a Mac', () => {
    const field = document.createElement('input');
    document.body.append(field);
    let hit: string | null = 'unset';
    field.addEventListener('keydown', e => { hit = whichShortcut(e, ['blueprint.undo', 'blueprint.delete']); }, { once: true });
    press(field, { key: 'Backspace' });
    expect(hit).toBeNull();
    setPlatformForTests('mac');
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'y', metaKey: true }), 'blueprint.redo')).toBe(false);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }), 'blueprint.redo')).toBe(true);
  });

  it('Access: New role / policy on Alt+N / Alt+P (Ctrl+N stays the browser’s), / finds a record, the help lists no dead keys', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', altKey: true }), 'access.newRole')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true }), 'access.newPolicy')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }), 'access.newRole')).toBe(false);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: '/' }), 'access.find')).toBe(true);
    const ws = src('src/access/workspace.js');
    expect(ws).not.toContain('<kbd>Ctrl+N</kbd>');
    expect(ws).not.toMatch(/<kbd>Ctrl\+Shift\+N<\/kbd>|createRecord\(e\.shiftKey/);
    expect(ws).toContain("window: 'access'");
  });
});
