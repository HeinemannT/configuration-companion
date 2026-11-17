/**
 * Hover prefetch: when the pointer rests on a badge, ask the service worker
 * to start the object window's root read, so a double-click that follows
 * opens at once.
 *
 * The read is background work in the service worker (request-class.ts): it
 * never goes ahead of a user action. One object at a time: resting on
 * another badge supersedes the previous read there. Fly-over sends nothing.
 */

import { sendFireForget } from './lib/messaging';

/** How long the pointer rests on a badge before the read starts. */
export const HOVER_PREFETCH_DELAY = 200;
/** A rid asked for within this time is not asked for again (the service
 *  worker keeps a finished read about this long). */
const REPEAT_MS = 6_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let last: { rid: string; at: number } | null = null;

export function scheduleHoverPrefetch(rid: string, objectType?: string): void {
  cancelHoverPrefetch();
  timer = setTimeout(() => {
    timer = null;
    if (last && last.rid === rid && Date.now() - last.at < REPEAT_MS) return;
    last = { rid, at: Date.now() };
    sendFireForget({ type: 'PREFETCH_OBJECT_VIEW', rid, ...(objectType ? { objectType } : {}) });
  }, HOVER_PREFETCH_DELAY);
}

/** The pointer left the badge before the delay ran out: send nothing. */
export function cancelHoverPrefetch(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** For tests. */
export function resetHoverPrefetch(): void {
  cancelHoverPrefetch();
  last = null;
}
