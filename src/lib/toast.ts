/**
 * Toast notifications — top-right, auto-dismiss, at most 3 at once.
 *
 * Success and info toasts leave after a few seconds. An error stays 10
 * seconds, waits while the pointer is over it or focus is inside it, and has
 * a dismiss button and a "Show in Log" action, so a failure is not lost
 * before it is read.
 *
 * Shared by the content script and the side panel. A toast with the same
 * `key` as one already shown replaces it instead of stacking (one copy
 * toast at a time, however fast the user clicks). The container is a polite
 * live region; an error toast is an alert. Toasts never take focus.
 */

import { ICON_X } from './icons';

const CONTAINER_ID = 'crev-toast-container';
const MAX_TOASTS = 3;
export const AUTO_DISMISS_MS = 3000;
/** An error stays longer: it is the one message the user must not miss. */
export const ERROR_DISMISS_MS = 10_000;
/** After a pause, at least this much time is left to read the rest. */
const MIN_RESUME_MS = 1500;
const FADE_MS = 300;
/** z-index of the container: the top of the Companion layer stack, so a
 *  toast stays visible over an open task surface. Set inline (with
 *  `position`) so a toast that fires before any stylesheet is present cannot
 *  drop into the page flow or under the page. */
export const TOAST_Z_INDEX = '2147483647';

function ensureContainer(): HTMLDivElement {
  let container = document.getElementById(CONTAINER_ID) as HTMLDivElement | null;
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    // Leak floor: without inline position, a toast that fires before its stylesheet is present (a
    // connection toast in the content script, pre-Inspect) drops into normal page flow at the bottom.
    // The top/right coords differ between the content overlay (12px) and the side panel (8px), so
    // those stay in each context's stylesheet, which is always present in the panel.
    container.style.position = 'fixed';
    container.style.zIndex = TOAST_Z_INDEX;
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-relevant', 'additions text');
    document.body.appendChild(container);
  }
  return container;
}

/** Optional inline action button on a toast (e.g. "Reload"). When present
 *  the toast lingers longer so the user has time to click it. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** A toast with the same key replaces the shown one. Defaults to the text,
   *  so an identical message never stacks. */
  key?: string;
  /** A value shown after the text in monospace (an ID, a RID). Long values
   *  are shortened in the middle; the full value is the toast's title. */
  detail?: string;
  /** The Log entry that records this error (set by the worker for its toasts). */
  logId?: number;
  /** Error only: no "Show in Log" action (for a toast that reports a failure to reach the Log). */
  showInLog?: false;
  /** Error only: the raw cause (a transport message), kept out of the toast text and carried to
   *  the Log by "Show in Log" (the toast's "Details"). */
  logDetail?: string;
  /** Success or info: stays twice as long, for a result shown after the page changed under the user. */
  long?: true;
}

/** What "Show in Log" asks of the context that shows the toast. */
export interface ShowInLogRequest {
  text: string;
  detail?: string;
  logId?: number;
}

let showInLogHandler: ((request: ShowInLogRequest) => void) | null = null;

/** The context (page or side panel) says how its error toasts reach the Log. */
export function setShowInLogHandler(handler: ((request: ShowInLogRequest) => void) | null): void {
  showInLogHandler = handler;
}

export const SHOW_IN_LOG_LABEL = 'Show in Log';

// Toasts carrying an action stay up longer — a 3s window is too short to
// read "saved, reload to see it" and decide to click.
const ACTION_DISMISS_MS = 8000;
/** A result the user has to find on the page first (`long`). */
export const LONG_DISMISS_MS = 6000;
/** Longest detail shown in full. */
const DETAIL_MAX = 36;

/** Shorten `value` to at most `max` characters by cutting its middle, so
 *  both the start and the end of an ID stay readable. */
export function truncateMiddle(value: string, max = DETAIL_MAX): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}

interface ShownToast { el: HTMLDivElement; cancel: () => void }
const shown = new Map<string, ShownToast>();

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'crev-toast__action';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

export function showToast(
  text: string,
  type: 'success' | 'error' | 'info',
  action?: ToastAction,
  options: ToastOptions = {},
) {
  const container = ensureContainer();
  const key = options.key ?? `${type}:${text}`;

  const previous = shown.get(key);
  if (previous?.el.isConnected) {
    previous.cancel();
    previous.el.remove();
  }
  shown.delete(key);

  const toast = document.createElement('div');
  toast.className = `crev-toast crev-toast--${type} crev-toast--visible`;
  // An error interrupts; everything else waits its turn in the container's
  // polite region.
  if (type === 'error') toast.setAttribute('role', 'alert');

  const label = document.createElement('span');
  label.className = 'crev-toast__text';
  label.textContent = text;
  toast.append(label);
  if (options.detail) {
    const detail = document.createElement('span');
    detail.className = 'crev-toast__detail';
    detail.textContent = truncateMiddle(options.detail);
    toast.title = options.detail;
    toast.append(detail);
  }

  let dismiss: () => void = () => undefined;
  const buttons: HTMLElement[] = [];
  if (action) {
    buttons.push(actionButton(action.label, () => {
      action.onClick();
      dismiss();
    }));
  } else if (type === 'error' && showInLogHandler && options.showInLog !== false) {
    const handler = showInLogHandler;
    const request: ShowInLogRequest = {
      text,
      ...(options.detail || options.logDetail ? { detail: [options.detail, options.logDetail].filter(Boolean).join('\n') } : {}),
      ...(options.logId != null ? { logId: options.logId } : {}),
    };
    buttons.push(actionButton(SHOW_IN_LOG_LABEL, () => {
      handler(request);
      dismiss();
    }));
  }
  if (type === 'error') {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'crev-toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.title = 'Dismiss';
    close.innerHTML = ICON_X;
    close.addEventListener('click', () => dismiss());
    buttons.push(close);
  }
  if (buttons.length) {
    toast.classList.add('crev-toast--with-action');
    toast.append(...buttons);
  }

  // A replacement takes the old toast's place without an entry animation,
  // so a burst of copies reads as one toast whose text changes.
  if (previous) toast.classList.add('crev-toast--replaced');
  container.appendChild(toast);

  // Enforce max stacked
  while (container.children.length > MAX_TOASTS) {
    container.children[0].remove();
  }

  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = type === 'error' ? ERROR_DISMISS_MS : action ? ACTION_DISMISS_MS : options.long ? LONG_DISMISS_MS : AUTO_DISMISS_MS;
  let startedAt = 0;
  let hovered = false;
  let focused = false;
  let gone = false;

  const arm = () => {
    if (timer) clearTimeout(timer);
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  // WCAG 2.2.1: time stops while the user is reading or acting on the toast.
  const sync = () => {
    if (hovered || focused) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(remaining - (Date.now() - startedAt), MIN_RESUME_MS);
      }
    } else if (!timer && !gone) {
      arm();
    }
  };
  toast.addEventListener('mouseenter', () => { hovered = true; sync(); });
  toast.addEventListener('mouseleave', () => { hovered = false; sync(); });
  toast.addEventListener('focusin', () => { focused = true; sync(); });
  toast.addEventListener('focusout', (ev) => {
    if (ev.relatedTarget instanceof Node && toast.contains(ev.relatedTarget)) return;
    focused = false;
    sync();
  });

  dismiss = () => {
    if (gone || !toast.isConnected) return;
    gone = true;
    if (shown.get(key)?.el === toast) shown.delete(key);
    if (timer) clearTimeout(timer);
    timer = undefined;
    toast.classList.remove('crev-toast--visible');
    toast.classList.add('crev-toast--exit');
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => toast.remove(), FADE_MS);
  };

  arm();
  shown.set(key, { el: toast, cancel: () => { if (timer) clearTimeout(timer); timer = undefined; } });
}
