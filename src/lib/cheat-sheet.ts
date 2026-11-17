/**
 * The `?` cheat sheet: one modal panel that lists the keys of the current
 * window, generated from the shortcut registry, plus the live browser
 * command keys. Every window opens it the same way (`?` outside text fields,
 * F1, or its help button). Keyboard operable: focus moves into the dialog,
 * Tab stays inside, Escape closes it and focus returns where it was.
 * Styles: `.ui-keys*` in src/styles/ui.css (the Blueprint page copy sets its
 * position inline and takes its look from content-blueprint.css).
 */
import { escapeLayers } from './escape-layers';
import {
  formatCombo, matchesShortcut, sheetGroups, shortcutLabel,
  type SheetGroup, type ShortcutWindow,
} from './shortcuts';

export interface CheatSheetOptions {
  window: ShortcutWindow;
  /** Title of the dialog (default "Keyboard shortcuts"). */
  title?: string;
  /** Non-key notes shown after the keys (gestures, concepts). */
  notes?: SheetGroup[];
  /** Paragraphs shown at the end. */
  footer?: string[];
  doc?: Document;
  /** Parent element (default body). */
  mount?: HTMLElement;
  /** Set position and stacking inline (for pages without ui.css). */
  inline?: boolean;
  /** Extra class on the backdrop (the page copy styles itself by it). */
  className?: string;
  onClose?: () => void;
}

interface OpenSheet { el: HTMLElement; close: () => void }
const openSheets = new WeakMap<Document, OpenSheet>();

/** Live browser command keys, where the page may read them. */
async function liveCommandKeys(): Promise<ReadonlyMap<string, string> | undefined> {
  try {
    const commands = typeof chrome !== 'undefined' ? chrome.commands : undefined;
    if (!commands?.getAll) return undefined;
    const all = await commands.getAll();
    return new Map(all.filter(c => c.name).map(c => [c.name!, c.shortcut ?? '']));
  } catch {
    return undefined;
  }
}

export function isCheatSheetOpen(doc: Document = document): boolean {
  return openSheets.has(doc);
}

export function closeCheatSheet(doc: Document = document): void {
  openSheets.get(doc)?.close();
}

/** Build the rows of a sheet (exported for tests and the side panel band). */
export function renderSheetGroups(doc: Document, groups: readonly SheetGroup[]): HTMLElement {
  const body = doc.createElement('div');
  body.className = 'ui-keys-body';
  for (const g of groups) {
    const sec = doc.createElement('section');
    sec.className = 'ui-keys-group';
    const h = doc.createElement('h3');
    h.textContent = g.title;
    const dl = doc.createElement('dl');
    for (const r of g.rows) {
      const dt = doc.createElement('dt');
      r.keys.forEach((k, i) => {
        if (i) dt.append(doc.createTextNode(' or '));
        const kbd = doc.createElement('kbd');
        kbd.textContent = k;
        dt.append(kbd);
      });
      const dd = doc.createElement('dd');
      dd.textContent = r.label;
      dl.append(dt, dd);
    }
    sec.append(h, dl);
    body.append(sec);
  }
  return body;
}

export function openCheatSheet(opts: CheatSheetOptions): OpenSheet {
  const doc = opts.doc ?? document;
  const existing = openSheets.get(doc);
  if (existing) return existing;
  const returnTo = doc.activeElement as HTMLElement | null;

  const back = doc.createElement('div');
  back.className = opts.className ? `ui-keys-back ${opts.className}` : 'ui-keys-back';
  const dialog = doc.createElement('div');
  dialog.className = 'ui-keys';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const titleId = `ui-keys-title-${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute('aria-labelledby', titleId);
  if (opts.inline) {
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;';
    dialog.style.cssText = 'position:relative;max-height:80vh;overflow:auto;';
  }

  const head = doc.createElement('div');
  head.className = 'ui-keys-head';
  const title = doc.createElement('h2');
  title.id = titleId;
  title.textContent = opts.title ?? 'Keyboard shortcuts';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ui-keys-close';
  closeBtn.title = `Close (${formatCombo('Escape')})`;
  closeBtn.setAttribute('aria-label', 'Close keyboard shortcuts');
  closeBtn.textContent = '×';
  head.append(title, closeBtn);

  let body = renderSheetGroups(doc, [...sheetGroups(opts.window), ...(opts.notes ?? [])]);
  body.tabIndex = 0;
  body.setAttribute('aria-label', 'Shortcut list');
  dialog.append(head, body);
  const foot = doc.createElement('div');
  foot.className = 'ui-keys-foot';
  for (const text of [...(opts.footer ?? []), `Browser commands can be changed at chrome://extensions/shortcuts. ${shortcutLabel('sheet.open')} opens this list.`]) {
    const p = doc.createElement('p');
    p.textContent = text;
    foot.append(p);
  }
  dialog.append(foot);
  back.append(dialog);
  (opts.mount ?? doc.body).append(back);

  // The live browser keys arrive asynchronously on extension pages.
  void liveCommandKeys().then(keys => {
    if (!keys || !back.isConnected) return;
    const next = renderSheetGroups(doc, [...sheetGroups(opts.window, { commandKeys: keys }), ...(opts.notes ?? [])]);
    next.tabIndex = 0;
    next.setAttribute('aria-label', 'Shortcut list');
    body.replaceWith(next);
    body = next;
  });

  let closed = false;
  const unregister = escapeLayers(doc).register({ kind: 'dialog', name: 'cheat-sheet', phase: 'capture', isOpen: () => !closed, close: () => { close(); } });
  const close = () => {
    if (closed) return;
    closed = true;
    unregister();
    back.remove();
    openSheets.delete(doc);
    try { if (returnTo?.isConnected) returnTo.focus(); } catch { /* ignore */ }
    opts.onClose?.();
  };
  closeBtn.addEventListener('click', close);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  dialog.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const stops = [closeBtn, body];
      const at = stops.indexOf(doc.activeElement as HTMLElement);
      e.preventDefault();
      stops[(at + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length]?.focus();
      return;
    }
    // `?` again closes; other keys stay inside the dialog.
    if (matchesShortcut(e, 'sheet.open')) { e.preventDefault(); close(); }
    e.stopPropagation();
  });
  const sheet = { el: back, close };
  openSheets.set(doc, sheet);
  closeBtn.focus();
  return sheet;
}

export function toggleCheatSheet(opts: CheatSheetOptions): void {
  const doc = opts.doc ?? document;
  if (openSheets.has(doc)) closeCheatSheet(doc);
  else openCheatSheet(opts);
}

/** `?` (and F1) anywhere in the window outside text fields opens the sheet.
 *  `options` is read at press time so notes can follow the window's state. */
export function installCheatSheetKey(options: () => CheatSheetOptions, target: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, 'sheet.open')) return;
    e.preventDefault();
    toggleCheatSheet({ doc: target, ...options() });
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
