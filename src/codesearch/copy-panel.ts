/**
 * The code search window's "copy on this computer" block and its notice
 * when a copy did not start or stopped. Built from the worker's
 * CodeIndexStatus alone; the window passes the actions in (they send the
 * messages). Quiet by default: one line per fact, the rest on hover or
 * behind a small expander.
 *
 *  - none: what a copy gives, what it costs (the estimate) and Make copy.
 *  - a copy (complete, paused, failed, being made): where it is kept, what
 *    it holds (objects, size of code text, per place behind "By place"),
 *    when it was made and last refreshed, what the last refresh did, what it
 *    does not cover, and Refresh / Resume and Remove copy. Copies of the same
 *    server for other server profiles are listed with their own Remove.
 *  - Companion's parsed scripts in the server's memory, once they hold
 *    background work back (the count starts again by itself when Companion
 *    sees the server restart).
 */

import type { CodeCopyEstimate, CodeIndexStatus } from '../lib/messages';
import { attrs, btn, el, icon, type Kid } from '../lib/dom';
import { dateTimeText, timeOfDay } from '../lib/coverage-line';
import { charsWords, copyProblemView, durationWords, serverScriptsSentence, sizeWords } from '../lib/copy-status-text';

const fmt = (n: number): string => String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

/** What the user is waiting on after a press (the worker's answer). */
export type CopyPending = 'sync' | 'remove' | null;

/** A press the worker did not answer: which one, so the notice offers the
 *  same press again. */
export type CopyPress = { kind: 'sync'; force: boolean } | { kind: 'remove'; environment?: string };

export interface CopyPanelActions {
  /** Make copy, Refresh, Resume or Try again (`force`: a Refresh of a
   *  complete copy, which also turns an index of the older builder into a copy). */
  sync(force: boolean): void;
  /** Remove this window's copy, or (`environment`) another profile's copy
   *  of the same server. */
  remove(environment?: string): void;
  /** What a copy would cost (one listing on the server, as a search lists). */
  estimate(): void;
  close(): void;
  /** Hide the notice until the next problem. */
  dismiss(): void;
}

/** The estimate as the window holds it: not asked yet (undefined), being
 *  listed (null), or its answer. */
export type CopyEstimateState = { value?: CodeCopyEstimate; error?: string } | null | undefined;

/** The word of the action that continues or repeats the copy now. */
export function retryLabel(s: Pick<CodeIndexStatus, 'state' | 'builtAt'> | null): 'Refresh' | 'Resume' | 'Try again' | 'Make copy' {
  if (!s || s.state === 'none') return 'Make copy';
  if (s.builtAt) return 'Refresh';
  return s.state === 'paused' ? 'Resume' : 'Try again';
}

/** A stored copy is there (complete, paused, failed or being made). */
export const hasCopy = (s: CodeIndexStatus | null): boolean => {
  if (!s || s.state === 'none' || s.state === 'unavailable') return false;
  // A first build that failed before it stored anything leaves no copy.
  return s.state !== 'failed' || s.objects > 0 || s.progress != null;
};

const busyWord = (p: CopyPending, mine: CopyPending, idle: string): string => (p === mine && mine ? 'Asking…' : idle);

/** One fact row: a label and its text, the detail on hover. */
function fact(label: string, text: Kid | Kid[], hover?: string): HTMLElement {
  const v = el('span', 'cs-cp-v', ...(Array.isArray(text) ? text : [text]));
  if (hover) v.title = hover;
  return el('div', 'cs-cp-row', el('span', 'cs-cp-k', label), v);
}

/** "3 objects changed and 1 removed in 12 requests (8.2 s)", "Nothing changed (1 request, 0.4 s)". */
export function lastRefreshText(last: NonNullable<CodeIndexStatus['last']>): string {
  const cost = `${plural(last.posts, 'request')}, ${durationWords(last.ms)}`;
  if (last.first) return `${cost.charAt(0).toUpperCase()}${cost.slice(1)}.`;
  if (last.unchanged || (!last.changed && !last.removed)) return `Nothing changed on the server (${cost}).`;
  const parts = [last.changed ? `${plural(last.changed, 'object')} read again` : '', last.removed ? `${fmt(last.removed)} removed` : ''].filter(Boolean).join(' and ');
  return `${parts.charAt(0).toUpperCase()}${parts.slice(1)} (${cost}).`;
}

/** The block, opened by the user from the footer. */
export function copyPanel(s: CodeIndexStatus | null, a: CopyPanelActions, o: { estimate: CopyEstimateState; pending: CopyPending; now?: number }): HTMLElement {
  const now = o.now ?? Date.now();
  const box = attrs(el('section', 'cs-instant cs-cp'), { 'aria-label': 'Copy on this computer' });
  const head = el('div', 'cs-cp-head', el('h3', '', 'Copy on this computer'), el('span', 'grow'), btn('ui-ibtn', 'Close', () => a.close(), icon('i-x')));
  box.append(head);
  if (!hasCopy(s)) {
    box.append(el('p', '', 'A copy keeps this server\'s Extended Code in this browser profile on this computer. Searches then start at once, also after the browser restarts. Without it, a search reads the code from the server and keeps it only while this window is open.'),
      el('p', 'cs-muted', 'It is made with the same read as a search, paced so the server keeps working. It does not change by itself: Refresh asks the server what changed and reads only that.'));
    if (s?.state === 'unavailable') { box.append(el('p', 'cs-muted', 'This server cannot be copied: it has no bulk read.')); return box; }
    const e = o.estimate;
    const cost = e === undefined ? el('span', 'grow', btn('cs-link', 'List the code on the server, as a search does, and say what a copy costs', () => a.estimate(), 'What a copy costs'))
      : !e ? el('span', 'grow cs-muted', 'Listing the code on the server, as a search does…')
      : e.value ? el('span', 'grow', `${plural(e.value.objects, 'object')} with code (${charsWords(e.value.chars)} characters). About ${plural(e.value.posts, 'request')}, ${durationWords(e.value.seconds * 1000)}.${e.value.perSource ? ' Too much code to read in one go: it is read place by place.' : ''}${e.value.failedSources?.length ? ` Not listed: ${e.value.failedSources.join(', ')}.` : ''}`)
      : el('span', 'grow cs-muted', `What it costs could not be told: ${e.error ?? 'no answer'}.`);
    const make = btn('ui-btn primary', 'Make a copy of this server\'s code on this computer', () => a.sync(false), busyWord(o.pending, 'sync', 'Make copy'));
    make.disabled = o.pending === 'sync';
    box.append(el('div', 'cs-instant-row', cost, make));
    others(box, s, a, now);
    return box;
  }
  const st = s!;
  const facts = el('div', 'cs-cp-facts');
  facts.append(fact('Kept', 'In this browser profile on this computer.', 'Stored by the extension in this browser profile (IndexedDB). It goes with Remove copy, when the server profile is removed or its sign-in changes, and with Clear cached objects.'));
  const roots = st.roots ?? [];
  const byPlace = roots.map(r => `${r.name}: ${fmt(r.objects)}${r.done ? '' : ' (not complete)'}`).join('\n');
  const holds: Kid[] = [`${plural(st.objects, 'object')} with code, ${sizeWords(st.bytes)} of code text.`];
  if (roots.length) {
    const d = attrs(el('details', 'cs-cp-more', el('summary', '', 'By place'),
      el('ul', '', ...roots.map(r => el('li', '', el('span', '', r.name), el('span', 'cs-muted', `${fmt(r.objects)}${r.done ? '' : ', not complete'}`))))), { 'data-k': 'places' });
    holds.push(' ', d);
  }
  // A copy that is not complete counts its objects and places only at its
  // end: until then "Made" (or the progress) says how far it is.
  if (st.builtAt) facts.append(fact('Holds', holds, byPlace || undefined));
  if (st.builtAt) {
    const refreshed = st.syncedAt != null && st.syncedAt !== st.builtAt;
    facts.append(fact('Made', `${dateTimeText(st.builtAt, now)}.${refreshed ? ` Last refreshed ${dateTimeText(st.syncedAt!, now)}.` : ' Not refreshed since.'}`));
  } else if (st.state === 'paused' || st.state === 'failed') {
    const p = st.progress;
    facts.append(fact('Made', p?.toRead ? `Not complete: ${fmt(p.read)} of ${plural(p.toRead, 'object')} read. Searches read the server meanwhile.` : 'Not complete. Searches read the server meanwhile.'));
  }
  if (st.last) facts.append(fact(st.last.first ? 'Made with' : 'Last refresh', lastRefreshText(st.last), `${dateTimeText(st.last.at, now)}`));
  if (st.stopped) facts.append(fact('Last refresh', 'Stopped by you. The copy is unchanged.'));
  if (st.notCovered?.length) {
    const nc = st.notCovered;
    facts.append(fact('Missing', nc.length === 1 ? `${nc[0]}.` : attrs(el('details', 'cs-cp-more', el('summary', '', plural(nc.length, 'item')), el('ul', '', ...nc.map(t => el('li', '', t)))), { 'data-k': 'gaps' })));
  }
  box.append(facts);
  const running = st.state === 'building' || st.state === 'refreshing';
  if (!running) {
    const label = retryLabel(st);
    const go = btn('ui-btn primary', label === 'Refresh' ? 'Ask the server what changed since this copy and read only that' : label === 'Resume' ? 'Continue making the copy' : 'Make the copy again', () => a.sync(!!st.builtAt), busyWord(o.pending, 'sync', label));
    go.disabled = o.pending === 'sync';
    const rm = btn('ui-btn', 'Delete the copy of this server\'s code on this computer', () => a.remove(), busyWord(o.pending, 'remove', 'Remove copy'));
    rm.disabled = o.pending === 'remove';
    box.append(el('div', 'cs-instant-row', el('span', 'grow cs-muted', 'Remove copy deletes it from this computer. Searches then read the server again.'), rm, go));
  }
  others(box, st, a, now);
  return box;
}

/** Copies of the same server for other profiles, and the server's memory note. */
function others(box: HTMLElement, s: CodeIndexStatus | null, a: CopyPanelActions, now: number): void {
  for (const c of s?.others ?? []) {
    const when = c.builtAt ? `from ${dateTimeText(c.syncedAt ?? c.builtAt, now)}` : 'not complete';
    box.append(el('div', 'cs-instant-row cs-cp-other', el('span', 'grow', `Also on this computer: a copy of this server for ${c.profile} (${plural(c.objects, 'object')}, ${sizeWords(c.bytes)}, ${when}).`),
      btn('ui-btn', `Delete the copy for ${c.profile} from this computer`, () => a.remove(c.environment), 'Remove')));
  }
  if (s?.serverScripts) box.append(el('div', 'cs-instant-row cs-cp-mem', icon('i-info'), el('span', 'grow cs-muted', serverScriptsSentence(s.serverScripts, now))));
}

/** The notice when a copy did not start or stopped (null: nothing to say).
 *  `noAnswer`: the window's own press that got no answer from the worker;
 *  the notice offers that press again. */
export function problemNotice(s: CodeIndexStatus | null, a: CopyPanelActions, o: { pending: CopyPending; noAnswer?: CopyPress | null; now?: number }): HTMLElement | null {
  const now = o.now ?? Date.now();
  const running = s?.state === 'building' || s?.state === 'refreshing';
  const press = o.noAnswer ?? null;
  const view = press
    ? { title: 'No answer', sentence: 'Companion did not answer the request.', where: 'computer' as const, actions: ['retry' as const], retryAt: undefined, detail: undefined }
    : s?.problem && !running ? copyProblemView(s.problem, now) : null;
  if (!view) return null;
  const n = attrs(el('div', 'ui-failed ui-failed--block cs-cp-problem'), { role: 'alert', 'data-kind': press ? 'no-answer' : s!.problem!.kind, 'data-where': view.where });
  n.append(el('div', 'cs-cp-head', el('strong', 'ui-failed-title', view.title), el('span', 'grow'), btn('ui-ibtn', 'Hide this note', () => a.dismiss(), icon('i-x'))),
    el('span', 'ui-failed-t', view.sentence));
  const acts = el('div', 'cs-actions');
  if (press?.kind === 'remove') {
    const again = btn('ui-btn primary', undefined, () => a.remove(press.environment), busyWord(o.pending, 'remove', 'Remove copy'));
    again.disabled = o.pending === 'remove';
    acts.append(again);
  } else if (view.actions.includes('retry')) {
    const label = retryLabel(s);
    const later = view.retryAt != null && view.retryAt > now;
    const go = btn('ui-btn primary', later ? `Companion sends this server no background work until then` : undefined, () => a.sync(press?.kind === 'sync' ? press.force : !!s?.builtAt), later ? `${label} after ${timeOfDay(view.retryAt!, now)}` : busyWord(o.pending, 'sync', label));
    go.disabled = later || o.pending === 'sync';
    acts.append(go);
  }
  if (acts.childElementCount) n.append(acts);
  if (view.detail) n.append(attrs(el('details', '', el('summary', '', 'Details'), el('span', 'ui-failed-detail', view.detail)), { 'data-k': 'detail' }));
  return n;
}
