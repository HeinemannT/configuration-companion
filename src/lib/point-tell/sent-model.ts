/**
 * Point and tell: the list of sketches that were sent to Claude. Pure helpers over the rows the listener reports
 * (see claude-link.ts): what to call things, what is still open, what is news, whether a chat is working on them,
 * and when the browser asks again.
 *
 * The desktop extension reports facts (when a sketch was taken and by which copy, each copy's last tool call and
 * heartbeat, whether a next_sketch waits); the thresholds that turn them into "nobody is working on it" live here, so
 * they can change without a new desktop extension. Older desktop extensions report only `agent`.
 */
import { isNews, type CopyFact, type LinkAgent, type Seen, type SketchRow, type SketchState } from '../claude-link';

/** The browser asks again this often while a chat works on a sketch. */
export const POLL_MS = 4000;
/** The wait before asking again when the listener could not be reached (Claude Desktop closed). */
export const POLL_AWAY_MS = 20_000;
/** The wait before asking again while everything open waits for the user (no chat, nobody on it): a chat they start shows soon. */
export const POLL_USER_MS = 8000;
/** Nothing changed for this long: the browser stops asking until the user does something. */
export const POLL_IDLE_MS = 15 * 60_000;

/** A copy whose heartbeat is older than this is gone (it beats every 10 s). */
export const BEAT_STALE_MS = 45_000;
/** A chat that loops calls next_sketch again within one wait and one model turn. */
export const TURN_MS = 120_000;
/** No word on a taken sketch for this long (no reply, no Companion tool call): nobody is working on it. */
export const STALL_MS = 10 * 60_000;
/** next_sketch's wait when the server does not say, seconds. */
export const DEFAULT_WAIT_S = 45;

const OPEN: ReadonlySet<SketchState> = new Set(['queued', 'taken', 'working']);

/** A sketch that is still being dealt with: waiting, taken or in work. */
export const isOpen = (r: SketchRow): boolean => OPEN.has(r.state);

/** What the last status said about the chats, beside the rows. */
export interface LinkFacts {
  agent: LinkAgent;
  /** The running copies (0.3.0 on). */
  copies?: readonly CopyFact[];
  /** next_sketch's wait, seconds. */
  wait?: number;
}

const ms = (iso: string | undefined): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

/**
 * A chat is taking sketches: a next_sketch waits in a running copy now, or a chat called one within one wait and one
 * turn. Older desktop extensions: a next_sketch waits, or a tool was called in the last 10 minutes.
 */
export function chatTaking(f: LinkFacts, now = Date.now()): boolean {
  if (!f.copies) return f.agent !== 'none';
  const window = (f.wait ?? DEFAULT_WAIT_S) * 1000 + TURN_MS;
  return f.copies.some(c => (c.waiting > 0 && c.alive !== false && now - ms(c.beatAt) < BEAT_STALE_MS) || now - ms(c.lastCallAt) < window);
}

/** The last sign of work on a taken sketch: taken, a reply, or a Companion tool call of the copy that took it. */
function lastWord(r: SketchRow, f: LinkFacts): number {
  const taker = r.takenBy?.copy ? f.copies?.find(c => c.copy === r.takenBy!.copy) : undefined;
  const calls = taker ? [ms(taker.lastCallAt)] : (f.copies ?? []).map(c => ms(c.lastCallAt));
  return Math.max(ms(r.takenAt) || ms(r.at), ms(r.reply?.at), ...calls);
}

/** Why a sketch needs the user: no chat takes sketches, or nobody works on the one that was taken. Null: nothing to do. */
export type Attention = 'nochat' | 'stalled';

/**
 * - `nochat`: waiting in line, and no chat is taking sketches or working on one.
 * - `stalled`: taken, and no word from its chat for STALL_MS (no reply, no `working`, no Companion tool call).
 *   A copy that stopped is not enough: Claude Desktop restarts copies while the chat goes on, and the desktop
 *   extension itself puts a sketch whose taker is gone back in line.
 * Older desktop extensions: waiting or taken while no tool was called in 10 minutes.
 */
export function attentionOf(r: SketchRow, rows: readonly SketchRow[], f: LinkFacts, now = Date.now()): Attention | null {
  if (r.state === 'queued') {
    if (chatTaking(f, now)) return null;
    // A chat busy with another sketch comes back for this one.
    const busy = rows.some(o => (o.state === 'taken' || o.state === 'working') && attentionOf(o, rows, f, now) === null);
    return busy ? null : 'nochat';
  }
  if (r.state !== 'taken' && r.state !== 'working') return null;
  if (!f.copies) return f.agent === 'none' ? 'stalled' : null;
  return now - lastWord(r, f) > STALL_MS ? 'stalled' : null;
}

/** Minutes since the last word on a taken sketch, for "No word from Claude for 12 min". */
export function quietMinutes(r: SketchRow, f: LinkFacts, now = Date.now()): number {
  return Math.max(1, Math.round((now - lastWord(r, f)) / 60_000));
}

/** The browser keeps asking while any sketch is open. Nothing is open, nothing is asked. */
export const needsPoll = (rows: readonly SketchRow[]): boolean => rows.some(isOpen);

/**
 * When to ask again, or null: not at all. Quick while a chat works on something; slower while everything open waits for
 * the user (no chat, nobody working); slow while Claude Desktop cannot be reached; never after POLL_IDLE_MS without a change or
 * a step by the user (`quietFor`).
 */
export function pollDelay(o: { rows: readonly SketchRow[]; facts: LinkFacts; reachable: boolean; listOpen: boolean; quietFor: number; now?: number }): number | null {
  if (o.quietFor >= POLL_IDLE_MS) return null;
  const open = o.rows.filter(isOpen);
  if (!open.length && !o.listOpen) return null;
  if (!o.reachable) return POLL_AWAY_MS;
  const waitsOnUser = open.every(r => attentionOf(r, o.rows, o.facts, o.now) !== null);
  return open.length && !waitsOnUser ? POLL_MS : POLL_USER_MS;
}

/** The label on the dock: "3 sent". Null when nothing was sent (the control is not shown). */
export const sentLabel = (rows: readonly SketchRow[]): string | null => (rows.length ? `${rows.length} sent` : null);

/** Something came back that the user has not looked at. */
export const hasNews = (rows: readonly SketchRow[], seen: Seen): boolean => rows.some(r => isNews(r, seen));

/** What looking at these rows marks as seen: each one with a reply, at its current revision. */
export function seenFor(rows: readonly SketchRow[]): Seen {
  const out: Seen = {};
  for (const r of rows) if (r.reply) out[String(r.number)] = r.rev;
  return out;
}

/** The "Start working chat" control is pushed forward when a sketch waits and no chat takes sketches. */
export const chatNeeded = (f: LinkFacts, rows: readonly SketchRow[], now = Date.now()): boolean =>
  rows.some(r => attentionOf(r, rows, f, now) === 'nochat');

/** Newest first. */
export const newestFirst = (rows: readonly SketchRow[]): SketchRow[] => [...rows].sort((a, b) => b.number - a.number);

/** "now", "5 min", or the clock time for anything older than an hour. */
export function ago(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const s = Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/** The identity of a page for matching a reply to it: the address up to the object, without hash and noise. */
export function pageKeyOf(href: string, rid?: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}${rid ? `?rid=${rid}` : ''}`.slice(0, 300);
  } catch { return ''; }
}
