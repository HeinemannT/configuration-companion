/**
 * Send to Claude without dead ends: whether a chat takes sketches, a taken sketch nobody works on, a sketch no longer
 * listed, how a row is found again (by the server's id, else by number and time), when the browser stops asking,
 * and the words Companion gives the agent.
 */
import { describe, expect, it } from 'vitest';
import type { CopyFact, SketchRow } from '../../claude-link';
import { buildBrief, CROSS_NO_WORDS, INK_NO_WORDS, againLine, markLine, type BriefInput } from '../brief';
import {
  CONFIG_REV, DESKTOP_CONFIG, HANDOVER_AFTER, LOOP_RULES, PICTURE, RESULT_TEXTS, WAIT, WORKING_CHAT_OPENING, followsOf, handoverFor,
} from '../desktop-policy';
import { attentionLine, clearSketch, groupView, markSent, rowOf, viewWord } from '../sent-marks';
import { POLL_AWAY_MS, POLL_IDLE_MS, POLL_MS, POLL_USER_MS, STALL_MS, attentionOf, chatTaking, pollDelay, quietMinutes } from '../sent-model';
import { decodeMarks, encodeMarks } from '../store';
import type { PtMark } from '../types';
import { fixtureModel } from './fixture';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const row = (number: number, state: SketchRow['state'], extra: Partial<SketchRow> = {}): SketchRow =>
  ({ number, at: iso(60_000), page: 'P', pageKey: 'k', state, rev: number, ...extra });
const copy = (extra: Partial<CopyFact> = {}): CopyFact => ({ copy: 'c1', waiting: 0, beatAt: iso(3000), alive: true, ...extra });

describe('whether a chat takes sketches', () => {
  it('0.3.0: a next_sketch waits in a live copy, or a chat called within one wait and one turn', () => {
    expect(chatTaking({ agent: 'none', copies: [copy({ waiting: 1 })], wait: 45 }, NOW)).toBe(true);
    expect(chatTaking({ agent: 'none', copies: [copy({ waiting: 1, alive: false })], wait: 45 }, NOW)).toBe(false);
    expect(chatTaking({ agent: 'none', copies: [copy({ waiting: 1, beatAt: iso(120_000) })], wait: 45 }, NOW)).toBe(false);
    expect(chatTaking({ agent: 'recent', copies: [copy({ lastCallAt: iso(100_000) })], wait: 45 }, NOW)).toBe(true);
    // `agent: recent` (a call within 10 minutes) is not enough: the loop died 5 minutes ago.
    expect(chatTaking({ agent: 'recent', copies: [copy({ lastCallAt: iso(5 * 60_000) })], wait: 45 }, NOW)).toBe(false);
    expect(chatTaking({ agent: 'none', copies: [], wait: 45 }, NOW)).toBe(false);
  });

  it('older desktop extensions: a next_sketch waits or a tool was called in the last 10 minutes', () => {
    expect(chatTaking({ agent: 'waiting' }, NOW)).toBe(true);
    expect(chatTaking({ agent: 'recent' }, NOW)).toBe(true);
    expect(chatTaking({ agent: 'none' }, NOW)).toBe(false);
  });
});

describe('what needs the user', () => {
  const noChat = { agent: 'none' as const, copies: [copy()], wait: 45 };
  const looping = { agent: 'waiting' as const, copies: [copy({ waiting: 1, lastCallAt: iso(1000) })], wait: 45 };

  it('a sketch waiting in line with no chat taking sketches', () => {
    expect(attentionOf(row(1, 'queued'), [row(1, 'queued')], noChat, NOW)).toBe('nochat');
    expect(attentionOf(row(1, 'queued'), [row(1, 'queued')], looping, NOW)).toBeNull();
    // A chat busy with another sketch comes back for this one.
    const busy = [row(1, 'working', { takenAt: iso(60_000), takenBy: { copy: 'c1' } }), row(2, 'queued')];
    expect(attentionOf(busy[1], busy, noChat, NOW)).toBeNull();
  });

  it('a taken sketch with no word for STALL_MS; a reply with working or a tool call is a word', () => {
    const old = row(1, 'taken', { takenAt: iso(STALL_MS + 60_000), takenBy: { copy: 'c1' } });
    expect(attentionOf(old, [old], noChat, NOW)).toBe('stalled');
    expect(quietMinutes(old, noChat, NOW)).toBe(11);
    const fresh = row(1, 'taken', { takenAt: iso(60_000), takenBy: { copy: 'c1' } });
    expect(attentionOf(fresh, [fresh], noChat, NOW)).toBeNull();
    const working = row(1, 'working', { takenAt: iso(STALL_MS * 2), reply: { text: 'Halfway', at: iso(60_000) } });
    expect(attentionOf(working, [working], noChat, NOW)).toBeNull();
    const called = { ...noChat, copies: [copy({ lastCallAt: iso(30_000) })] };
    expect(attentionOf(old, [old], called, NOW)).toBeNull();
    // A copy restart is not a stop: the chat goes on, the taker's copy is gone, the time decides.
    const restarted = row(1, 'working', { takenAt: iso(60_000), takenBy: { copy: 'gone', alive: false } });
    expect(attentionOf(restarted, [restarted], noChat, NOW)).toBeNull();
  });

  it('older desktop extensions: taken while no tool was called in 10 minutes', () => {
    expect(attentionOf(row(1, 'taken'), [row(1, 'taken')], { agent: 'none' }, NOW)).toBe('stalled');
    expect(attentionOf(row(1, 'taken'), [row(1, 'taken')], { agent: 'recent' }, NOW)).toBeNull();
    expect(attentionOf(row(1, 'done'), [row(1, 'done')], { agent: 'none' }, NOW)).toBeNull();
  });
});

describe('when the browser asks again', () => {
  const facts = { agent: 'waiting' as const, copies: [copy({ waiting: 1 })], wait: 45 };
  it('quick while a chat works, slow while everything waits on the user, never when nothing can change', () => {
    expect(pollDelay({ rows: [row(1, 'taken', { takenAt: iso(1000) })], facts, reachable: true, listOpen: false, quietFor: 0, now: NOW })).toBe(POLL_MS);
    expect(pollDelay({ rows: [row(1, 'queued')], facts: { agent: 'none', copies: [], wait: 45 }, reachable: true, listOpen: false, quietFor: 0, now: NOW })).toBe(POLL_USER_MS);
    expect(pollDelay({ rows: [row(1, 'done')], facts, reachable: true, listOpen: false, quietFor: 0, now: NOW })).toBeNull();
    expect(pollDelay({ rows: [row(1, 'queued')], facts, reachable: false, listOpen: false, quietFor: 0, now: NOW })).toBe(POLL_AWAY_MS);
    expect(pollDelay({ rows: [], facts, reachable: true, listOpen: true, quietFor: 0, now: NOW })).toBe(POLL_USER_MS);
  });

  it('stops after POLL_IDLE_MS without a change or a step by the user', () => {
    expect(pollDelay({ rows: [row(1, 'taken', { takenAt: iso(1000) })], facts, reachable: true, listOpen: true, quietFor: POLL_IDLE_MS, now: NOW })).toBeNull();
    expect(pollDelay({ rows: [row(1, 'queued')], facts, reachable: false, listOpen: false, quietFor: POLL_IDLE_MS + 1, now: NOW })).toBeNull();
  });
});

describe('finding the row of a sent sketch', () => {
  const at = NOW - 60_000;
  it('by the server\'s id; numbers that repeat in another session do not confuse it', () => {
    const rows = [row(3, 'done', { id: 'old', at: new Date(at).toISOString() }), row(3, 'queued', { id: 'new', at: new Date(at).toISOString() })];
    expect(rowOf(rows, { sketch: 3, at, id: 'new' })?.id).toBe('new');
    expect(rowOf(rows, { sketch: 3, at, id: 'gone' })).toBeUndefined();
  });

  it('by number and time on an older server, or for a mark sent before the update', () => {
    const rows = [row(3, 'done', { at: new Date(at + 500).toISOString() })];
    expect(rowOf(rows, { sketch: 3, at, id: 'a1' })?.number).toBe(3);
    expect(rowOf([row(3, 'done', { id: 'x', at: new Date(at).toISOString() })], { sketch: 3, at })?.id).toBe('x');
    expect(rowOf(rows, { sketch: 3, at: at - 60 * 60_000 })).toBeUndefined();
  });

  it('marks keep the id through the page\'s store', () => {
    const marks: PtMark[] = [{ n: 1, text: 'Bigger', targets: ['txt_info'], at: 1 }];
    const sent = markSent(marks, marks, { sketch: 7, at, id: 'a1b2c3d4e5f60718' });
    expect(sent[0].sent).toMatchObject({ sketch: 7, k: 1, id: 'a1b2c3d4e5f60718' });
    expect(decodeMarks(encodeMarks({ marks: sent, next: 2 })).marks[0].sent?.id).toBe('a1b2c3d4e5f60718');
  });
});

describe('the state at the marks', () => {
  const at = NOW - 60_000;
  const marks = markSent([{ n: 1, text: 'Bigger', targets: ['txt_info'], at: 1 }], [{ n: 1, text: 'Bigger', targets: ['txt_info'], at: 1 }], { sketch: 4, at, id: 'a4' });
  const ref = marks[0].sent!;
  const facts = { agent: 'none' as const, copies: [copy()], wait: 45 };

  it('no chat: says so and offers Start working chat, not a false "sent"', () => {
    const v = groupView(ref, [row(4, 'queued', { id: 'a4' })], { facts, listed: true, now: NOW });
    expect(v.attention).toBe('nochat');
    expect(viewWord(v)).toBe('Waiting for Claude');
    expect(attentionLine(v)).toEqual({ text: 'No chat is taking sketches.', again: false, clear: false, chat: true });
  });

  it('nobody working on it: Stopped, and Send again', () => {
    const v = groupView(ref, [row(4, 'taken', { id: 'a4', takenAt: iso(STALL_MS * 2) })], { facts, listed: true, now: NOW });
    expect(v.attention).toBe('stalled');
    expect(viewWord(v)).toBe('Stopped');
    expect(attentionLine(v, 20)).toEqual({ text: 'Nobody is working on it. No word from Claude for 20 min.', again: true, clear: false, chat: false });
  });

  it('no longer listed: Send again or Clear; before the first answer it is only "Sent"', () => {
    const v = groupView(ref, [], { facts, listed: true, now: NOW });
    expect(v).toMatchObject({ status: 'unknown', attention: 'unlisted' });
    expect(viewWord(v)).toBe('Not listed');
    expect(attentionLine(v)).toMatchObject({ text: 'Claude Desktop no longer lists this sketch.', again: true, clear: true });
    const before = groupView(ref, [], { facts, listed: false, now: NOW });
    expect(before.attention).toBeUndefined();
    expect(viewWord(before)).toBe('Sent');
    expect(clearSketch(marks, 4)).toEqual([]);
  });

  it('a settings state shows its own word', () => {
    expect(viewWord(groupView(ref, [row(4, 'working', { id: 'a4', word: 'Waiting for review', takenAt: iso(1000) })], { facts: { ...facts, copies: [copy({ lastCallAt: iso(1000) })] }, listed: true, now: NOW }))).toBe('Waiting for review');
  });
});

describe('the brief: no delete without words', () => {
  const base = (marks: PtMark[]): BriefInput => ({ model: fixtureModel(), marks, liveTabId: 'tab_overview' });
  const ctx = { model: fixtureModel(), liveTabId: 'tab_overview' };
  it('a cross with no words asks before deleting; with words the words count', () => {
    const cross: PtMark = { n: 1, text: '', targets: ['btn_export'], meaning: { kind: 'crossed' }, at: 1 };
    expect(markLine(cross, ctx).text).toContain(CROSS_NO_WORDS);
    expect(CROSS_NO_WORDS).toBe('The user did not say what to do with it: ask before deleting.');
    expect(markLine({ ...cross, text: 'Remove it' }, ctx).text).not.toContain(CROSS_NO_WORDS);
  });

  it('freehand ink with no words asks before changing anything', () => {
    const ink: PtMark = { n: 1, text: '', targets: ['btn_export'], ink: { strokes: [{ points: [[0, 0], [10, 10]] }], place: {} }, at: 1 };
    expect(markLine(ink, ctx).text).toContain(INK_NO_WORDS);
  });

  it('Send again says the marks went before and to check what is done', () => {
    const text = buildBrief({ ...base([{ n: 1, text: 'Bigger', targets: ['txt_info'], at: 1 }]), again: 4 });
    expect(text).toContain(againLine(4));
    expect(againLine(4)).toBe('Sent again: sketch 4 got no reply and nobody is working on it. Check in BMP what is already done before you change anything.');
  });
});

describe('what Companion tells the agent', () => {
  it('the hand-over after every brief: what to do, how to reply, the loop', () => {
    const h = handoverFor();
    expect(h).toEqual({ after: HANDOVER_AFTER });
    expect(HANDOVER_AFTER).toContain('call reply with status done');
    expect(HANDOVER_AFTER).toContain('status question');
    expect(HANDOVER_AFTER).toContain('status cannot');
    expect(HANDOVER_AFTER).toContain(LOOP_RULES);
    expect(HANDOVER_AFTER.length).toBeLessThanOrEqual(1000);
  });

  it('an answer and corrections say what they belong to in structure (the desktop extension adds the earlier sketch)', () => {
    expect(followsOf({ id: 'a3', number: 3 })).toEqual({ answers: 'a3' });
    expect(followsOf({ number: 3 })).toEqual({ answers: 3 });
    expect(followsOf(undefined, [{ id: 'a2', number: 2, marks: [1, 3] }, { number: 5, marks: [2] }])).toEqual({ corrects: [{ sketch: 'a2', marks: [1, 3] }, { sketch: 5, marks: [2] }] });
    expect(followsOf()).toBeUndefined();
  });

  it('the settings fit the desktop extension\'s bounds (PROTOCOL.md) and carry a revision', () => {
    expect(DESKTOP_CONFIG.rev).toBe(CONFIG_REV);
    expect(Number.isSafeInteger(CONFIG_REV) && CONFIG_REV >= 1).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(DESKTOP_CONFIG)).length).toBeLessThan(16 * 1024);
    for (const t of Object.values(RESULT_TEXTS)) {
      expect(t.length).toBeLessThanOrEqual(1000);
      expect([...t].some(ch => ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\t')).toBe(false);
    }
    expect(Object.keys(RESULT_TEXTS).sort()).toEqual(['afterDone', 'afterQuestion', 'afterSketch', 'afterWorking', 'drawnNote', 'handedBefore', 'intro', 'nothingYet', 'pictureNote']);
    expect(WAIT.default).toBeGreaterThanOrEqual(10);
    expect(WAIT.default).toBeLessThan(60);
    for (const c of WAIT.byClient) expect(c.match).toMatch(/^[A-Za-z0-9 ._*-]{1,60}$/);
    expect(DESKTOP_CONFIG.config).toMatchObject({ limits: { keep: 30, keepDays: 7, replyChars: 4000, sessionHours: 12, takenMinutes: 20 } });
  });

  it('the opening of a working chat carries the loop policy', () => {
    expect(WORKING_CHAT_OPENING).toContain(LOOP_RULES);
    // The desktop extension adds the next step after each text: the texts do not say it again.
    expect(RESULT_TEXTS.nothingYet).not.toMatch(/call next_sketch/i);
    expect(RESULT_TEXTS.afterDone).toBe('Recorded.');
  });

  it('the picture cap is one constant', () => {
    expect(PICTURE).toEqual({ maxEdge: 1568, maxPngBytes: 900_000 });
  });
});
