import { describe, expect, it } from 'vitest';
import { arrived, diffWords, heardWords, loudNow, phraseEnded, spokenText, staggerMs, type HeardWord } from '../voice-words';

const w = (text: string, final = false): HeardWord => ({ text, final });
const words = (s: string, final = false): HeardWord[] => s.split(' ').filter(Boolean).map(t => w(t, final));
const kinds = (prev: HeardWord[], next: HeardWord[]) => diffWords(prev, next).items.map(i => i.kind);

describe('the words of the results', () => {
  it('splits every result into words, each carrying whether its result is final', () => {
    expect(heardWords([{ text: 'make the Export', final: true }, { text: ' button a menu', final: false }])).toEqual([
      w('make', true), w('the', true), w('Export', true), w('button'), w('a'), w('menu'),
    ]);
  });

  it('ignores white space and empty results', () => {
    expect(heardWords([{ text: '   ', final: true }, { text: '\n hello\t there ', final: false }])).toEqual([w('hello'), w('there')]);
    expect(heardWords([])).toEqual([]);
  });
});

describe('what changed between two lists of words', () => {
  it('the first words are all new', () => {
    const d = diffWords([], words('make the'));
    expect(d.items.map(i => [i.word.text, i.kind, i.from])).toEqual([['make', 'new', null], ['the', 'new', null]]);
    expect(arrived(d)).toBe(2);
  });

  it('a result that only adds words keeps the earlier ones and makes the added ones new', () => {
    const d = diffWords(words('make the'), words('make the Export button'));
    expect(d.items.map(i => i.kind)).toEqual(['same', 'same', 'new', 'new']);
    expect(d.items.map(i => i.from)).toEqual([0, 1, null, null]);
    expect(d.removed).toEqual([]);
  });

  it('a revised interim word is changed in place, not replaced after it', () => {
    const d = diffWords(words('make the Export button a venue'), words('make the Export button a menu'));
    expect(d.items.map(i => i.kind)).toEqual(['same', 'same', 'same', 'same', 'same', 'changed']);
    expect(d.items[5].from).toBe(5);
    expect(d.items[5].word.text).toBe('menu');
  });

  it('a revision in the middle keeps the words after it', () => {
    const d = diffWords(words('make the expert button'), words('make the Export button'));
    expect(d.items.map(i => i.kind)).toEqual(['same', 'same', 'changed', 'same']);
    expect(d.items.map(i => i.from)).toEqual([0, 1, 2, 3]);
  });

  it('one word revised into two: the first is changed, the second is new', () => {
    const d = diffWords(words('a venue now'), words('a menu and now'));
    expect(d.items.map(i => [i.word.text, i.kind])).toEqual([['a', 'same'], ['menu', 'changed'], ['and', 'new'], ['now', 'same']]);
  });

  it('two words revised into one: the second is gone', () => {
    const d = diffWords(words('so be it now'), words('so beat now'));
    expect(d.items.map(i => [i.word.text, i.kind])).toEqual([['so', 'same'], ['beat', 'changed'], ['now', 'same']]);
    expect(d.removed).toEqual([2]);
  });

  it('a shorter list drops the words at its end', () => {
    const d = diffWords(words('make the Export button'), words('make the'));
    expect(d.items).toHaveLength(2);
    expect(d.removed).toEqual([2, 3]);
  });

  it('a word that became final is firm; one that was final already is the same', () => {
    expect(kinds([w('make', true), w('the')], [w('make', true), w('the', true)])).toEqual(['same', 'firm']);
    expect(kinds(words('make the'), words('make the', true))).toEqual(['firm', 'firm']);
  });

  it('a revision that is final at once is changed, and carries its final state', () => {
    const d = diffWords(words('a venue'), words('a menu', true));
    expect(d.items[1].kind).toBe('changed');
    expect(d.items[1].word.final).toBe(true);
  });

  it('the same list is all the same', () => {
    expect(kinds(words('a b c'), words('a b c'))).toEqual(['same', 'same', 'same']);
    expect(diffWords([], []).items).toEqual([]);
  });

  it('every kept word points at the word it continues, in order', () => {
    const prev = words('one two three four five');
    const next = words('one 2 three five six');
    const d = diffWords(prev, next);
    const from = d.items.map(i => i.from).filter((f): f is number => f !== null);
    expect([...from].sort((a, b) => a - b)).toEqual(from);
    for (const i of d.items) if (i.from !== null && i.kind === 'same') expect(prev[i.from].text).toBe(i.word.text);
  });
});

describe('the text', () => {
  it('goes after what was typed, with one space', () => {
    expect(spokenText('typed', words('hello there'))).toBe('typed hello there');
    expect(spokenText('', words('hello there'))).toBe('hello there');
    expect(spokenText('typed ', words('hello'))).toBe('typed hello');
    expect(spokenText('line\n', words('hello'))).toBe('line\nhello');
  });

  it('is the text of the field when nothing was heard', () => {
    expect(spokenText('typed', [])).toBe('typed');
  });
});

describe('phrases and loud words', () => {
  it('a phrase ends when words become final or a final word closes a sentence', () => {
    expect(phraseEnded(diffWords(words('a b'), words('a b c')))).toBe(false);
    expect(phraseEnded(diffWords(words('a b'), words('a b', true)))).toBe(true);
    expect(phraseEnded(diffWords([w('a', true)], [w('a', true), w('done.', true)]))).toBe(true);
    expect(phraseEnded(diffWords([w('a', true)], [w('a', true), w('more', true)]))).toBe(false);
  });

  it('the words of a chunk land a few milliseconds apart, never far apart', () => {
    expect([0, 1, 2].map(n => staggerMs(n))).toEqual([0, 45, 90]);
    expect(staggerMs(40)).toBe(180);
    expect(staggerMs(-3)).toBe(0);
  });

  it('a loud word counts once in a while', () => {
    expect(loudNow(0.95, 5000, 0)).toBe(true);
    expect(loudNow(0.95, 5300, 5000)).toBe(false);
    expect(loudNow(0.6, 9000, 0)).toBe(false);
  });
});
