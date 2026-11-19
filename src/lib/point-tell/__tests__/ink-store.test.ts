import { describe, expect, it } from 'vitest';
import { decodeMarks, encodeMarks } from '../store';
import type { PtMark } from '../types';

const mark: PtMark = {
  n: 3, text: 'x', targets: ['btn_export'], at: 5,
  meaning: { kind: 'move', to: { before: 'btn_new_risk' }, words: 'Move "Export" before "New risk"' },
  reading: 'Move Export before New risk',
  ink: {
    strokes: [{ points: [[300.4, 460.1], [210, 459.2], [120.7, 458]], r: [0.4, 2.65, 0.12] }, { points: [[5, 5]] }],
    place: { tabId: 'tab_overview', row: 3, col: 1 },
    anchor: { id: 'btn_export', box: { left: 266, top: 440, width: 166, height: 40 } },
  },
};

describe('ink in the store', () => {
  it('round-trips strokes with their radii, the anchor and the reading', () => {
    const back = decodeMarks(encodeMarks({ marks: [mark], next: 4 }));
    expect(back.marks[0]).toEqual(mark);
    expect(back.next).toBe(4);
  });

  it('keeps the widget kind and the candidate types of a sketch, and drops them without a kind', () => {
    const add = { ...mark, meaning: { kind: 'add' as const, place: { after: 'btn_export' }, columns: 3, widget: 'chart' as const, types: ['BarChart', 'BarLineChart'], words: 'x' } };
    expect(decodeMarks(encodeMarks({ marks: [add], next: 4 })).marks[0].meaning).toEqual(add.meaning);
    const raw = JSON.stringify({ v: 1, next: 2, marks: [{ n: 1, text: '', targets: [], at: 0, meaning: { kind: 'add', place: { into: 't' }, widget: 'sofa', types: ['A'] } }] });
    expect(decodeMarks(raw).marks[0].meaning).toEqual({ kind: 'add', place: { into: 't' } });
  });

  it('a mark stored as delete by an earlier version comes back as crossed out, and a move keeps its width', () => {
    const raw = JSON.stringify({ v: 1, next: 3, marks: [
      { n: 1, text: '', targets: ['a'], at: 0, reading: 'Delete A', meaning: { kind: 'delete' } },
      { n: 2, text: '', targets: ['b'], at: 0, meaning: { kind: 'move', to: { after: 'c' }, columns: 3, words: 'x' } },
    ] });
    const m = decodeMarks(raw).marks;
    expect(m[0].meaning).toEqual({ kind: 'crossed' });
    expect(m[1].meaning).toEqual({ kind: 'move', to: { after: 'c' }, columns: 3, words: 'x' });
  });

  it('drops radii that do not match the points, and a bad anchor, keeping the stroke', () => {
    const raw = JSON.stringify({ v: 1, next: 2, marks: [{ n: 1, text: '', targets: [], at: 0, ink: { strokes: [{ points: [[1, 2], [3, 4]], r: [1] }], place: {}, anchor: { id: 'a', box: { left: 'x' } } } }] });
    const m = decodeMarks(raw).marks[0];
    expect(m.ink?.strokes).toEqual([{ points: [[1, 2], [3, 4]] }]);
    expect(m.ink?.anchor).toBeUndefined();
  });

  it('thirty marks with ink stay small', () => {
    const pts = Array.from({ length: 40 }, (_, i) => [100 + i * 7.3, 200 + Math.sin(i / 5) * 12] as [number, number]);
    const marks = Array.from({ length: 30 }, (_, i) => ({ ...mark, n: i + 1, ink: { ...mark.ink!, strokes: [{ points: pts, r: pts.map(() => 2.1) }, { points: pts, r: pts.map(() => 2.1) }] } }));
    expect(encodeMarks({ marks, next: 31 }).length).toBeLessThan(150_000);
  });
});
