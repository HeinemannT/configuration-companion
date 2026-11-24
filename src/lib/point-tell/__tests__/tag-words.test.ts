import { describe, expect, it } from 'vitest';
import { tagSpec, typeWords } from '../tag-words';
import type { PtMark } from '../types';

const classOf = (id: string): string | undefined => ({ a: 'PieChart', b: 'ActionButton' } as Record<string, string>)[id];
const mark = (p: Partial<PtMark>): PtMark => ({ n: 1, text: '', targets: [], at: 0, ...p });
const ink = { strokes: [{ points: [[0, 0] as [number, number]] }], place: {} };

describe('the words of a tag', () => {
  it('a move, an add, a sketched widget, a change, crossed out', () => {
    expect(tagSpec(mark({ targets: ['a'], meaning: { kind: 'move', to: { before: 'b' } }, ink }), classOf)).toEqual({ word: 'Move', icon: 'move' });
    expect(tagSpec(mark({ meaning: { kind: 'add', place: { into: 't' } }, ink }), classOf)?.word).toBe('Add');
    expect(tagSpec(mark({ meaning: { kind: 'add', place: { into: 't' }, widget: 'table' }, ink }), classOf)?.word).toBe('Table');
    expect(tagSpec(mark({ meaning: { kind: 'add', place: { into: 't' }, widget: 'chart' }, ink }), classOf)?.word).toBe('Chart');
    expect(tagSpec(mark({ meaning: { kind: 'add', place: { into: 't' }, widget: 'button' }, ink }), classOf)?.word).toBe('Button');
    expect(tagSpec(mark({ meaning: { kind: 'add', place: { into: 't' }, widget: 'text' }, ink }), classOf)?.word).toBe('Text');
    expect(tagSpec(mark({ targets: ['a'], meaning: { kind: 'change' }, ink }), classOf)?.word).toBe('Change');
    expect(tagSpec(mark({ targets: ['a'], meaning: { kind: 'crossed' }, ink }), classOf)).toEqual({ word: 'Crossed out', icon: 'crossed' });
  });

  it('a loop or a pointer says the type of one object, or how many', () => {
    expect(tagSpec(mark({ targets: ['a'], reading: 'By status', ink }), classOf)?.word).toBe('Pie chart');
    expect(tagSpec(mark({ targets: ['a', 'b'], reading: '2 objects', ink }), classOf)?.word).toBe('2 objects');
  });

  it('a typed note on an object says Note; ink not understood and a page note say nothing', () => {
    expect(tagSpec(mark({ targets: ['b'], text: 'x' }), classOf)).toEqual({ word: 'Note', icon: 'note' });
    expect(tagSpec(mark({ targets: ['b'], ink }), classOf)).toBeNull();
    expect(tagSpec(mark({ ink }), classOf)).toBeNull();
    expect(tagSpec(mark({ text: 'page' }), classOf)).toBeNull();
  });

  it('types in BMP words', () => {
    expect(typeWords('ExtendedTable')).toBe('Extended table');
    expect(typeWords('Container')).toBe('Container');
    expect(typeWords(undefined)).toBe('Object');
  });
});

describe('the tag of an arrow with no operation', () => {
  it('says Arrow, also on empty space; without its reading it is not understood', () => {
    expect(tagSpec(mark({ targets: ['a', 'b'], reading: 'Arrow from A to B', arrow: { from: 'a', to: 'b' }, ink }), classOf)).toEqual({ word: 'Arrow', icon: 'move' });
    expect(tagSpec(mark({ reading: 'Arrow', arrow: {}, ink }), classOf)).toEqual({ word: 'Arrow', icon: 'move' });
    expect(tagSpec(mark({ targets: ['a'], arrow: { from: 'a' }, ink }), classOf)).toBeNull();
  });
});
