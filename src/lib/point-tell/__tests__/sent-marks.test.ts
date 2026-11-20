import { describe, expect, it } from 'vitest';
import type { SketchRow } from '../../claude-link';
import { buildAnswer, buildBrief, type BriefInput } from '../brief';
import {
  STATUS_WORDS, arrivals, clearDone, correctionsOf, doneMarks, earlierSketches, freshMarks, groupView, isCorrection, isFresh, isSent,
  markAnswered, markSent, rowOf, sentGroups,
} from '../sent-marks';
import { decodeMarks, encodeMarks } from '../store';
import type { PtMark } from '../types';
import { fixtureModel } from './fixture';

const T0 = Date.parse('2026-11-20T10:00:00Z');
const m = (n: number, extra: Partial<PtMark>): PtMark => ({ n, text: '', targets: [], at: n, ...extra });
const row = (number: number, state: SketchRow['state'], extra: Partial<SketchRow> = {}): SketchRow => ({
  number, at: new Date(T0 + 1000).toISOString(), page: 'Operational Risk', pageKey: 'k', state, rev: number * 10, ...extra,
});
const base = (marks: PtMark[], extra: Partial<BriefInput> = {}): BriefInput => ({ model: fixtureModel(), marks, liveTabId: 'tab_overview', ...extra });

/** Two marks sent as sketch 3. */
function afterFirstSend(): PtMark[] {
  const marks = [m(1, { text: 'Make this title bigger', targets: ['txt_info'] }), m(2, { text: 'Blue', targets: ['btn_export'] })];
  return markSent(marks, marks, { sketch: 3, at: T0 });
}

describe('what a send carries', () => {
  it('marks that went out are sent, numbered in their sketch, and are not new any more', () => {
    const marks = afterFirstSend();
    expect(marks.map(x => [x.sent?.sketch, x.sent?.k])).toEqual([[3, 1], [3, 2]]);
    expect(marks.every(isSent)).toBe(true);
    expect(freshMarks(marks)).toEqual([]);
  });

  it('a mark added after a send is the only one the next send carries, and it is mark 1 of its sketch', () => {
    const marks = [...afterFirstSend(), m(3, { text: 'Add a filter', targets: ['tbl_open_risks'] })];
    const fresh = freshMarks(marks);
    expect(fresh.map(x => x.n)).toEqual([3]);
    const text = buildBrief(base(fresh, { corrections: correctionsOf(fresh), earlier: earlierSketches(marks) }));
    expect(text).toContain('1. Comment on "Open risks" (ExtendedTable, tbl_open_risks). The user says: "Add a filter"');
    expect(text).not.toContain('Make this title bigger');
    expect(text).not.toContain('Blue');
    expect(text).toContain('Marks from sketch 3 are still on this page. They are not repeated here and need no action, unless a mark below corrects one. The numbers below start at 1.');
    // Sent again: it is mark 1 of sketch 4, and the older ones keep their own sketch.
    const again = markSent(marks, fresh, { sketch: 4, at: T0 + 60_000 });
    expect(again.map(x => `${x.sent?.sketch}.${x.sent?.k}`)).toEqual(['3.1', '3.2', '4.1']);
  });

  it('changing the words of a sent mark makes it new again, as a correction that names what it corrects', () => {
    const marks = afterFirstSend().map(x => (x.n === 2 ? { ...x, text: 'Dark blue, not light' } : x));
    expect(isCorrection(marks[1])).toBe(true);
    expect(isFresh(marks[1])).toBe(true);
    expect(isSent(marks[0])).toBe(true);
    const fresh = freshMarks(marks);
    const text = buildBrief(base(fresh, { corrections: correctionsOf(fresh), earlier: earlierSketches(marks) }));
    expect(text).toContain('1. Correction to sketch 3, mark 2. Comment on button "Export" (ActionButton, btn_export). The user says: "Dark blue, not light"');
    // Putting the words back as they were makes it sent again.
    const back = marks.map(x => (x.n === 2 ? { ...x, text: 'Blue' } : x));
    expect(freshMarks(back)).toEqual([]);
  });

  it('a changed drawing is a change too; spaces around the words are not', () => {
    const [a] = markSent([m(1, { targets: ['txt_info'], ink: { strokes: [{ points: [[0, 0], [10, 10]] }], place: {} } })], [m(1, { targets: ['txt_info'] })], { sketch: 1, at: T0 });
    expect(isSent(a)).toBe(true);
    expect(isFresh({ ...a, ink: { strokes: [{ points: [[0, 0], [10, 10]] }, { points: [[5, 5], [40, 40]] }], place: {} } })).toBe(true);
    expect(isFresh({ ...a, text: '  ' })).toBe(false);
  });

  it('a page note and a mark that drew a page: the page mark never goes out as a line', () => {
    const page = m(1, { text: 'Vendor review', meaning: { kind: 'add', page: true, place: { into: 'draft:page' } } });
    expect(freshMarks([page, m(2, { text: 'tighter' })]).map(x => x.n)).toEqual([2]);
  });

  it('several sketches from one page are named in order, once each', () => {
    const marks = [...afterFirstSend(), ...markSent([m(3, { text: 'x' })], [m(3, { text: 'x' })], { sketch: 5, at: T0 })];
    expect(earlierSketches(marks)).toEqual([3, 5]);
    expect(buildBrief(base([m(9, { text: 'y' })], { earlier: [3, 5] }))).toContain('Marks from sketches 3 and 5 are still on this page.');
  });
});

describe('what the marks show', () => {
  it('finds its row by number and by time, so a new session counting from 1 again is not taken for it', () => {
    const ref = { sketch: 3, at: T0 };
    expect(rowOf([row(3, 'done')], ref)?.state).toBe('done');
    expect(rowOf([row(3, 'done', { at: new Date(T0 + 3 * 3600_000).toISOString() })], ref)).toBeUndefined();
    expect(rowOf([row(4, 'done')], ref)).toBeUndefined();
  });

  it('maps each state, with Claude\'s words', () => {
    const [a] = afterFirstSend();
    const v = (r: SketchRow[]) => groupView(a.sent!, r);
    expect(v([]).status).toBe('unknown');
    expect(v([row(3, 'queued')]).status).toBe('queued');
    expect(v([row(3, 'working', { reply: { text: 'On it', at: '' } })])).toMatchObject({ status: 'working', reply: 'On it' });
    expect(v([row(3, 'done', { reply: { text: 'Made it 18 px.', at: '' } })])).toMatchObject({ status: 'done', reply: 'Made it 18 px.' });
    expect(v([row(3, 'question', { reply: { text: 'Which tab?', at: '' } })])).toMatchObject({ status: 'question', asks: 3 });
    expect(v([row(3, 'cannot', { reply: { text: 'No access.', at: '' } })]).status).toBe('cannot');
    expect(STATUS_WORDS.answered).toBe('Answered');
    expect(STATUS_WORDS.queued).toBe('Waiting for Claude');
  });

  it('an answer: "Answered" while it waits, then the reply to the answer shows on the same marks', () => {
    const asked = [row(3, 'question', { reply: { text: 'Which tab, Overview or Details?', at: '' } })];
    const marks = markAnswered(afterFirstSend(), 3, { sketch: 7, at: T0 + 5000, text: 'Overview' });
    expect(marks.every(x => x.sent?.answer?.sketch === 7)).toBe(true);
    expect(isSent(marks[0])).toBe(true);
    const waiting = groupView(marks[0].sent!, [...asked, row(7, 'queued')]);
    expect(waiting).toMatchObject({ status: 'answered', answer: 'Overview', reply: 'Which tab, Overview or Details?' });
    const done = groupView(marks[0].sent!, [...asked, row(7, 'done', { reply: { text: 'Moved it to Overview.', at: '' } })]);
    expect(done).toMatchObject({ status: 'done', reply: 'Moved it to Overview.', sketch: 3 });
    // A question about the answer is answered with the answer's number.
    const again = groupView(marks[0].sent!, [...asked, row(7, 'question', { reply: { text: 'Above or below?', at: '' } })]);
    expect(again).toMatchObject({ status: 'question', asks: 7 });
  });

  it('the answer text names the sketch and the page, nothing else', () => {
    const text = buildAnswer({ model: fixtureModel(), liveTabId: 'tab_overview', server: { name: 'Steadfast DEV', address: 'https://bmp.example.test/x/?rid=1' } }, 4, ' Put it on  "Overview" ');
    expect(text).toBe('Answer to sketch 4: "Put it on \\"Overview\\""\n\nPage: "Operational Risk" (Scorecard, ID sc_op_risk), tab "Overview"\nServer: Steadfast DEV, https://bmp.example.test/x/?rid=1\n');
  });

  it('groups sent marks by sketch; a corrected mark leaves its group', () => {
    const marks = [...afterFirstSend().map(x => (x.n === 2 ? { ...x, text: 'changed' } : x)), ...markSent([m(3, { text: 'x' })], [m(3, { text: 'x' })], { sketch: 5, at: T0 })];
    const groups = sentGroups(marks, [row(3, 'done'), row(5, 'queued')]);
    expect(groups.map(g => [g.view.sketch, g.marks.map(x => x.n)])).toEqual([[3, [1]], [5, [3]]]);
  });

  it('Clear done takes only the marks of done sketches, and keeps new and changed ones', () => {
    const marks = [...afterFirstSend().map(x => (x.n === 2 ? { ...x, text: 'changed' } : x)), m(3, { text: 'new' }), ...markSent([m(4, { text: 'x' })], [m(4, { text: 'x' })], { sketch: 5, at: T0 })];
    const rows = [row(3, 'done'), row(5, 'question')];
    expect(doneMarks(marks, rows).map(x => x.n)).toEqual([1]);
    expect(clearDone(marks, rows).map(x => x.n)).toEqual([2, 3, 4]);
  });

  it('a reply that came back since the last look is an arrival; one already seen at its revision is not', () => {
    const rows = [row(3, 'done', { reply: { text: 'ok', at: '' }, rev: 40 }), row(4, 'queued', { rev: 41 })];
    expect(arrivals(rows, new Map([[3, 30]])).map(r => r.number)).toEqual([3]);
    expect(arrivals(rows, new Map([[3, 40]]))).toEqual([]);
  });

  it('the sent record survives the page\'s storage, and a broken one is dropped', () => {
    const marks = markAnswered(afterFirstSend(), 3, { sketch: 7, at: T0, text: 'Overview' });
    const back = decodeMarks(encodeMarks({ marks, next: 3 }));
    expect(back.marks[0].sent).toEqual(marks[0].sent);
    const broken = decodeMarks(JSON.stringify({ v: 1, next: 2, marks: [{ ...marks[0], sent: { sketch: 'x', k: 1, at: 1, sig: '' } }] }));
    expect(broken.marks[0].sent).toBeUndefined();
  });
});

describe('a sketch just sent', () => {
  const link = (now: number) => ({ facts: { agent: 'none' as const }, listed: true, now });
  it('waits for Claude while the rows read before the send do not hold it yet, and is not listed only after the grace', () => {
    const at = 1_000_000;
    expect(groupView({ sketch: 15, at, k: 1, sig: '' }, [], link(at + 2_000))).toMatchObject({ status: 'queued' });
    expect(groupView({ sketch: 15, at, k: 1, sig: '' }, [], link(at + 2_000)).attention).toBeUndefined();
    expect(groupView({ sketch: 15, at, k: 1, sig: '' }, [], link(at + 20_000))).toMatchObject({ status: 'unknown', attention: 'unlisted' });
  });
});
