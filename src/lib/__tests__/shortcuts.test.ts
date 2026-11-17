/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHORTCUTS, WINDOW_SCOPES, shortcutDef, ariaKeyShortcuts, cmKey, formatCombo, isTextEntry, manifestKey, matchKeys,
  matchesCombo, matchesShortcut, parseCombo, setPlatformForTests, sheetGroups, shortcutLabel, shortcutsInScope,
  withShortcut, type Platform, type ShortcutId, type ShortcutScope,
} from '../shortcuts';

const ROOT = join(__dirname, '../../..');
const ids = Object.keys(SHORTCUTS) as ShortcutId[];

function key(init: KeyboardEventInit & { target?: Element }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.target) Object.defineProperty(e, 'target', { value: init.target });
  return e;
}

function on(el: Element, init: KeyboardEventInit): KeyboardEvent {
  if (!el.isConnected) document.body.append(el);
  const e = key(init);
  let seen: KeyboardEvent | null = null;
  el.addEventListener('keydown', ev => { seen = ev as KeyboardEvent; }, { once: true });
  el.dispatchEvent(e);
  return seen ?? e;
}

afterEach(() => {
  setPlatformForTests(null);
  document.body.replaceChildren();
});

describe('platform resolution', () => {
  it('resolves Mod to Ctrl on Windows and Linux and to Cmd on macOS', () => {
    expect(parseCombo('Mod+S', 'other')).toMatchObject({ ctrl: true, meta: false, key: 'S' });
    expect(parseCombo('Mod+S', 'mac')).toMatchObject({ ctrl: false, meta: true, key: 'S' });
    expect(parseCombo('Ctrl+M', 'mac')).toMatchObject({ ctrl: true, meta: false });
    expect(matchesCombo(key({ key: 's', ctrlKey: true }), 'Mod+S', 'other')).toBe(true);
    expect(matchesCombo(key({ key: 's', metaKey: true }), 'Mod+S', 'mac')).toBe(true);
    expect(matchesCombo(key({ key: 's', ctrlKey: true }), 'Mod+S', 'mac')).toBe(false);
  });

  it('saves with Cmd+S in the Extended Code editor on macOS', () => {
    expect(matchesShortcut(key({ key: 's', metaKey: true }), 'editor.save', { platform: 'mac' })).toBe(true);
    expect(cmKey('Mod+S', 'mac')).toBe('Meta-s');
    expect(cmKey('Mod+S', 'other')).toBe('Ctrl-s');
  });

  it('uses the per-platform keys: no Option+Left history and no Cmd+Y redo on macOS', () => {
    expect(matchKeys('object.back', 'mac')).toEqual(['Mod+[']);
    expect(matchKeys('object.back', 'other')).toEqual(['Alt+ArrowLeft', 'Mod+[']);
    expect(matchKeys('blueprint.redo', 'mac')).toEqual(['Mod+Shift+Z']);
  });

  it('matches Alt+letter by physical key, so Option+N works on a Mac', () => {
    expect(matchesShortcut(key({ key: '˜', code: 'KeyN', altKey: true }), 'access.newRole', { platform: 'mac' })).toBe(true);
    expect(matchesShortcut(key({ key: 'n', code: 'KeyN', ctrlKey: true }), 'access.newRole', { platform: 'other' })).toBe(false);
  });

  it('lets Shift through for punctuation keys (? is Shift+/)', () => {
    expect(matchesShortcut(key({ key: '?', shiftKey: true }), 'sheet.open')).toBe(true);
    expect(matchesShortcut(key({ key: 'F1' }), 'sheet.open')).toBe(true);
  });

  it('ignores keys while an IME is composing', () => {
    expect(matchesShortcut(key({ key: 'Enter', ctrlKey: true, isComposing: true }), 'editor.preview', { platform: 'other' })).toBe(false);
  });

  it('formats keys for people and for assistive technology', () => {
    expect(formatCombo('Alt+Shift+F', 'other')).toBe('Alt+Shift+F');
    expect(formatCombo('Mod+Shift+K', 'mac')).toBe('⌘⇧K');
    expect(formatCombo('Alt+ArrowLeft', 'other')).toBe('Alt+←');
    expect(withShortcut('Save', 'editor.save', 'other')).toBe('Save (Ctrl+S)');
    expect(withShortcut('Save', 'editor.save', 'mac')).toBe('Save (⌘S)');
    expect(ariaKeyShortcuts('editor.save', 'mac')).toBe('Meta+S');
    expect(shortcutLabel('browser.search', 'other')).toBe('');
  });
});

describe('registry integrity', () => {
  it('parses every key of every entry', () => {
    for (const id of ids) for (const p of ['mac', 'other'] as Platform[]) for (const k of matchKeys(id, p)) expect(() => parseCombo(k, p), `${id}: ${k}`).not.toThrow();
  });

  it('has no two actions on the same key within one scope, on either platform', () => {
    const scopes = new Set(ids.map(id => SHORTCUTS[id].scope as ShortcutScope));
    for (const p of ['mac', 'other'] as Platform[]) {
      for (const scope of scopes) {
        const seen = new Map<string, ShortcutId>();
        for (const id of shortcutsInScope(scope)) {
          for (const k of matchKeys(id, p)) {
            const c = parseCombo(k, p);
            const norm = `${c.ctrl}${c.meta}${c.alt}${c.shift}${c.key}`;
            expect(seen.get(norm), `${scope} (${p}): ${k} is used by ${seen.get(norm)} and ${id}`).toBeUndefined();
            seen.set(norm, id);
          }
        }
      }
    }
  });

  it('never uses Ctrl+Alt+letter (AltGr on European layouts) or the browser-reserved Ctrl+N / T / W', () => {
    for (const id of ids) for (const p of ['mac', 'other'] as Platform[]) for (const k of matchKeys(id, p)) {
      const c = parseCombo(k, p);
      if (/^[A-Z]$/.test(c.key)) expect(c.ctrl && c.alt, `${id}: ${k}`).toBe(false);
      if (c.ctrl && !c.alt && !c.shift && ['N', 'T', 'W'].includes(c.key)) throw new Error(`${id} uses browser-reserved ${k}`);
    }
  });

  it('keeps the editor wraps off the keys the global commands take', () => {
    const globals = shortcutsInScope('browser').flatMap(id => matchKeys(id, 'other'));
    for (const id of ['editor.wrapIf', 'editor.wrapEach'] as const) for (const k of matchKeys(id, 'other')) expect(globals).not.toContain(k);
    expect(matchKeys('editor.wrapIf', 'other')).not.toContain('Ctrl+Shift+X');
    expect(matchKeys('editor.wrapEach', 'other')).not.toContain('Ctrl+Shift+E');
  });

  it('lists every window scope in the cheat sheet, plus the browser commands', () => {
    for (const win of Object.keys(WINDOW_SCOPES) as Array<keyof typeof WINDOW_SCOPES>) {
      const groups = sheetGroups(win, { platform: 'other' });
      expect(groups.at(-1)?.title).toBe('Browser commands');
      expect(groups.length).toBeGreaterThan(1);
    }
  });
});

describe('manifest commands', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as { commands: Record<string, { suggested_key?: { default?: string; mac?: string }; description: string }> };

  it('match the registry, with at most four suggested keys', () => {
    const browser = shortcutsInScope('browser');
    expect(Object.keys(manifest.commands).sort()).toEqual(browser.map(id => shortcutDef(id).command).sort());
    for (const id of browser) {
      const cmd = manifest.commands[shortcutDef(id).command!];
      expect(cmd.suggested_key?.default, id).toBe(manifestKey(id, 'other'));
      expect(cmd.suggested_key?.mac, id).toBe(manifestKey(id, 'mac'));
    }
    expect(Object.values(manifest.commands).filter(c => c.suggested_key).length).toBeLessThanOrEqual(4);
    expect(manifest.commands['open-search'].suggested_key).toBeUndefined();
  });

  // The browsers' published shortcut lists (Chrome Help "Chrome keyboard
  // shortcuts", Microsoft Support "Keyboard shortcuts in Microsoft Edge"),
  // the combinations with Shift plus Ctrl / Alt / Cmd and a letter.
  // Ctrl+Shift+H is not here: Chrome lists it only as the last step of
  // "F6 twice, then Shift+Ctrl+H" (select several tabs while the tab strip
  // has keyboard focus), Edge does not list it, so it is free as a command.
  const RESERVED: Record<'other' | 'mac', string[]> = {
    other: [
      'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Shift+B', 'Ctrl+Shift+O', 'Ctrl+Shift+G', 'Ctrl+Shift+J',
      'Ctrl+Shift+M', 'Ctrl+Shift+R', 'Ctrl+Shift+D', 'Ctrl+Shift+I', 'Ctrl+Shift+K', 'Ctrl+Shift+L', 'Ctrl+Shift+P', 'Ctrl+Shift+U',
      'Ctrl+Shift+V', 'Alt+Shift+T', 'Alt+Shift+I', 'Alt+Shift+A', 'Alt+Shift+N', 'Alt+Shift+B',
    ],
    mac: [
      'Command+Shift+N', 'Command+Shift+T', 'Command+Shift+W', 'Command+Shift+B', 'Command+Shift+J', 'Command+Shift+G', 'Command+Shift+M',
      'Command+Shift+I', 'Command+Shift+R', 'Command+Shift+D', 'Command+Shift+H', 'Command+Shift+C', 'Command+Shift+E', 'Command+Shift+U', 'Command+Shift+V',
    ],
  };

  it('gives the Blueprint toggle a default that neither Chrome nor Edge reserves', () => {
    const cmd = manifest.commands['toggle-blueprint'].suggested_key!;
    expect(cmd.default).toBe('Ctrl+Shift+H');
    expect(cmd.mac).toBe('Command+Shift+K');
    expect(RESERVED.other).not.toContain(cmd.default);
    expect(RESERVED.mac).not.toContain(cmd.mac);
  });

  it('gives the in-window Access and editor keys no browser-reserved combination', () => {
    for (const id of ['access.newRole', 'access.newPolicy', 'editor.wrapIf', 'editor.wrapEach'] as const) {
      for (const k of matchKeys(id, 'other')) expect(RESERVED.other, `${id}: ${k}`).not.toContain(k);
    }
  });
});

describe('text-field guard', () => {
  it('knows what text entry is', () => {
    const text = document.createElement('input');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const area = document.createElement('textarea');
    const editable = document.createElement('div'); editable.setAttribute('contenteditable', 'true');
    const off = document.createElement('div'); off.setAttribute('contenteditable', 'false');
    const cm = document.createElement('div'); cm.className = 'cm-editor';
    const line = document.createElement('span'); cm.append(line);
    const button = document.createElement('button');
    document.body.append(text, box, area, editable, off, cm, button);
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(editable)).toBe(true);
    expect(isTextEntry(off)).toBe(false);
    expect(isTextEntry(line)).toBe(true);
    expect(isTextEntry(button)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it('keeps history keys out of text fields and code editors', () => {
    setPlatformForTests('other');
    const input = document.createElement('input');
    const cm = document.createElement('div'); cm.className = 'cm-editor';
    const content = document.createElement('div'); cm.append(content);
    const button = document.createElement('button');
    document.body.append(input, cm, button);
    expect(matchesShortcut(on(input, { key: 'ArrowLeft', altKey: true }), 'object.back')).toBe(false);
    expect(matchesShortcut(on(content, { key: '[', ctrlKey: true }), 'object.back')).toBe(false);
    expect(matchesShortcut(on(button, { key: 'ArrowLeft', altKey: true }), 'object.back')).toBe(true);
    expect(matchesShortcut(on(button, { key: '[', ctrlKey: true }), 'object.back')).toBe(true);
  });

  it('never fires a printable key in a field, even for an action allowed there', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    document.body.append(input, button);
    expect(matchesShortcut(on(input, { key: '/' }), 'access.find')).toBe(false);
    expect(matchesShortcut(on(input, { key: 'k', ctrlKey: true }), 'access.find', { platform: 'other' })).toBe(true);
    expect(matchesShortcut(on(button, { key: '/' }), 'access.find')).toBe(true);
    expect(matchesShortcut(on(input, { key: '?', shiftKey: true }), 'sheet.open')).toBe(false);
    expect(matchesShortcut(on(input, { key: 'F1' }), 'sheet.open')).toBe(true);
  });
});

// Handlers converted to the registry must not compare key literals
// themselves (standard widget keys such as arrows inside a list are allowed).
describe('converted handlers read their keys from the registry', () => {
  const CONVERTED = [
    'src/editor/editor.ts', 'src/studio/studio.ts', 'src/studio/studio-help.ts', 'src/editor-core/overlay.ts',
    'src/objectview/window/main.ts', 'src/objectview/window/code-edit.ts', 'src/editor-core/code-ref-links.ts',
    'src/diff/diff.ts', 'src/content-blueprint/actions.ts', 'src/content-frame-overlay.ts',
    'src/sidepanel/sidepanel.ts',
  ];
  const PARTLY = ['src/sidepanel/tabs/connect-tab.ts', 'src/codesearch/codesearch.ts', 'src/content-tooltip.ts', 'src/content-overlays.ts', 'src/sidepanel/tabs/browse-tab.ts', 'src/access/workspace.js', 'src/editor-core/code-links.ts', 'src/objectview/window/view.ts'];
  // App-level keys: function keys, letters and punctuation compared to e.key,
  // modifier tests next to a key test, and CodeMirror key strings.
  const APP_KEY = [
    /\.key\s*[!=]==?\s*['"](F\d+|[A-Za-z0-9/?[\]])['"]/,
    /\.key\.toLowerCase\(\)\s*===?\s*['"]/,
    /(ctrlKey|metaKey|altKey)[^;\n]*\.key\s*[!=]==?/,
    /\.key\s*[!=]==?[^;\n]*(ctrlKey|metaKey|altKey)/,
    /\{\s*key:\s*['"](Mod|Ctrl|Alt|Shift|Meta|Cmd|F\d)/,
  ];

  it.each(CONVERTED)('%s has no literal app keys', file => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const hits = text.split(/\r?\n/).map((l, i) => [l, i + 1] as const).filter(([l]) => APP_KEY.some(r => r.test(l)) || /\.key\s*[!=]==?\s*['"]Escape['"]/.test(l));
    expect(hits.map(([l, n]) => `${file}:${n}: ${l.trim()}`)).toEqual([]);
  });

  it.each(PARTLY)('%s has no literal app keys (widget arrows and Escape allowed)', file => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const allowed = /e\.key\.length === 1 && (e\.key !== ' ' && )?!e\.ctrlKey && !e\.metaKey && !e\.altKey|e\.key === 'ContextMenu' \|\| e\.shiftKey && e\.key === 'F10'|\(e\.key === 'Home' \|\| e\.key === 'End'\) && e\.target\.id === 'picker-query'|altKey && e\.key === 'ArrowDown'|\(e\.ctrlKey \|\| e\.metaKey\) && e\.key === 'Enter'/;
    const hits = text.split(/\r?\n/).map((l, i) => [l, i + 1] as const).filter(([l]) => APP_KEY.some(r => r.test(l)) && !allowed.test(l));
    expect(hits.map(([l, n]) => `${file}:${n}: ${l.trim()}`)).toEqual([]);
  });
});
