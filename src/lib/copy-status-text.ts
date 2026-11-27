/**
 * The words for the local code copy ("Keep a copy on this computer") that
 * more than one page shows: how far a copy is (copy-progress.ts), why one
 * stopped (CodeCopyProblem) and what Companion keeps in the server's memory.
 * Pure: driven by a CodeIndexStatus and the time, no messaging, no DOM.
 *
 * Wording: plain BMP words, short sentences, no em dashes. Every sentence
 * says where the thing it counts lives: on this computer (the copy, in this
 * browser profile) or on the server (its memory, its load).
 */

import type { CodeCopyProblem, CodeIndexStatus } from './messages';
import { dateTimeText, timeOfDay } from './coverage-line';
import { mbPhrase } from './script-ledger';

const fmt = (n: number): string => String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

/** "42 s", "3 min 20 s", "1 h 5 min". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** "4.3 M", "850 K", "120" characters. */
export function charsWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)} K`;
  return fmt(n);
}

/** Size of code text on this computer: "1.2 MB", "380 KB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

/** A sync of the copy runs now. */
export const copyRunning = (s: Pick<CodeIndexStatus, 'state'> | null | undefined): boolean => s?.state === 'building' || s?.state === 'refreshing';

/** Where the read of a running sync started counting, so the time left
 *  rests on what was measured in this sync (copy-progress keeps it). */
export interface ReadMark { at: number; read: number; toRead: number }

export interface CopyProgressView {
  /** "Making the copy", "Refreshing the copy", "Copying stopped". */
  title: string;
  /** One short line of what happens now. */
  line: string;
  /** 0..1 when the total is known; null: not known yet (indeterminate). */
  fraction: number | null;
  /** Elapsed time ("2 min 14 s"), requests sent ("42 requests") and the
   *  time left when it can be told from this sync's own pace. */
  facts: string[];
  /** The load governor holds the work back now. */
  waiting: boolean;
  /** The work runs (Stop applies). */
  running: boolean;
}

/** The progress of the copy in words (null: nothing to show). */
export function copyProgressView(s: CodeIndexStatus, now = Date.now(), mark: ReadMark | null = null): CopyProgressView | null {
  const running = copyRunning(s);
  const p = s.progress;
  if (!running && !(s.state === 'paused' && p?.toRead)) return null;
  const refresh = s.state === 'refreshing';
  const title = !running ? 'Copying stopped' : refresh ? 'Refreshing the copy' : 'Making the copy';
  const reading = p?.phase === 'reading' && p.toRead > 0;
  const fraction = reading || (!running && p?.toRead) ? Math.min(1, p!.read / p!.toRead) : p?.phase === 'done' ? 1 : null;
  let line: string;
  if (!running) line = `${fmt(p!.read)} of ${plural(p!.toRead, 'object')} read. Resume continues from there.`;
  else if (s.wait && s.wait.until > now) {
    const left = durationWords(s.wait.until - now);
    line = s.wait.kind === 'slow'
      ? `The server answers slowly. Companion waits ${left} before the next request.`
      : `Companion keeps its load on the server low. Waiting ${left}.`;
  } else if (!p || (p.phase === 'listing' && !p.listed && !p.sources)) line = refresh ? 'Asking the server what changed.' : 'Listing the server\'s code.';
  else if (p.phase === 'listing') {
    const so = p.listed ? `${plural(p.listed, 'object')} so far` : '';
    const src = p.sources && p.sources > 1 ? `place ${fmt(Math.min(p.sources, Math.max(1, p.source ?? 1)))} of ${fmt(p.sources)}` : '';
    line = `Listing the server's code${so || src ? `: ${[so, src].filter(Boolean).join(', ')}` : ''}.`;
  } else if (p.phase === 'done' || (reading && p.read >= p.toRead)) line = 'Writing the copy on this computer.';
  else if (reading) {
    const where = p.place ? ` of ${p.place}${p.sources && p.sources > 1 ? ` (${fmt(p.source ?? 1)} of ${fmt(p.sources)})` : ''}` : '';
    const size = p.chars ? ` (${charsWords(p.chars)} characters)` : '';
    line = `Reading the code${where}: ${fmt(p.read)} of ${plural(p.toRead, 'object')}${size}.`;
  } else line = 'Reading the code.';
  const facts: string[] = [];
  if (running && p?.startedAt) facts.push(durationWords(now - p.startedAt));
  if (p?.posts) facts.push(plural(p.posts, 'request'));
  const left = running ? timeLeft(s, now, mark) : null;
  if (left) facts.push(left);
  return { title, line, fraction, facts, waiting: running && !!s.wait && s.wait.until > now, running };
}

/** "about 3 min left", from this sync's own pace: only once at least 10 s
 *  and 2 % of the objects were read since `mark`, and never while waiting
 *  or source by source (the next place's size is not known). */
export function timeLeft(s: CodeIndexStatus, now: number, mark: ReadMark | null): string | null {
  const p = s.progress;
  if (!p || p.phase !== 'reading' || !p.toRead || !mark || mark.toRead !== p.toRead) return null;
  if (s.wait && s.wait.until > now) return null;
  if (p.sources && p.sources > 1 && p.place) return null;
  const done = p.read - mark.read;
  const ms = now - mark.at;
  if (ms < 10_000 || done < Math.max(1, p.toRead * 0.02)) return null;
  const rest = ((p.toRead - p.read) / done) * ms;
  if (rest < 60_000) return 'less than a minute left';
  return `about ${durationWords(Math.round(rest / 60_000) * 60_000)} left`;
}

/** What the page offers for a problem: `retry`, worded by the page (Try
 *  again, Resume or Refresh). */
export type CopyProblemAction = 'retry';

export interface CopyProblemView {
  title: string;
  sentence: string;
  /** Where the thing it is about lives. */
  where: 'server' | 'computer';
  actions: CopyProblemAction[];
  /** The retry is held back until this time (an overload cool-down). */
  retryAt?: number;
  /** The reason as it came, for Details. */
  detail?: string;
}

/** A problem in words, with what helps. */
export function copyProblemView(pr: CodeCopyProblem, now = Date.now()): CopyProblemView {
  const names = (pr.sources ?? []).join(', ');
  const detail = pr.detail ? { detail: pr.detail } : {};
  switch (pr.kind) {
    case 'overload': {
      const until = pr.until ?? now;
      const later = until > now;
      return {
        title: 'The server is overloaded',
        sentence: `The server answered like an overloaded one, so copying stopped. ${later ? `Companion sends it no background work until ${timeOfDay(until, now)}.` : 'The pause is over.'} Searches still read the server.`,
        where: 'server', actions: ['retry'], ...(later ? { retryAt: until } : {}), ...detail,
      };
    }
    case 'unavailable':
      return { title: 'No copy of this server', sentence: 'This server cannot be copied: it has no bulk read. Searches read the code from the server.', where: 'server', actions: [], ...detail };
    case 'too-large':
      return { title: 'The copy cannot be completed', sentence: `${names || 'One place'} alone holds more code than one read can hold. What was copied so far stays on this computer; searches read the server.`, where: 'server', actions: [], ...detail };
    case 'not-listed':
      return { title: 'Some code was not listed', sentence: `The server did not list the code of ${names || 'some places'}. The copy on this computer is not complete for them.`, where: 'server', actions: ['retry'], ...detail };
    case 'busy':
      return { title: 'A copy is already being made', sentence: 'Companion is making a copy of this server for another server profile. It makes one at a time per server. Try again when it is done.', where: 'computer', actions: ['retry'] };
    default:
      return { title: 'The copy could not be made', sentence: 'Copying stopped on an error. What is on this computer stays as it was.', where: 'computer', actions: ['retry'], ...detail };
  }
}

/** The note about Companion's parsed scripts in the server's memory. */
export function serverScriptsSentence(sc: NonNullable<CodeIndexStatus['serverScripts']>, now = Date.now()): string {
  const since = sc.since != null ? ` Counted since ${dateTimeText(sc.since, now)}${sc.restartSeen ? ', the last server restart Companion saw' : ''}.` : '';
  return `Companion has left about ${fmt(sc.entries)} parsed scripts (${mbPhrase(sc.bytes)}) in this server's memory, not disk space on this computer, and starts the count again by itself when it sees the server restart. Other background work that needs a new script waits; a copy you start does not.${since}`;
}
