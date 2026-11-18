/**
 * Log tab model: filters, day groups, repeat collapsing and export formats.
 * Pure functions over the ActivityEntry records the worker already keeps.
 */
import { SCRIPT_PAUSE_ACTION, SCRIPT_RESUME_ACTION, type ActivityEntry } from '../../lib/types';
import { isUserWork, tidyMessage } from '../../lib/activity-policy';
import { operationPhrases } from '../../lib/transport-activity';

export type EventFilter = 'activity' | 'problems' | 'all';
export type ScopeFilter = 'this' | 'all';

/** Rows shown at most; the footer says "Latest N of M" when more match. */
export const LOG_DISPLAY_CAP = 50;

export interface FilterOptions {
  event: EventFilter;
  scope: ScopeFilter;
  activeProfileId: string;
  profileCount: number;
}

/** An open warning or failure (one whose condition ended no longer counts). */
export function isProblem(entry: ActivityEntry): boolean {
  return (entry.level === 'warn' || entry.level === 'error') && entry.endedAt == null;
}

/** Older pause and resume lines were written without their action. */
export const isScriptPause = (e: ActivityEntry) =>
  e.action === SCRIPT_PAUSE_ACTION || (!e.action && e.message.startsWith('Background work paused:'));
export const isScriptResume = (e: ActivityEntry) =>
  e.action === SCRIPT_RESUME_ACTION || (!e.action && e.message.startsWith('Background work resumed:'));

/** Untagged (legacy) entries belong to every server. */
const sameServer = (a: ActivityEntry, b: ActivityEntry) => !a.profileId || !b.profileId || a.profileId === b.profileId;

/** Each script pause gets `endedAt`: the time of the first resume line of the
 *  same server after it. Every pause before a resume ends, also a merged
 *  repeat (one entry, its latest time) and a line from an earlier build. A
 *  pause with no later resume stays open. */
export function markEndedPauses(entries: readonly ActivityEntry[]): ActivityEntry[] {
  const resumes = entries.filter(isScriptResume);
  return entries.map(e => {
    if (!isScriptPause(e)) return e;
    let end: number | undefined;
    for (const r of resumes) {
      if (!sameServer(r, e)) continue;
      if (r.time < e.time || (r.time === e.time && r.id < e.id)) continue;
      if (end === undefined || r.time < end) end = r.time;
    }
    if (end === e.endedAt) return e;
    const { endedAt: _drop, ...rest } = e;
    return end === undefined ? rest : { ...rest, endedAt: end };
  });
}

/** User work, not detection or enrichment chatter. Errors always count. */
export function isActivity(entry: ActivityEntry): boolean {
  return isUserWork(entry);
}

/** Older wording the worker no longer writes, mapped to the current sentence. */
const LEGACY: [RegExp, (m: RegExpExecArray) => Partial<ActivityEntry>][] = [
  [/^Detection: BMP page \((\d+)%\)$/, () => ({ message: 'Found a BMP page', level: 'info', category: 'system' })],
  [/^Detection: not BMP \((\d+)%\)$/, () => ({ message: 'This page is not BMP', level: 'info', category: 'system' })],
  [/^Injecting content script/, () => ({ message: 'Connecting to the page…', category: 'system' })],
  [/^Injecting Blueprint editor/, () => ({ message: 'Loading the Blueprint editor…', category: 'system' })],
  [/^Content script connected$/, () => ({ message: 'Companion ready on this page', category: 'system' })],
  [/^Context: (.+)$/, m => ({ message: `Current object: ${m[1]}`, category: 'system' })],
  [/^Enrichment cancelled \(profile changed\)$/, () => ({ message: 'Stopped naming the page badges: the server profile changed' })],
  [/^Enrichment skipped: not connected$/, () => ({ message: 'Page badges not named: not connected' })],
  [/^Enrichment skipped: server unreachable$/, () => ({ message: 'Page badges not named: the server cannot be reached' })],
  [/^Refreshing badge enrichment/, () => ({ message: 'Refreshing the page badges…' })],
  [/^Inspect mode (ON|OFF)$/, m => ({ message: m[1] === 'ON' ? 'Turned Inspect on' : 'Turned Inspect off' })],
  [/^Blueprint mode (ON|OFF)$/, m => ({ message: m[1] === 'ON' ? 'Turned Blueprint on' : 'Turned Blueprint off' })],
  [/^Testing command connection/, () => ({ message: 'Checking the connection…', category: 'system' })],
  [/^Connection test passed for (.+)$/, m => ({ message: `Connected to ${m[1]}`, category: 'connection' })],
  [/^Connection failed$/, () => ({ message: 'Connection check failed', category: 'connection' })],
  [/^Connection problem detected$/, () => ({ message: 'Lost the connection to the server', category: 'connection' })],
  [/^BMP (?:\S+ · )?(\S+) completed (?:under load|after retry)$/, m => ({ message: operationPhrases(m[1]).done, level: 'info', category: 'system' })],
  [/^BMP (?:\S+ · )?(\S+) failed \((\w+)\)$/, m => ({ message: `${operationPhrases(m[1]).failed} (${m[2]})`, category: 'system' })],
];

/** The entry as the Log shows it: current wording, the duration in its column. */
export function readableEntry(entry: ActivityEntry): ActivityEntry {
  let next: ActivityEntry = entry;
  for (const [re, map] of LEGACY) {
    const m = re.exec(entry.message);
    if (m) { next = { ...entry, ...map(m) }; break; }
  }
  const tidy = tidyMessage(next.message, next);
  if (tidy.message !== next.message || (tidy.durationMs !== undefined && next.durationMs === undefined)) {
    next = { ...next, message: tidy.message, ...(tidy.durationMs !== undefined ? { durationMs: tidy.durationMs } : {}) };
  }
  if (next.durationMs === undefined && next.detail) {
    const run = /\brun (\d+)\s?ms\b/.exec(next.detail);
    if (run) next = { ...next, durationMs: Number(run[1]) };
  }
  return next;
}

/** Entries of this server. Untagged (legacy) entries belong to every server. */
export function inScope(entries: readonly ActivityEntry[], opts: Pick<FilterOptions, 'scope' | 'activeProfileId' | 'profileCount'>): ActivityEntry[] {
  if (opts.scope === 'all' || opts.profileCount <= 1) return [...entries];
  return entries.filter(e => !e.profileId || e.profileId === opts.activeProfileId);
}

/** Which of the three views lists an entry:
 *  - All: every entry.
 *  - Problems: warnings and errors, open or ended. An ended one is shown as
 *    ended and is not counted (isProblem).
 *  - Activity: user work (any error included), and the information that a
 *    problem ended, such as "Background work resumed". */
export function inView(entry: ActivityEntry, event: EventFilter): boolean {
  switch (event) {
    case 'all': return true;
    case 'problems': return entry.level === 'warn' || entry.level === 'error';
    case 'activity': return isActivity(entry) || isScriptResume(entry);
  }
}

export function filterEntries(entries: readonly ActivityEntry[], opts: FilterOptions): ActivityEntry[] {
  return inScope(entries, opts).filter(e => inView(e, opts.event));
}

export function problemCount(entries: readonly ActivityEntry[], opts: Pick<FilterOptions, 'scope' | 'activeProfileId' | 'profileCount'>): number {
  return inScope(entries, opts).filter(isProblem).length;
}

export function errorCount(entries: readonly ActivityEntry[], opts: Pick<FilterOptions, 'scope' | 'activeProfileId' | 'profileCount'>): number {
  return inScope(entries, opts).filter(e => e.level === 'error').length;
}

export interface LogRow { entry: ActivityEntry; count: number }

/** Merge runs of identical consecutive messages (oldest first in, newest first out). */
export function collapseRuns(chronological: readonly ActivityEntry[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const e of chronological) {
    const last = rows[rows.length - 1];
    const n = e.count ?? 1;
    if (last && last.entry.level === e.level && last.entry.message === e.message && !e.detail && !last.entry.detail
      && (last.entry.endedAt == null) === (e.endedAt == null)) {
      last.count += n;
      last.entry = e;
    } else {
      rows.push({ entry: e, count: n });
    }
  }
  return rows.reverse();
}

export interface DayGroup { key: string; label: string; rows: LogRow[] }

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayLabel(t: number, now: number): string {
  const key = dayKey(t);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Rows (newest first) grouped by calendar day. */
export function groupByDay(rows: readonly LogRow[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const key = dayKey(row.entry.time);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(row.entry.time, now), rows: [] };
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 24-hour clock time, HH:MM:SS. */
export function clockTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const LEVEL_WORD: Record<ActivityEntry['level'], string> = {
  success: 'Succeeded', error: 'Failed', warn: 'Warning', info: 'Info',
};

const CATEGORY_WORD: Record<NonNullable<ActivityEntry['category']>, string> = {
  execution: 'Run', change: 'Change', blueprint: 'Blueprint', studio: 'Studio', connection: 'Connection', system: 'System',
};

/** The technical line above an expanded entry's detail. */
export function metaLine(entry: ActivityEntry, profileLabel: (id: string) => string | undefined): string {
  const bits: string[] = [];
  if (entry.category) bits.push(CATEGORY_WORD[entry.category]);
  if (entry.object?.businessId || entry.object?.rid) {
    bits.push(entry.object.businessId ? `ID ${entry.object.businessId}` : `RID ${entry.object.rid}`);
  }
  if (entry.commandActor) {
    const source = entry.commandAuthSource === 'stored-login' ? 'stored login' : 'browser login';
    bits.push(`as ${entry.commandActor} (${source})`);
  }
  const server = entry.profileId ? profileLabel(entry.profileId) : undefined;
  if (server) bits.push(server);
  return bits.join(' · ');
}

function isoLocal(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(t)}`;
}

/** One entry as plain text: a header line, then the detail indented. */
export function entryText(entry: ActivityEntry, profileLabel: (id: string) => string | undefined = () => undefined): string {
  const duration = formatDuration(entry.durationMs);
  const head = `${isoLocal(entry.time)}  ${LEVEL_WORD[entry.level]}  ${entry.message}${duration ? `  (${duration})` : ''}`;
  const meta = metaLine(entry, profileLabel);
  const lines = [head, ...(meta ? [`  ${meta}`] : [])];
  if (entry.detail) lines.push(...detailLines(entry.detail).map(l => `  ${l}`));
  return lines.join('\n');
}

/** A one-line technical detail ("a · b · c") reads better one item per line. */
export function detailLines(detail: string): string[] {
  if (detail.includes('\n')) return detail.split('\n');
  return detail.includes(' · ') ? detail.split(' · ') : [detail];
}

/** Entries oldest first as plain text. */
export function entriesText(entries: readonly ActivityEntry[], profileLabel?: (id: string) => string | undefined): string {
  return [...entries].sort((a, b) => a.time - b.time).map(e => entryText(e, profileLabel)).join('\n\n');
}

/** Entries oldest first as JSON, in the stored record format. */
export function entriesJson(entries: readonly ActivityEntry[]): string {
  return JSON.stringify([...entries].sort((a, b) => a.time - b.time), null, 2);
}

export function exportFileName(now: number): string {
  const d = new Date(now);
  return `companion-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}
