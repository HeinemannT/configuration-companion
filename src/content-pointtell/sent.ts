/**
 * Point and tell: what was sent to Claude and what came back. The listener in Claude Desktop keeps the working
 * session; this side asks it (through the worker, one short loopback socket each time) and only while a sketch is
 * still open or the user opens the list. Nothing is asked when nothing is pending, and asking stops after a quarter of
 * an hour without a change until the user does something again. The rows live here, not in `pt`, so they survive
 * turning the mode off and on within the page.
 */
import { sendRequest } from '../lib/messaging';
import { isNews, type Seen, type SketchRow, type StatusResult } from '../lib/claude-link';
import { workingChatLink } from '../lib/point-tell/desktop-policy';
import { hasNews, pageKeyOf, pollDelay, seenFor, type LinkFacts } from '../lib/point-tell/sent-model';
import { MATCH_MS, arrivals, type LinkView } from '../lib/point-tell/sent-marks';
import type { InspectorMessage } from '../lib/types';
import { pt } from './state';

type StatusData = Extract<InspectorMessage, { type: 'POINT_TELL_STATUS_DATA' }>;

export interface SentState {
  rows: SketchRow[];
  facts: LinkFacts;
  /** The listener answered the last time we asked. */
  reachable: boolean;
  /** The listener answered at least once in this page: the rows are its list (a sketch missing from it is gone). */
  listed: boolean;
  /** What the copy that answered can do (empty before 0.3.0). */
  caps: string[];
  /** The replies the user has looked at, per sketch. */
  seen: Seen;
}

export const sent: SentState = { rows: [], facts: { agent: 'none' }, reachable: true, listed: false, caps: [], seen: {} };

/** The rows with what the page knows about the chats, for the views. */
export const linkView = (now = Date.now()): LinkView => ({ facts: sent.facts, listed: sent.listed && sent.reachable, now });

let timer: ReturnType<typeof setTimeout> | null = null;
let hooks: { render: () => void; arrived: (rows: SketchRow[]) => void } = { render: () => undefined, arrived: () => undefined };
/** Each row's revision when it was last seen here (not "read"): what is newer has just come back. */
const known = new Map<string, number>();
/** When the rows or the facts last changed, or the user last did something with them. */
let lastMove = Date.now();
let lastSig = '';

const rowKey = (r: SketchRow): string => r.id ?? `${r.number}@${r.at}`;

/** The identity of the page shown, to match replies to it. */
export const pageKeyNow = (): string => pageKeyOf(window.location.href, pt.rid);

export const wireSent = (h: { render: () => void; arrived?: (rows: SketchRow[]) => void }): void => { hooks = { arrived: () => undefined, ...h }; };

export const news = (): boolean => hasNews(sent.rows, sent.seen);

/** The user did something with the sent sketches: asking starts again. */
export function userMoved(): void { lastMove = Date.now(); }

/** Take what the listener said. Keeps the last rows when it could not be reached. Returns the rows that just came back. */
export function applyStatus(res: StatusResult, seen: Seen): SketchRow[] {
  for (const [k, v] of Object.entries(seen)) if (v > (sent.seen[k] ?? 0)) sent.seen[k] = v;
  if (!res.ok) {
    if (sent.reachable) lastMove = Date.now();
    sent.reachable = false;
    return [];
  }
  sent.rows = res.sketches;
  sent.facts = { agent: res.agent, ...(res.copies ? { copies: res.copies } : {}), ...(res.wait ? { wait: res.wait } : {}) };
  sent.caps = res.caps ?? [];
  sent.reachable = true;
  sent.listed = true;
  // A change is a new revision or a chat starting or stopping, not the clock of a heartbeat.
  const sig = JSON.stringify([res.rev, res.sketches.map(r => [rowKey(r), r.rev, r.state]), res.agent, (res.copies ?? []).map(c => c.waiting > 0)]);
  if (sig !== lastSig) { lastSig = sig; lastMove = Date.now(); }
  // The first answer in this page: what came back before and is unread counts as just arrived. After that, what is newer than last time.
  const came = known.size === 0 ? res.sketches.filter(r => isNews(r, sent.seen)) : arrivalsByKey(res.sketches);
  for (const r of res.sketches) known.set(rowKey(r), r.rev);
  return came;
}

function arrivalsByKey(rows: readonly SketchRow[]): SketchRow[] {
  const byNumber = new Map<number, number>();
  for (const r of rows) byNumber.set(r.number, known.get(rowKey(r)) ?? 0);
  return arrivals(rows, byNumber);
}

/** Ask the listener now (after a send, on entering, while something is open). */
export async function refreshSent(seen?: Seen): Promise<void> {
  const gen = pt.gen;
  const res = await sendRequest<StatusData>({ type: 'POINT_TELL_STATUS', ...(seen !== undefined ? { seen } : {}) });
  if (!pt.active || pt.gen !== gen) return;
  let came: SketchRow[] = [];
  if (res?.result) came = applyStatus(res.result, res.seen ?? {});
  else sent.reachable = false;
  if (pt.sentOpen) markSeen();
  schedule();
  hooks.render();
  if (came.length) hooks.arrived(came);
}

/** The user opened the list: everything in it counts as read. */
export function openedByUser(): void { userMoved(); markSeen(); void refreshSent(); }

/** The user looks at these rows (all of them by default): what came back counts as read. */
export function markSeen(rows: readonly SketchRow[] = sent.rows): void {
  const mark = seenFor(rows);
  const fresh = Object.entries(mark).filter(([k, v]) => v > (sent.seen[k] ?? 0));
  if (!fresh.length) return;
  for (const [k, v] of fresh) sent.seen[k] = v;
  void sendRequest<StatusData>({ type: 'POINT_TELL_STATUS', seen: Object.fromEntries(fresh) });
}

/** One look at the listener, when the mode opens. */
export async function lookOnEntry(): Promise<void> {
  userMoved();
  await refreshSent();
}

function schedule(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pt.active) return;
  const wait = pollDelay({ rows: sent.rows, facts: sent.facts, reachable: sent.reachable, listOpen: pt.sentOpen, quietFor: Date.now() - lastMove });
  if (wait === null) return;
  timer = setTimeout(() => { timer = null; void refreshSent(); }, wait);
}

/** The mode was left: stop asking. */
export function stopSent(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** Open the Claude Desktop page (claude-setup/) in a tab: get the desktop extension, install it, start a chat. */
export function openClaudeSetup(): void {
  void sendRequest({ type: 'OPEN_CLAUDE_SETUP' });
}

/** Open Claude Desktop's new-chat link with the opening instruction filled in. The browser asks the user first. */
export function startWorkingChat(): void {
  userMoved();
  const a = document.createElement('a');
  a.href = workingChatLink();
  a.style.display = 'none';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  // The chat needs a moment to start and call next_sketch: look again then.
  window.setTimeout(() => { if (pt.active) void refreshSent(); }, 8000);
}

// ── Answers given in place ──────────────────────────────────────────────────────────────────────
// Older listeners do not know that a sketch is an answer; this tab remembers it, so the list can say so.

const ANSWERS_KEY = 'crev_pt_answers';
type AnswerRecord = Record<string, { asks: number; at: number; id?: string }>;

function readAnswers(): AnswerRecord {
  try {
    const j = JSON.parse(sessionStorage.getItem(ANSWERS_KEY) ?? '{}') as unknown;
    return j && typeof j === 'object' ? (j as AnswerRecord) : {};
  } catch { return {}; }
}

/** Sketch `number` (sent at `at`, with the server's `id` when it gave one) answers the question of sketch `asks`. */
export function rememberAnswer(number: number, asks: number, at: number, id?: string): void {
  try { sessionStorage.setItem(ANSWERS_KEY, JSON.stringify({ ...readAnswers(), [number]: { asks, at, ...(id ? { id } : {}) } })); } catch { /* the list then shows it as a plain sketch */ }
}

/** The sketch this row answers, when it is an answer given in this tab. */
export function answers(r: SketchRow): number | undefined {
  const a = readAnswers()[String(r.number)];
  if (!a || typeof a.asks !== 'number') return undefined;
  return (a.id && r.id ? a.id === r.id : Math.abs(Date.parse(r.at) - a.at) <= MATCH_MS) ? a.asks : undefined;
}

/** Whether the question of this row was answered from this tab. */
export function answered(r: SketchRow): boolean {
  return sent.rows.some(o => o.number !== r.number && answers(o) === r.number && Date.parse(o.at) >= Date.parse(r.at));
}
