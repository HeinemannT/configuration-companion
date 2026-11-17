/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { closeCheatSheet, installCheatSheetKey, isCheatSheetOpen, openCheatSheet } from '../cheat-sheet';
import { escapeLayers } from '../escape-layers';
import { setPlatformForTests } from '../shortcuts';

const press = (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

afterEach(() => {
  closeCheatSheet();
  setPlatformForTests(null);
  document.body.replaceChildren();
});

describe('cheat sheet', () => {
  it('is a modal dialog with a title, lists the window keys from the registry, and the browser commands', () => {
    setPlatformForTests('other');
    openCheatSheet({ window: 'object' });
    const dialog = document.querySelector('.ui-keys')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('Keyboard shortcuts');
    const rows = [...dialog.querySelectorAll('dt')].map(dt => `${dt.textContent} = ${dt.nextElementSibling?.textContent}`);
    expect(rows).toContain('Alt+← or Ctrl+[ = Back');
    expect(rows).toContain('Ctrl+S = Review and save the unsaved changes');
    expect(rows).toContain('Alt+Enter or F12 = Open the focused reference in this window');
    expect(rows).toContain('Not set = Search the configuration');
    expect(rows).toContain('Ctrl+Shift+H = Turn Blueprint on or off');
  });

  it('shows the Mac keys on a Mac', () => {
    setPlatformForTests('mac');
    openCheatSheet({ window: 'object' });
    const rows = [...document.querySelectorAll('.ui-keys dt')].map(dt => dt.textContent);
    expect(rows).toContain('⌘[');
    expect(rows).not.toContain('⌥←');
  });

  it('takes the focus, keeps Tab inside, and gives the focus back on Escape', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    openCheatSheet({ window: 'codesearch' });
    const close = document.querySelector<HTMLButtonElement>('.ui-keys-close')!;
    expect(document.activeElement).toBe(close);
    press(close, { key: 'Tab' });
    expect(document.activeElement).toBe(document.querySelector('.ui-keys-body'));
    press(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    press(close, { key: 'Escape' });
    expect(isCheatSheetOpen()).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it('is the innermost Escape layer of its window', () => {
    let windowClosed = false;
    const off = escapeLayers().register({ kind: 'window', isOpen: () => true, close: () => { windowClosed = true; } });
    openCheatSheet({ window: 'compare' });
    expect(escapeLayers().escape()).toBe(true);
    expect(isCheatSheetOpen()).toBe(false);
    expect(windowClosed).toBe(false);
    off();
  });

  it('opens on ? outside text fields, not while typing', () => {
    const remove = installCheatSheetKey(() => ({ window: 'access' }));
    const field = document.createElement('input');
    const button = document.createElement('button');
    document.body.append(field, button);
    press(field, { key: '?', shiftKey: true });
    expect(isCheatSheetOpen()).toBe(false);
    press(button, { key: '?', shiftKey: true });
    expect(isCheatSheetOpen()).toBe(true);
    expect(document.querySelector('.ui-keys')?.textContent).toContain('New role');
    remove();
  });

  it('appends the notes and footer the window passes', () => {
    openCheatSheet({ window: 'editor', notes: [{ title: 'Output', rows: [{ keys: ['Table view'], label: 'Render | -separated output' }] }], footer: ['More help elsewhere.'] });
    const text = document.querySelector('.ui-keys')?.textContent ?? '';
    expect(text).toContain('Render | -separated output');
    expect(text).toContain('More help elsewhere.');
  });
});
