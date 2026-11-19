/**
 * The one keyboard registry. Every key the extension handles or documents is
 * an entry here: its id, its keys per platform, the scope it works in, the
 * action label, and whether it may fire while the focus is in a text field.
 * Handlers match with `matchesShortcut`, CodeMirror keymaps come from
 * `cmBindings`, tooltips from `withShortcut`, and the `?` cheat sheet lists
 * the entries of the current window. Pure module: no chrome.* and no DOM
 * outside the functions that receive an event.
 *
 * Key syntax: modifiers joined by `+`, the key last. `Mod` is Ctrl on
 * Windows / Linux and Cmd on macOS; `Ctrl` is the Control key on every
 * platform; `Alt` is Option on macOS. Keys are KeyboardEvent.key names
 * (`Enter`, `Escape`, `ArrowLeft`, `F8`), `Space`, an upper-case letter, a
 * digit, or a single punctuation character (`/`, `?`, `[`).
 */

import type { EditorView } from '@codemirror/view';

// ── platform: the one place that decides ────────────────────────────

export type Platform = 'mac' | 'other';

let platformOverride: Platform | null = null;

/** The platform the keys resolve for. */
export function currentPlatform(): Platform {
  if (platformOverride) return platformOverride;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac/i.test(name) ? 'mac' : 'other';
}

export function isMac(): boolean {
  return currentPlatform() === 'mac';
}

/** Tests only: resolve keys for a fixed platform (null restores detection). */
export function setPlatformForTests(p: Platform | null): void {
  platformOverride = p;
}

// ── registry ────────────────────────────────────────────────────────

export type ShortcutScope =
  | 'browser' | 'sheet' | 'inspect' | 'inspect-card' | 'frame'
  | 'sidepanel' | 'browse'
  | 'object' | 'code-link' | 'object-code'
  | 'code' | 'code-ref' | 'editor' | 'studio'
  | 'codesearch' | 'compare' | 'blueprint'
  | 'access' | 'access-statement' | 'access-json';

export interface ShortcutDef {
  /** Keys on Windows and Linux (and macOS unless `mac` is set). First is the one shown first. */
  readonly keys: readonly string[];
  /** Keys on macOS, when they differ. */
  readonly mac?: readonly string[];
  /** Keys that also work but are not documented (kept for existing users). */
  readonly alias?: readonly string[];
  readonly macAlias?: readonly string[];
  readonly scope: ShortcutScope;
  readonly label: string;
  /** Short word for hint bars ("open", "move"). */
  readonly hint?: string;
  /** May fire while the focus is in a text field or code editor. A printable
   *  key without Ctrl/Cmd/Alt never fires there, whatever this says. */
  readonly inText: boolean;
  /** Who handles the key: the extension (default), CodeMirror's own keymap,
   *  or a standard widget (menu, tree, list). Only listed, never matched. */
  readonly by?: 'codemirror' | 'widget' | 'browser';
  /** The chrome.commands name, for browser commands. */
  readonly command?: string;
}

const d = <T extends Record<string, ShortcutDef>>(t: T) => t;

export const SHORTCUTS = d({
  // Browser commands (manifest `commands`; the user can rebind them).
  'browser.sidePanel': { keys: ['Ctrl+Shift+Y'], mac: ['Mod+Shift+Y'], scope: 'browser', label: 'Open the side panel', inText: true, by: 'browser', command: 'open-side-panel' },
  'browser.inspect': { keys: ['Ctrl+Shift+X'], mac: ['Mod+Shift+X'], scope: 'browser', label: 'Turn Inspect on or off', inText: true, by: 'browser', command: 'toggle-inspect' },
  'browser.blueprint': { keys: ['Ctrl+Shift+H'], mac: ['Mod+Shift+K'], scope: 'browser', label: 'Turn Blueprint on or off', inText: true, by: 'browser', command: 'toggle-blueprint' },
  'browser.extended': { keys: ['Ctrl+Shift+E'], mac: ['Mod+Shift+E'], scope: 'browser', label: 'Open Extended Code', inText: true, by: 'browser', command: 'open-extended' },
  'browser.pointTell': { keys: [], scope: 'browser', label: 'Turn Point and tell on or off', inText: true, by: 'browser', command: 'toggle-point-tell' },
  'browser.search': { keys: [], scope: 'browser', label: 'Search the configuration', inText: true, by: 'browser', command: 'open-search' },

  // Every extension window.
  'sheet.open': { keys: ['?'], alias: ['F1'], scope: 'sheet', label: 'Show keyboard shortcuts', inText: true },

  // Inspect mode, on the BMP page: only on the extension's own badges and card.
  'inspect.copy': { keys: ['Space'], scope: 'inspect', label: 'Copy the ID of the focused badge (Shift: RID, Alt: Instance ID, Ctrl or Cmd: Reference)', inText: false },
  'inspect.card': { keys: ['Enter'], alias: ['ArrowDown'], scope: 'inspect', label: 'Open the badge details and move into them', inText: false },
  'inspect.open': { keys: ['Alt+Enter'], scope: 'inspect', label: 'Open the object window for the focused badge', inText: false },
  'inspect.next': { keys: ['F8'], scope: 'inspect', label: 'Next badge on the page', inText: false },
  'inspect.prev': { keys: ['Shift+F8'], scope: 'inspect', label: 'Previous badge on the page', inText: false },
  'inspectCard.move': { keys: ['ArrowDown', 'ArrowUp'], scope: 'inspect-card', label: 'Move between the card controls', inText: false },
  'inspectCard.close': { keys: ['Escape'], scope: 'inspect-card', label: 'Close the card, focus back on the badge', inText: true },
  'inspectCard.leave': { keys: ['Tab', 'Shift+Tab'], scope: 'inspect-card', label: 'Leave the card for the next or previous page control', inText: false },
  'frame.close': { keys: ['Escape'], scope: 'frame', label: 'Close the focused window (asks first when edits are unsaved)', inText: true },

  // Side panel.
  'sidepanel.back': { keys: ['Escape'], scope: 'sidepanel', label: 'Cancel the page picker (the panel stays open)', inText: true },
  'sidepanel.tabs': { keys: ['ArrowLeft', 'ArrowRight'], scope: 'sidepanel', label: 'Move between tabs (tab bar)', inText: false, by: 'widget' },
  'browse.search': { keys: ['/'], scope: 'browse', label: 'Search objects', inText: false },
  'browse.move': { keys: ['ArrowDown', 'ArrowUp'], scope: 'browse', label: 'Move the selection', hint: 'move', inText: true },
  'browse.open': { keys: ['Enter'], scope: 'browse', label: 'Open the selected object', hint: 'open', inText: true },
  'browse.reveal': { keys: ['ArrowRight'], scope: 'browse', label: 'Reveal in the tree, or expand', hint: 'reveal in tree', inText: true },
  'browse.collapse': { keys: ['ArrowLeft'], scope: 'browse', label: 'Collapse, or go to the parent', inText: true },
  'browse.back': { keys: ['Escape'], scope: 'browse', label: 'Step back: cancel the pick, clear the search, drop the selection', inText: true },
  'browse.copyId': { keys: ['C'], scope: 'browse', label: 'Copy the ID of the selected object', hint: 'copy ID', inText: false },
  'browse.copyRid': { keys: ['Shift+C'], scope: 'browse', label: 'Copy the RID of the selected object', inText: false },
  'browse.locate': { keys: ['L'], scope: 'browse', label: 'Locate the selected object on the page', hint: 'locate', inText: false },

  // Object window.
  'object.back': { keys: ['Alt+ArrowLeft', 'Mod+['], mac: ['Mod+['], scope: 'object', label: 'Back', inText: false },
  'object.forward': { keys: ['Alt+ArrowRight', 'Mod+]'], mac: ['Mod+]'], scope: 'object', label: 'Forward', inText: false },
  'object.save': { keys: ['Mod+S'], scope: 'object', label: 'Review and save the unsaved changes', inText: true },
  'object.close': { keys: ['Escape'], scope: 'object', label: 'Close a menu, then a card, then the code shown below a line, then the window', inText: false },
  'object.tree': { keys: ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'], scope: 'object', label: 'Move, expand and collapse in the structure tree', inText: false, by: 'widget' },
  'codeLink.show': { keys: ['Enter', 'Space', 'Alt+F12'], scope: 'code-link', label: 'Show the code of the focused reference below its line', inText: false },
  'codeLink.open': { keys: ['Alt+Enter', 'F12'], alias: ['Mod+Enter'], scope: 'code-link', label: 'Open the focused reference in this window', inText: false },
  'objectCode.done': { keys: ['Mod+Enter'], scope: 'object-code', label: 'Finish the code edit', inText: true },
  'objectText.apply': { keys: ['Mod+Enter'], scope: 'object', label: 'Apply a multi-line text edit', inText: true },
  'objectCode.cancel': { keys: ['Escape'], scope: 'object-code', label: 'Cancel the code edit', inText: true },

  // Every code editor (CodeMirror's own keys, listed so they can be found).
  'code.find': { keys: ['Mod+F'], scope: 'code', label: 'Find and replace', inText: true },
  'code.nextMatch': { keys: ['Mod+D'], scope: 'code', label: 'Select the next occurrence', inText: true, by: 'codemirror' },
  'code.comment': { keys: ['Mod+/'], scope: 'code', label: 'Toggle a line comment', inText: true, by: 'codemirror' },
  'code.indent': { keys: ['Tab', 'Shift+Tab'], scope: 'code', label: 'Indent or outdent the selection', inText: true, by: 'codemirror' },
  'code.tabFocus': { keys: ['Ctrl+M'], mac: ['Alt+Shift+M'], scope: 'code', label: 'Switch Tab between indenting and moving the focus out of the editor', inText: true, by: 'codemirror' },
  'code.moveLine': { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], scope: 'code', label: 'Move the line up or down', inText: true, by: 'codemirror' },
  'code.complete': { keys: ['Ctrl+Space'], scope: 'code', label: 'Show completions', inText: true, by: 'codemirror' },
  'code.undo': { keys: ['Mod+Z'], scope: 'code', label: 'Undo', inText: true, by: 'codemirror' },
  'code.redo': { keys: ['Mod+Y'], mac: ['Mod+Shift+Z'], scope: 'code', label: 'Redo', inText: true, by: 'codemirror' },
  'codeRef.open': { keys: ['F12'], scope: 'code-ref', label: 'Open the reference at the caret in the object window', inText: true },
  'codeRef.peek': { keys: ['Alt+F12', 'Mod+Click'], scope: 'code-ref', label: 'Show the code of the reference below its line', inText: true },

  // Extended Code editor.
  'editor.preview': { keys: ['Mod+Enter', 'F5'], scope: 'editor', label: 'Preview (dry run, nothing is saved)', inText: true },
  'editor.save': { keys: ['Mod+S'], scope: 'editor', label: 'Save the current property', inText: true },
  'editor.ai': { keys: ['Mod+K'], scope: 'editor', label: 'Ask or edit with AI', inText: true },
  'editor.format': { keys: ['Alt+Shift+F'], scope: 'editor', label: 'Format the Extended Code', inText: true },
  'editor.wrapIf': { keys: ['Alt+Shift+C'], scope: 'editor', label: 'Wrap the selection in IF … ENDIF', inText: true },
  'editor.wrapEach': { keys: ['Alt+Shift+E'], scope: 'editor', label: 'Wrap the selection in forEach', inText: true },
  'editor.close': { keys: ['Escape'], scope: 'editor', label: 'Close a card, then the code shown below a line, then the window', inText: true },

  // Studio (Custom Visualization and text elements).
  'studio.preview': { keys: ['Mod+Enter'], scope: 'studio', label: 'Re-render the preview', inText: true },
  'studio.save': { keys: ['Mod+S'], scope: 'studio', label: 'Save every changed field', inText: true },
  'studio.ai': { keys: ['Mod+K'], scope: 'studio', label: 'Ask or edit with AI', inText: true },
  'studio.format': { keys: ['Alt+Shift+F'], scope: 'studio', label: 'Format the active file', inText: true },
  'studio.close': { keys: ['Escape'], scope: 'studio', label: 'Close the studio', inText: true },

  // Code search.
  'codesearch.search': { keys: ['/'], scope: 'codesearch', label: 'Focus the search field', inText: false },
  'codesearch.move': { keys: ['ArrowDown', 'ArrowUp'], scope: 'codesearch', label: 'Move through the hits', hint: 'move', inText: true },
  'codesearch.next': { keys: ['F8'], scope: 'codesearch', label: 'Next hit', inText: true },
  'codesearch.prev': { keys: ['Shift+F8'], scope: 'codesearch', label: 'Previous hit', inText: true },
  'codesearch.context': { keys: ['ArrowRight'], scope: 'codesearch', label: 'Show the lines around the hit', hint: 'context', inText: true },
  'codesearch.uncontext': { keys: ['ArrowLeft'], scope: 'codesearch', label: 'Hide the lines around the hit', inText: true },
  'codesearch.open': { keys: ['Enter'], scope: 'codesearch', label: 'Open the hit in the object window (or run the search)', hint: 'open', inText: true },
  'codesearch.again': { keys: ['Mod+Enter'], scope: 'codesearch', label: 'Search again with the same query (Enter opens the selected hit)', hint: 'search again', inText: true },
  'codesearch.openEditor': { keys: ['Alt+Enter'], scope: 'codesearch', label: 'Open the hit in the Extended Code editor', hint: 'editor', inText: true },
  'codesearch.back': { keys: ['Escape'], scope: 'codesearch', label: 'Close a menu, stop the search, clear the query, then close the window', hint: 'stop or clear', inText: true },

  // Compare.
  'compare.next': { keys: ['F8', 'Alt+ArrowDown'], scope: 'compare', label: 'Next difference', inText: false },
  'compare.prev': { keys: ['Shift+F8', 'Alt+ArrowUp'], scope: 'compare', label: 'Previous difference', inText: false },
  'compare.back': { keys: ['Alt+ArrowLeft', 'Mod+['], mac: ['Mod+['], scope: 'compare', label: 'Back to the previous pair', hint: 'back', inText: false },
  'compare.search': { keys: ['/'], scope: 'compare', label: 'Focus the object search while choosing a side', inText: false },
  'compare.close': { keys: ['Escape'], scope: 'compare', label: 'Cancel choosing an object, then close the window', hint: 'cancel', inText: true },

  // Blueprint (page-level keys while Blueprint is on; never while typing).
  'blueprint.back': { keys: ['Escape'], scope: 'blueprint', label: 'Back out one step: a drag (cancelled, nothing moves), review, panels, pickers, menus, the toolbar (focus returns to the box), brush, then the selection (Blueprint stays on)', inText: false },
  'blueprint.delete': { keys: ['Delete', 'Backspace'], scope: 'blueprint', label: 'Delete the selected widget', inText: false },
  'blueprint.undo': { keys: ['Mod+Z'], scope: 'blueprint', label: 'Undo', inText: false },
  'blueprint.redo': { keys: ['Mod+Shift+Z', 'Mod+Y'], mac: ['Mod+Shift+Z'], scope: 'blueprint', label: 'Redo', inText: false },
  'blueprint.nextBox': { keys: ['ArrowDown', 'ArrowRight'], scope: 'blueprint', label: 'Next box on the canvas, in reading order (into and out of containers)', inText: false },
  'blueprint.prevBox': { keys: ['ArrowUp', 'ArrowLeft'], scope: 'blueprint', label: 'Previous box on the canvas', inText: false },
  'blueprint.selectBox': { keys: ['Enter', 'Space'], scope: 'blueprint', label: 'Select the focused box and move to its toolbar', inText: false },

  // Access workspace.
  'access.newRole': { keys: ['Alt+N'], scope: 'access', label: 'New role', inText: false },
  'access.newPolicy': { keys: ['Alt+P'], scope: 'access', label: 'New policy', inText: false },
  'access.find': { keys: ['/'], alias: ['Mod+K'], scope: 'access', label: 'Find a record', inText: true },
  'access.explorer': { keys: ['Mod+B'], scope: 'access', label: 'Show or hide the explorer', inText: true },
  'access.test': { keys: ['Mod+Enter'], scope: 'access', label: 'Test the current record', inText: true },
  'access.review': { keys: ['Mod+S'], scope: 'access', label: 'Review and save the unsaved changes', inText: true },
  'access.undo': { keys: ['Mod+Z'], scope: 'access', label: 'Undo (outside text fields)', inText: false },
  'access.redo': { keys: ['Mod+Shift+Z'], scope: 'access', label: 'Redo (outside text fields)', inText: false },
  'access.back': { keys: ['Escape'], scope: 'access', label: 'Close a menu, then the history view, then the access test (the tab stays open)', inText: true },
  'access.roleMove': { keys: ['Space'], scope: 'access', label: 'Pick up a focused role; arrows move it, Enter drops it', inText: false, by: 'widget' },
  'accessStatement.move': { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], scope: 'access-statement', label: 'Move the focused statement up or down', inText: false },
  'accessStatement.duplicate': { keys: ['Mod+D'], scope: 'access-statement', label: 'Duplicate the focused statement', inText: false },
  'accessStatement.delete': { keys: ['Delete'], scope: 'access-statement', label: 'Remove the focused statement', inText: false },
  'accessGrant.open': { keys: ['O'], scope: 'access-statement', label: 'On a role page row: open its policy (the parent role on an inherited group)', inText: false },
  'accessJson.apply': { keys: ['Mod+S'], scope: 'access-json', label: 'Keep the JSON as an unsaved change', inText: true },
} as const);

export type ShortcutId = keyof typeof SHORTCUTS;

export const SCOPE_TITLES: Record<ShortcutScope, string> = {
  browser: 'Browser commands',
  sheet: 'Help',
  inspect: 'Badges on the page',
  'inspect-card': 'Badge details card',
  frame: 'Floating windows',
  sidepanel: 'Side panel',
  browse: 'Browse',
  object: 'Object window',
  'code-link': 'References in code',
  'object-code': 'Editing code in place',
  code: 'Code editor',
  'code-ref': 'References in the code editor',
  editor: 'Extended Code',
  studio: 'Studio',
  codesearch: 'Code search',
  compare: 'Compare',
  blueprint: 'Blueprint',
  access: 'Access workspace',
  'access-statement': 'Statements',
  'access-json': 'JSON editor',
};

/** The windows that have a cheat sheet, and the scopes each one lists. */
export const WINDOW_SCOPES = {
  // The page has no `?` of its own: the badge keys (not shown on the badge
  // card) are listed in the side panel's sheet, where Inspect is turned on.
  sidepanel: ['sidepanel', 'browse', 'inspect', 'sheet'],
  object: ['object', 'code-link', 'object-code', 'code', 'sheet'],
  editor: ['editor', 'code', 'code-ref', 'sheet'],
  studio: ['studio', 'code', 'sheet'],
  codesearch: ['codesearch', 'sheet'],
  compare: ['compare', 'sheet'],
  blueprint: ['blueprint', 'sheet'],
  access: ['access', 'access-statement', 'access-json', 'sheet'],
  inspect: ['inspect', 'inspect-card', 'frame'],
} as const satisfies Record<string, readonly ShortcutScope[]>;

export type ShortcutWindow = keyof typeof WINDOW_SCOPES;

// ── resolution ──────────────────────────────────────────────────────

function def(id: ShortcutId): ShortcutDef {
  return SHORTCUTS[id];
}

/** The registry entry of an action. */
export const shortcutDef = def;

/** The documented keys of an action on this platform. */
export function shortcutKeys(id: ShortcutId, platform: Platform = currentPlatform()): readonly string[] {
  const e = def(id);
  return platform === 'mac' && e.mac ? e.mac : e.keys;
}

/** Documented keys plus undocumented aliases. */
export function matchKeys(id: ShortcutId, platform: Platform = currentPlatform()): readonly string[] {
  const e = def(id);
  const alias = platform === 'mac' && e.macAlias ? e.macAlias : e.alias ?? [];
  return [...shortcutKeys(id, platform), ...alias];
}

export function shortcutsInScope(scope: ShortcutScope): ShortcutId[] {
  return (Object.keys(SHORTCUTS) as ShortcutId[]).filter(id => def(id).scope === scope);
}

interface Combo { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; key: string; mouse: boolean }

const MODIFIERS = new Set(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']);

/** Parse `Mod+Shift+K` for a platform. */
export function parseCombo(combo: string, platform: Platform = currentPlatform()): Combo {
  // The key is the last token; `+` as a key is not used.
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const c: Combo = { ctrl: false, meta: false, alt: false, shift: false, key, mouse: key === 'Click' };
  for (const p of parts) {
    if (!MODIFIERS.has(p)) throw new Error(`Unknown modifier "${p}" in "${combo}"`);
    if (p === 'Mod') { if (platform === 'mac') c.meta = true; else c.ctrl = true; }
    else if (p === 'Ctrl') c.ctrl = true;
    else if (p === 'Meta') c.meta = true;
    else if (p === 'Alt') c.alt = true;
    else c.shift = true;
  }
  return c;
}

const isLetter = (k: string) => /^[A-Z]$/.test(k);
const isDigit = (k: string) => /^[0-9]$/.test(k);
const isPunct = (k: string) => k.length === 1 && !isLetter(k) && !isDigit(k);
const PUNCT_CODES: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', '/': 'Slash' };

/** True when the event is this key combination. Letters also match by
 *  physical key when Alt is held (Option+N types "˜" on a Mac). Shift is
 *  free for punctuation keys (it is how `?` is typed). */
export function matchesCombo(e: KeyboardEvent, combo: string, platform: Platform = currentPlatform()): boolean {
  const c = parseCombo(combo, platform);
  if (c.mouse) return false;
  if (e.ctrlKey !== c.ctrl || e.metaKey !== c.meta || e.altKey !== c.alt) return false;
  const k = c.key;
  if (isPunct(k)) {
    if (e.key === k) return true;
    // With Ctrl/Cmd held some layouts report another character; the physical key decides.
    return (c.ctrl || c.meta) && !!PUNCT_CODES[k] && e.code === PUNCT_CODES[k] && e.shiftKey === c.shift;
  }
  if (e.shiftKey !== c.shift) return false;
  if (isLetter(k)) return e.key.toLowerCase() === k.toLowerCase() || ((c.alt || c.ctrl || c.meta) && e.code === `Key${k}`);
  if (isDigit(k)) return e.key === k || e.code === `Digit${k}`;
  if (k === 'Space') return e.key === ' ' || e.code === 'Space';
  return e.key === k;
}

/** A printable key typed without Ctrl, Cmd or Alt: it is text in a field. */
function isPrintable(combo: string): boolean {
  const c = parseCombo(combo, 'other');
  return !c.ctrl && !c.meta && !c.alt && (c.key.length === 1 || c.key === 'Space');
}

// ── text-field guard ────────────────────────────────────────────────

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** The element a key event really targets (inside shadow roots too). */
export function eventTarget(e: Event): Element | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const first = path[0] ?? e.target;
  return first instanceof Element ? first : null;
}

/** True when keys typed here are text: inputs, text areas, selects,
 *  contenteditable regions and code editors. */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('.cm-editor')) return true;
  const field = el.closest('input, textarea, select, [contenteditable]');
  if (!field) return false;
  if (field.tagName === 'INPUT') return !NON_TEXT_INPUTS.has(((field as HTMLInputElement).type || 'text').toLowerCase());
  if (field.hasAttribute('contenteditable')) return field.getAttribute('contenteditable') !== 'false';
  return true;
}

/** True when the key event is meant for a text field or code editor. */
export function isTypingIn(e: KeyboardEvent): boolean {
  return isTextEntry(eventTarget(e));
}

export interface MatchOptions {
  /** Ignore Ctrl/Cmd/Alt/Shift (Space on a badge copies with any modifier). */
  anyModifiers?: boolean;
  platform?: Platform;
}

/** True when the event triggers this action here: one of its keys, not an
 *  IME composition, and not text typed into a field unless the action allows it. */
export function matchesShortcut(e: KeyboardEvent, id: ShortcutId, opts: MatchOptions = {}): boolean {
  if (e.isComposing || e.key === 'Process') return false;
  const platform = opts.platform ?? currentPlatform();
  const entry = def(id);
  const typing = isTypingIn(e);
  for (const combo of matchKeys(id, platform)) {
    // With anyModifiers only the key itself counts (the modifiers carry meaning
    // for the handler, as Shift / Alt / Cmd do for a badge copy).
    const hit = opts.anyModifiers
      ? matchesCombo(stripModifiers(e), parseCombo(combo, platform).key, platform)
      : matchesCombo(e, combo, platform);
    if (!hit) continue;
    if (typing && (!entry.inText || isPrintable(combo))) return false;
    return true;
  }
  return false;
}

function stripModifiers(e: KeyboardEvent): KeyboardEvent {
  return { key: e.key, code: e.code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
}

/** The shortcut id, of those given, that the event triggers. */
export function whichShortcut<T extends ShortcutId>(e: KeyboardEvent, ids: readonly T[], opts?: MatchOptions): T | null {
  for (const id of ids) if (matchesShortcut(e, id, opts)) return id;
  return null;
}

// ── display ─────────────────────────────────────────────────────────

const MAC_GLYPH: Record<string, string> = { Mod: '⌘', Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const OTHER_NAME: Record<string, string> = { Mod: 'Ctrl', Meta: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const KEY_NAME: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter', Space: 'Space', Click: 'click',
};
const MOD_ORDER = ['Ctrl', 'Mod', 'Meta', 'Alt', 'Shift'];

/** One key combination as people read it: `Ctrl+Shift+F`, or `⌥⇧F` on a Mac. */
export function formatCombo(combo: string, platform: Platform = currentPlatform()): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const mods = parts.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const name = KEY_NAME[key] ?? key;
  if (platform === 'mac') return mods.map(m => MAC_GLYPH[m]).join('') + (key === 'Click' && mods.length ? '+click' : name);
  return [...mods.map(m => OTHER_NAME[m]), name].join('+');
}

/** Every documented key of an action, formatted. */
export function shortcutLabels(id: ShortcutId, platform: Platform = currentPlatform()): string[] {
  return shortcutKeys(id, platform).map(k => formatCombo(k, platform));
}

/** The first documented key of an action, formatted ('' when it has none). */
export function shortcutLabel(id: ShortcutId, platform: Platform = currentPlatform()): string {
  return shortcutLabels(id, platform)[0] ?? '';
}

/** Tooltip text with the action's key in parentheses: `Save (Ctrl+S)`. */
export function withShortcut(text: string, id: ShortcutId, platform: Platform = currentPlatform()): string {
  const label = shortcutLabel(id, platform);
  return label ? `${text} (${label})` : text;
}

/** The value for `aria-keyshortcuts` (`Control+S`, `Meta+S`). */
export function ariaKeyShortcuts(id: ShortcutId, platform: Platform = currentPlatform()): string {
  return shortcutKeys(id, platform).filter(k => !k.endsWith('Click')).map(k => {
    const c = parseCombo(k, platform);
    const mods = [c.ctrl ? 'Control' : '', c.meta ? 'Meta' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : ''].filter(Boolean);
    const key = c.key === 'Space' ? 'Space' : c.key;
    return [...mods, key].join('+');
  }).join(' ');
}

// ── CodeMirror ──────────────────────────────────────────────────────

/** A combination in CodeMirror's key syntax, resolved for the platform. */
export function cmKey(combo: string, platform: Platform = currentPlatform()): string {
  const c = parseCombo(combo, platform);
  const mods = [c.ctrl ? 'Ctrl' : '', c.meta ? 'Meta' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : ''].filter(Boolean);
  const key = isLetter(c.key) ? c.key.toLowerCase() : c.key;
  return [...mods, key].join('-');
}

export interface CmBinding {
  key: string;
  run: (view: EditorView) => boolean;
  preventDefault?: boolean;
}

/** CodeMirror key bindings for registry actions (every key and alias). */
export function cmBindings(actions: ReadonlyArray<{ id: ShortcutId; run: (view: EditorView) => boolean }>, platform: Platform = currentPlatform()): CmBinding[] {
  return actions.flatMap(({ id, run }) => matchKeys(id, platform)
    .filter(k => !k.endsWith('Click'))
    .map(k => ({ key: cmKey(k, platform), run, preventDefault: true })));
}

// ── cheat-sheet model ───────────────────────────────────────────────

export interface SheetRow { keys: string[]; label: string }
export interface SheetGroup { title: string; rows: SheetRow[] }

/** The cheat-sheet groups of a window, from the registry. `commandKeys`
 *  holds the live browser bindings (command name → shortcut, '' when unset). */
export function sheetGroups(win: ShortcutWindow, opts: { platform?: Platform; commandKeys?: ReadonlyMap<string, string> } = {}): SheetGroup[] {
  const platform = opts.platform ?? currentPlatform();
  const groups: SheetGroup[] = [];
  for (const scope of WINDOW_SCOPES[win] as readonly ShortcutScope[]) {
    const rows = shortcutsInScope(scope)
      .map(id => ({ keys: shortcutLabels(id, platform), label: def(id).label }))
      .filter(r => r.keys.length);
    if (rows.length) groups.push({ title: SCOPE_TITLES[scope], rows });
  }
  groups.push({ title: SCOPE_TITLES.browser, rows: browserCommandRows(opts.commandKeys, platform) });
  return groups;
}

/** Browser commands with their live keys when known, else the defaults. */
export function browserCommandRows(commandKeys?: ReadonlyMap<string, string>, platform: Platform = currentPlatform()): SheetRow[] {
  return shortcutsInScope('browser').map(id => {
    const e = def(id);
    const live = commandKeys && e.command ? commandKeys.get(e.command) : undefined;
    const keys = live !== undefined ? (live ? [live] : []) : shortcutLabels(id, platform);
    return { keys: keys.length ? keys : ['Not set'], label: e.label };
  });
}

/** The manifest `suggested_key` form of a browser command's default. */
export function manifestKey(id: ShortcutId, platform: Platform): string | undefined {
  const k = shortcutKeys(id, platform)[0];
  if (!k) return undefined;
  return k.split('+').map(p => (p === 'Mod' ? (platform === 'mac' ? 'Command' : 'Ctrl') : p)).join('+');
}
