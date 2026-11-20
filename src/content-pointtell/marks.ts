/**
 * Point and tell: the marks, as the user changes them. Every function changes `pt.marks`, stores them
 * (the page's sessionStorage) and draws. A mark here is the full shape (words, targets, meaning, ink);
 * the note tool makes only words plus one object or the page, and a drawing tool makes the rest through
 * `addMark` with the same call.
 */
import { showToast } from '../lib/toast';
import { findNode, findTabOf } from '../lib/layout/model';
import { loadMarks, newPageKey, saveMarks } from '../lib/point-tell/store';
import type { PtMark } from '../lib/point-tell/types';
import { pt } from './state';

let storeWarned = false;
/** Hooks the lifecycle fills in: drawing everything, and switching to a tab. Kept apart so this module has no view imports. */
export const hooks: { /** Open the paper page of a drawn page, or go back to the real page. */ enterPage: (n: number) => void; leavePage: () => void; /** Show the paper of a drawn tab (null: BMP's own tab) and measure again. */ showPaper: (id: string | null) => void; render: () => void; remeasure: () => void; showTab: (tabId: string) => boolean; /** Words were saved on mark `n` (`isNew`: a click made the mark). */ saved: (n: number, isNew: boolean) => void } = { enterPage: () => {}, leavePage: () => {}, showPaper: () => {}, render: () => {}, remeasure: () => {}, showTab: () => false, saved: () => {} };

/** Where the marks on screen are stored: the page's own key, or, on the paper page of a drawn page, the key of the page that does not exist yet. */
export const marksKey = (): string => (pt.page ? newPageKey(pt.rid) : pt.rid);

function persist(): void {
  if (saveMarks(marksKey(), { marks: pt.marks, next: pt.next }) || storeWarned) return;
  storeWarned = true;
  showToast('Notes could not be stored by the browser; they stay until you leave this page.', 'info');
}

/** Read this page's marks from the tab's storage (on entering, and on arriving at another page). */
export function restoreMarks(): void {
  const set = loadMarks(marksKey());
  pt.marks = set.marks;
  pt.next = set.next;
}

/** Replace the whole set (undo, redo, erase): stored and drawn. */
export function setMarks(marks: PtMark[], next: number): void {
  pt.marks = marks;
  pt.next = Math.max(next, marks.reduce((a, m) => Math.max(a, m.n), 0) + 1);
  persist();
  hooks.render();
}

export const markByNumber = (n: number): PtMark | undefined => pt.marks.find(m => m.n === n);

/** Add a mark; the number is the next one of this page and is never reused. Empty words with no target and no ink keep nothing. */
export function addMark(partial: Omit<PtMark, 'n' | 'at'>): PtMark | null {
  const empty = !partial.text.trim() && !partial.targets.length && !partial.ink && !partial.meaning;
  if (empty) return null;
  const mark: PtMark = { ...partial, text: partial.text.trim(), n: pt.next++, at: Date.now() };
  pt.marks = [...pt.marks, mark];
  persist();
  hooks.render();
  return mark;
}

/** Change a mark's words (and nothing else). Empty words on a mark that is only words (no meaning, no ink) remove it. */
export function updateMark(n: number, text: string): void {
  const m = markByNumber(n);
  if (!m) return;
  const words = text.trim();
  if (!words && !m.meaning && !m.ink) { deleteMark(n); return; }
  pt.marks = pt.marks.map(x => (x.n === n ? { ...x, text: words } : x));
  persist();
  hooks.render();
}

export function deleteMark(n: number): void {
  if (!markByNumber(n)) return;
  pt.marks = pt.marks.filter(m => m.n !== n);
  persist();
  hooks.render();
}

/** Remove every mark of this page (the caller has asked once already). The numbers start again. */
export function clearMarks(): void {
  pt.marks = [];
  pt.next = 1;
  persist();
  hooks.render();
}

// ── The note field ──────────────────────────────────────────────────────────────────────────────

/** A new note on one object, or (no ids) on the page. */
export function openNew(targets: string[]): void {
  pt.listOpen = false;
  pt.panelEl?.remove(); pt.panelEl = null;
  pt.editor = { n: null, targets, text: '', page: targets.length === 0 };
  pt.fieldEl?.remove(); pt.fieldEl = null;
  hooks.render();
}

export function openMark(n: number): void {
  const m = markByNumber(n);
  if (!m) return;
  pt.listOpen = false;
  pt.editor = { n, targets: m.targets, text: m.text, page: m.targets.length === 0 && !m.ink };
  pt.fieldEl?.remove(); pt.fieldEl = null;
  hooks.render();
}

/** The field for a mark just drawn: beside where the pen lifted. */
export function openInkMark(n: number, lift: [number, number]): void {
  const m = markByNumber(n);
  if (!m) return;
  pt.listOpen = false;
  pt.panelEl?.remove(); pt.panelEl = null;
  pt.editor = { n, targets: m.targets, text: m.text, page: false, lift };
  pt.fieldEl?.remove(); pt.fieldEl = null; // a field for the earlier mark is rebuilt for this one
  hooks.render();
}

/** Close the field the way the next stroke does: what was typed and the mark stay. */
export function closeEditorKeeping(): void {
  // Whatever the next action is, an open reply gives way to it.
  if (pt.reply) { pt.reply = null; hooks.render(); }
  const ed = pt.editor;
  if (!ed) return;
  const typed = pt.fieldEl?.querySelector('textarea')?.value ?? ed.text;
  closeEditor(true, typed);
}

/** Close the field; `save` keeps what was typed. */
export function closeEditor(save: boolean, text = ''): void {
  const e = pt.editor;
  if (!e) return;
  pt.editor = null;
  if (save) {
    if (e.n === null) { if (text.trim()) { const made = addMark({ text, targets: e.targets }); if (made) hooks.saved(made.n, true); } } // words are the note: none, no note
    else {
      const before = markByNumber(e.n)?.text ?? '';
      updateMark(e.n, text);
      if (text.trim() && text.trim() !== before) hooks.saved(e.n, false);
    }
  }
  hooks.render();
}

// ── Where a mark is ─────────────────────────────────────────────────────────────────────────────

/** The model tab a mark's first target is on; null for a page note or an object the layout no longer holds. */
export function tabOfMark(m: PtMark): string | null {
  const id = m.targets[0];
  if (!id || !pt.model) return null;
  return findTabOf(pt.model, id)?.id ?? null;
}

/** Whether the object a mark points at is still in the layout. */
export function targetsExist(m: PtMark): boolean {
  return !!pt.model && m.targets.every(id => !!findNode(pt.model!, id));
}
