/**
 * Point and tell: the page answers a mark. Two small things happen when ink has been read: its tag shows
 * (tags.ts) and the mark reacts (mascot.ts). A stroke that follows and joins the mark starts the wait again, so
 * a sketch is announced once, as what it came to be.
 */
import { markByNumber } from './marks';
import { react } from './mascot';
import { scheduleTag } from './tags';

/** The reading is quiet for this long after the pen lifts before it is said. */
export const SETTLE_MS = 250;

/** Ink was drawn and mark `n` was read: say what it was understood as, after `settleMs`. */
export function markRead(n: number, settleMs = SETTLE_MS): void {
  scheduleTag(n, settleMs, () => {
    const m = markByNumber(n);
    if (!m?.ink) return;
    if (m.meaning?.kind === 'crossed') react('wince');
    // Ink with no meaning and no reading: not understood.
    else if (!m.meaning && !m.reading) react('curious');
  });
}
