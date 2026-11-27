/**
 * Progress of the local code copy ("Keep a copy on this computer"), one
 * component for every page that shows it (the code search window, the Atlas
 * page). Driven only by a CodeIndexStatus and the local clock: no messaging
 * inside. The page passes each status it gets to `update` and wires Stop
 * (`onStop`, the page sends CODE_INDEX_CANCEL).
 *
 *   const progress = createCopyProgress({ onStop: () => sendFireForget({ type: 'CODE_INDEX_CANCEL' }) });
 *   slot.append(progress.el);
 *   onStatus = s => progress.update(s);
 *
 * Styles: src/styles/copy-progress.css (the page loads it after ui.css,
 * with mark.css for the mark's eyes). Light theme only.
 *
 * What it shows, all from the status: the phase in words (listing, reading,
 * writing), n of m objects on a determinate bar (an indeterminate one while
 * the total is not known), the place being read, requests sent, the time
 * since the start, the time left once this sync's own pace tells it, and the
 * load governor's waits with a countdown. The Companion mark rides the bar's
 * leading edge and reads while the work runs; it rests while the server is
 * waited for. Nothing moves under reduced motion.
 */

import type { CodeIndexStatus } from './messages';
import { markSvg, setMarkMood } from './companion-mark';
import { copyProgressView, copyRunning, type ReadMark } from './copy-status-text';

export interface CopyProgress {
  /** The component's root (hidden while there is nothing to show). */
  el: HTMLElement;
  /** Show this status (any state; only a running or paused copy shows). */
  update(status: CodeIndexStatus | null): void;
  /** Stop the clock (the page drops the component). */
  destroy(): void;
}

export interface CopyProgressOptions {
  /** Stop pressed (shown only while a copy runs and this is given). */
  onStop?: () => void;
  /** The clock (tests). */
  now?: () => number;
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function createCopyProgress(opts: CopyProgressOptions = {}): CopyProgress {
  const now = opts.now ?? Date.now;
  const el = make('div', 'crev-cp');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Copy progress');
  el.hidden = true;
  const title = make('span', 'crev-cp-title');
  const facts = make('span', 'crev-cp-facts');
  const stop = make('button', 'crev-cp-stop', 'Stop');
  stop.type = 'button';
  stop.hidden = true;
  stop.addEventListener('click', () => opts.onStop?.());
  const head = make('div', 'crev-cp-head');
  head.append(title, facts, stop);
  const fill = make('i', 'crev-cp-fill');
  const rider = make('span', 'crev-cp-rider crev-mark');
  rider.setAttribute('aria-hidden', 'true');
  rider.innerHTML = markSvg();
  const track = make('div', 'crev-cp-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', 'Copy progress');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.append(fill, rider);
  const line = make('div', 'crev-cp-line');
  line.setAttribute('aria-live', 'polite');
  el.append(head, track, line);

  let status: CodeIndexStatus | null = null;
  let mark: ReadMark | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;

  const render = (): void => {
    const t = now();
    const view = status ? copyProgressView(status, t, mark) : null;
    el.hidden = !view;
    if (!view) { setMarkMood(rider, false); return; }
    el.dataset.run = view.running ? 'on' : 'off';
    el.toggleAttribute('data-wait', view.waiting);
    el.toggleAttribute('data-known', view.fraction != null);
    if (title.textContent !== view.title) title.textContent = view.title;
    const f = view.facts.join(' · ');
    if (facts.textContent !== f) facts.textContent = f;
    if (line.textContent !== view.line) line.textContent = view.line;
    el.style.setProperty('--cp', String(view.fraction ?? 0));
    if (view.fraction != null) { track.setAttribute('aria-valuenow', String(Math.round(view.fraction * 100))); track.removeAttribute('aria-valuetext'); }
    else { track.removeAttribute('aria-valuenow'); track.setAttribute('aria-valuetext', view.line); }
    stop.hidden = !view.running || !opts.onStop;
    stop.title = status?.state === 'refreshing' ? 'Stop the refresh. The copy stays usable.' : 'Stop copying. Resume continues it.';
    setMarkMood(rider, view.running && !view.waiting);
  };

  const tick = (on: boolean): void => {
    if (on && !clock) clock = setInterval(render, 1_000);
    else if (!on && clock) { clearInterval(clock); clock = null; }
  };

  return {
    el,
    update(s) {
      status = s;
      const p = s?.progress;
      // This sync's pace is measured from the first reading status it sent.
      if (!copyRunning(s)) mark = null;
      else if (!p || p.phase !== 'reading' || !p.toRead) { /* not reading yet, or a pause: keep the mark */ }
      else if (!mark || mark.toRead !== p.toRead || p.read < mark.read) mark = { at: now(), read: p.read, toRead: p.toRead };
      tick(copyRunning(s));
      render();
    },
    destroy() { tick(false); },
  };
}
