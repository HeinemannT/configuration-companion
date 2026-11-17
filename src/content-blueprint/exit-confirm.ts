/**
 * The one way out of Blueprint. Every exit (the X, the Blueprint shortcut or
 * panel toggle, turning Inspect on, a template/instance switch, a request from
 * the page) asks here first. With nothing unsaved it answers at once; with
 * unsaved changes it shows one confirm that names how many would be lost:
 * "Discard 3 unsaved changes?" with Discard and Keep editing. Escape (or a
 * click outside) keeps editing. Concurrent asks share one dialog.
 *
 * A page reload or tab close keeps the browser's own "Leave site?" prompt
 * (content-blueprint.ts `beforeunload`).
 */

import { discardTitle, DISCARD_LABEL, KEEP_EDITING_LABEL } from '../lib/unsaved';

export type ExitDecision = 'leave' | 'ask' | 'busy';

/** Pure: what an exit request does for this state. `applying`: a confirmed
 *  Apply is writing; nothing may tear the overlay down until it settles. */
export function exitDecision(state: { pending: number; applying: boolean }): ExitDecision {
  if (state.applying) return 'busy';
  return state.pending > 0 ? 'ask' : 'leave';
}

export { discardTitle };

export interface ExitPromptOptions {
  /** What the user is about to do, for the body sentence. */
  action?: string;
  /** Where the dialog is mounted (the Blueprint layer; body in tests). */
  host: HTMLElement;
}

let open: { promise: Promise<boolean>; settle: (v: boolean) => void; el: HTMLElement } | null = null;

/** The open confirm's element: Blueprint's render clears its layer and puts this back. */
export function exitPromptElement(): HTMLElement | null { return open?.el ?? null; }

/** True while the confirm is showing (Escape layer and key guard read it). */
export function exitPromptOpen(): boolean { return open !== null; }

/** Close the confirm as "Keep editing" (Escape layer, teardown). */
export function keepEditing(): void { open?.settle(false); }

/** Show the confirm. Resolves true for Discard, false for Keep editing. */
export function askDiscard(pending: number, opts: ExitPromptOptions): Promise<boolean> {
  if (open) return open.promise;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  let settle!: (v: boolean) => void;
  let backEl!: HTMLElement;
  const promise = new Promise<boolean>(resolve => {
    const back = document.createElement('div');
    back.className = 'bp-modal-back bp-leave-back';
    const card = document.createElement('div');
    card.className = 'bp-modal bp-leave';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    const h = document.createElement('div');
    h.className = 'bp-modal-h';
    h.id = 'bp-leave-title';
    h.textContent = discardTitle(pending);
    card.setAttribute('aria-labelledby', h.id);
    const body = document.createElement('div');
    body.className = 'bp-modal-info bp-leave-body';
    body.id = 'bp-leave-body';
    body.textContent = `${opts.action ?? 'Leaving Blueprint'} drops ${pending === 1 ? 'this change' : `these ${pending} changes`}. Nothing has been written to BMP.`;
    card.setAttribute('aria-describedby', body.id);
    const foot = document.createElement('div');
    foot.className = 'bp-modal-foot';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'apply';
    keep.textContent = KEEP_EDITING_LABEL;
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'bp-leave-discard';
    discard.textContent = DISCARD_LABEL;
    foot.append(discard, keep);
    card.append(h, body, foot);
    back.append(card);
    backEl = back;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === keep ? discard : keep).focus();
      }
    };
    settle = (v: boolean) => {
      if (!open) return;
      open = null;
      card.removeEventListener('keydown', onKey);
      back.remove();
      try { previouslyFocused?.focus?.(); } catch { /* the opener left the page */ }
      resolve(v);
    };
    keep.addEventListener('click', () => settle(false));
    discard.addEventListener('click', () => settle(true));
    back.addEventListener('mousedown', e => { if (e.target === back) settle(false); });
    card.addEventListener('keydown', onKey);
    opts.host.append(back);
    keep.focus();
  });
  open = { promise, settle, el: backEl };
  return promise;
}
