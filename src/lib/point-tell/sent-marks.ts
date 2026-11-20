/**
 * Point and tell: marks that went to Claude. Pure: marks and the listener's rows in, answers out.
 *
 * A send carries only what is new. After a send, the marks that went out keep a `sent` record: the sketch number the
 * listener gave, their number in that sketch, the time, and a signature of what they said. They stay on the page,
 * quieter, and show their sketch's state. A mark whose words or drawing change afterwards is new again: it goes out
 * with the next send as a correction that names what it corrects ("Correction to sketch 3, mark 1").
 *
 * Numbers restart at 1 in every sketch, so the numbers Claude reads in a brief and on its picture are that sketch's.
 * A row is found again by the id the desktop extension gave the sketch (0.3.0 on). Older ones give none, and a new
 * working session there counts from 1 again: the row must then also have been made within a few minutes of the send.
 */
import { STATE_WORDS, type SketchRow, type SketchState } from '../claude-link';
import { attentionOf, type Attention, type LinkFacts } from './sent-model';
import { isPageMark } from './drafts';
import { shownNumbers } from './numbering';
import type { PtMark, PtSent, PtSketchRef } from './types';

/** What a mark says, as a short signature: its words, what it points at, what it was read as, its ink. */
export function markSig(m: Pick<PtMark, 'text' | 'targets' | 'meaning' | 'ink'>): string {
  const ink = m.ink?.strokes.map(s => {
    const a = s.points[0], b = s.points[s.points.length - 1];
    return `${s.points.length}:${Math.round(a?.[0] ?? 0)},${Math.round(a?.[1] ?? 0)}:${Math.round(b?.[0] ?? 0)},${Math.round(b?.[1] ?? 0)}`;
  }) ?? null;
  return JSON.stringify([m.text.trim(), m.targets, m.meaning?.kind ?? null, ink]);
}

/** Not sent yet, or changed since it was sent. */
export const isFresh = (m: PtMark): boolean => !m.sent || m.sent.sig !== markSig(m);
/** Sent, then changed: it goes out again as a correction. */
export const isCorrection = (m: PtMark): boolean => !!m.sent && m.sent.sig !== markSig(m);
/** Sent and unchanged since. */
export const isSent = (m: PtMark): boolean => !!m.sent && !isFresh(m);

/** The marks a send or a copy can carry: all but the one that drew a page (the page is the brief's own line). */
export const briefMarks = (marks: readonly PtMark[]): PtMark[] => marks.filter(m => !isPageMark(m));
/** What the next send carries. */
export const freshMarks = (marks: readonly PtMark[]): PtMark[] => briefMarks(marks).filter(isFresh);

/** For each correction among `marks` (by internal number): the sketch and the number it corrects. */
export function correctionsOf(marks: readonly PtMark[]): Record<number, { sketch: number; k: number }> {
  const out: Record<number, { sketch: number; k: number }> = {};
  for (const m of marks) if (m.sent && isCorrection(m)) out[m.n] = { sketch: m.sent.sketch, k: m.sent.k };
  return out;
}

/** The sketches sent from this page before, in order, each once. */
export function earlierSketches(marks: readonly PtMark[]): number[] {
  return [...new Set(marks.flatMap(m => (m.sent ? [m.sent.sketch] : [])))].sort((a, b) => a - b);
}

/** After a send: the marks that went (`went`, in brief order) carry the sketch and their number in it; an answer they had is dropped. */
export function markSent(marks: readonly PtMark[], went: readonly PtMark[], ref: PtSketchRef): PtMark[] {
  const numbers = shownNumbers(went);
  return marks.map((m) => {
    const k = numbers.get(m.n);
    if (k === undefined) return m;
    const sent: PtSent = { sketch: ref.sketch, at: ref.at, ...(ref.id ? { id: ref.id } : {}), k, sig: markSig(m) };
    return { ...m, sent };
  });
}

/** Without ids: a row is the one that was sent when its number matches and it was made within this long of the send. */
export const MATCH_MS = 5 * 60_000;

/** The listener's row for a sketch this page sent, if it is still kept. */
export function rowOf(rows: readonly SketchRow[], ref: PtSketchRef): SketchRow | undefined {
  return rows.find(r => (ref.id && r.id ? r.id === ref.id : r.number === ref.sketch && Math.abs(Date.parse(r.at) - ref.at) <= MATCH_MS));
}

/** What the page knows about the link beside the rows: the chats' facts, and whether the rows came from the listener at all. */
export interface LinkView { facts: LinkFacts; /** The rows are the listener's (it answered at least once in this page). */ listed: boolean; now?: number }

/** What a group of sent marks shows: the state of its sketch, or "answered" while the user's answer waits. */
export type MarkStatus = SketchState | 'answered' | 'unknown';

export interface GroupView {
  sketch: number;
  status: MarkStatus;
  /** Claude's words that the state goes with. */
  reply?: string;
  /** The row the state comes from (the answer's, once the answer has a state of its own). */
  row?: SketchRow;
  /** The user's answer, when there is one. */
  answer?: string;
  /** The sketch an answer would answer: the one whose question is open. */
  asks?: number;
  /** The row of that question, for its id. */
  asksRow?: SketchRow;
  /**
   * The user has to act: no chat takes sketches (`nochat`), nobody works on the taken sketch (`gone`, `stalled`), or the
   * listener no longer lists it (`unlisted`).
   */
  attention?: Attention | 'unlisted';
}

const OPEN: ReadonlySet<MarkStatus> = new Set(['queued', 'taken', 'working', 'answered']);
export const isOpenStatus = (s: MarkStatus): boolean => OPEN.has(s);

const NO_LINK: LinkView = { facts: { agent: 'recent' }, listed: false };

/** A sketch sent this recently may be missing from the rows only because they were read before it went out. */
export const JUST_SENT_MS = 15_000;

export function groupView(sent: PtSent, rows: readonly SketchRow[], link: LinkView = NO_LINK): GroupView {
  const row = rowOf(rows, sent);
  const gone = (at: number): boolean => link.listed && (link.now ?? Date.now()) - at > JUST_SENT_MS;
  const base = { sketch: sent.sketch, ...(sent.answer ? { answer: sent.answer.text } : {}) };
  const needs = (r: SketchRow): Attention | null => attentionOf(r, rows, link.facts, link.now);
  const flag = (r: SketchRow): Pick<GroupView, 'attention'> => { const a = needs(r); return a ? { attention: a } : {}; };
  const asks = (r: SketchRow): Pick<GroupView, 'asks' | 'asksRow'> => (r.state === 'question' ? { asks: r.number, asksRow: r } : {});
  if (sent.answer) {
    const ar = rowOf(rows, sent.answer);
    if (!ar || ar.state === 'queued' || ar.state === 'taken' || (ar.state === 'working' && !ar.reply)) {
      // The answer waits for Claude: whether a chat will take it is the answer's own matter.
      const wait = ar ? flag(ar) : gone(sent.answer.at) ? { attention: 'unlisted' as const } : {};
      return { ...base, status: 'answered', ...(row?.reply ? { reply: row.reply.text } : {}), ...(row ? { row } : {}), ...wait };
    }
    return { ...base, status: ar.state, row: ar, ...(ar.reply ? { reply: ar.reply.text } : {}), ...asks(ar) };
  }
  if (!row) return gone(sent.at) ? { ...base, status: 'unknown', attention: 'unlisted' as const } : { ...base, status: link.listed ? 'queued' : 'unknown' };
  return { ...base, status: row.state, row, ...(row.reply ? { reply: row.reply.text } : {}), ...asks(row), ...flag(row) };
}

/** What a state is called beside the marks. */
export const STATUS_WORDS: Record<MarkStatus, string> = { ...STATE_WORDS, answered: 'Answered', unknown: 'Sent' };

/** The state word of a group: a sketch nobody works on says so instead of "Claude has it". */
export function viewWord(v: GroupView): string {
  if (v.attention === 'stalled' && v.status !== 'answered') return 'Stopped';
  if (v.attention === 'unlisted') return 'Not listed';
  return v.row?.word ?? STATUS_WORDS[v.status];
}

/** The plain line that says why the user has to act, and the actions that go with it. */
export function attentionLine(v: GroupView, quietMin?: number): { text: string; again: boolean; clear: boolean; chat: boolean } | null {
  switch (v.attention) {
    case 'nochat': return { text: 'No chat is taking sketches.', again: false, clear: false, chat: true };
    case 'stalled': return { text: quietMin ? `Nobody is working on it. No word from Claude for ${quietMin} min.` : 'Nobody is working on it.', again: true, clear: false, chat: false };
    case 'unlisted': return { text: 'Claude Desktop no longer lists this sketch.', again: true, clear: true, chat: false };
    default: return null;
  }
}

/** The sent groups of this page, by sketch number, in the order they were sent. */
export function sentGroups(marks: readonly PtMark[], rows: readonly SketchRow[], link?: LinkView): Array<{ view: GroupView; marks: PtMark[] }> {
  const by = new Map<number, PtMark[]>();
  for (const m of marks) if (m.sent && isSent(m)) (by.get(m.sent.sketch) ?? by.set(m.sent.sketch, []).get(m.sent.sketch)!).push(m);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, ms]) => ({ view: groupView(ms[0].sent!, rows, link), marks: ms }));
}

/** The marks whose sketch is done (and that were not changed since). */
export function doneMarks(marks: readonly PtMark[], rows: readonly SketchRow[]): PtMark[] {
  return sentGroups(marks, rows).filter(g => g.view.status === 'done').flatMap(g => g.marks);
}

/** "Clear done": the marks that remain. */
export function clearDone(marks: readonly PtMark[], rows: readonly SketchRow[]): PtMark[] {
  const gone = new Set(doneMarks(marks, rows).map(m => m.n));
  return marks.filter(m => !gone.has(m.n));
}

/** The sent, unchanged marks of one sketch. */
export const marksOfSketch = (marks: readonly PtMark[], sketch: number): PtMark[] => marks.filter(m => m.sent?.sketch === sketch && isSent(m));

/** "Clear" on a sketch the listener no longer lists: its marks leave the page. */
export function clearSketch(marks: readonly PtMark[], sketch: number): PtMark[] {
  const gone = new Set(marksOfSketch(marks, sketch).map(m => m.n));
  return marks.filter(m => !gone.has(m.n));
}

/** After an answer went out: every mark of the sketch it answers carries it. */
export function markAnswered(marks: readonly PtMark[], sketch: number, answer: PtSketchRef & { text: string; asks?: number }): PtMark[] {
  return marks.map(m => (m.sent && m.sent.sketch === sketch && isSent(m) ? { ...m, sent: { ...m.sent, answer } } : m));
}

/** The rows that came back since the last look (`known`: each row's revision then), for a small sign where it shows. */
export function arrivals(rows: readonly SketchRow[], known: ReadonlyMap<number, number>): SketchRow[] {
  return rows.filter(r => !!r.reply && r.rev > (known.get(r.number) ?? 0));
}
