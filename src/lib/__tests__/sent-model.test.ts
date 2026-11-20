import { describe, expect, it } from 'vitest';
import type { SketchRow } from '../claude-link';
import { ago, chatNeeded, hasNews, needsPoll, newestFirst, pageKeyOf, seenFor, sentLabel } from '../point-tell/sent-model';

const row = (number: number, state: SketchRow['state'], extra: Partial<SketchRow> = {}): SketchRow =>
  ({ number, at: '2026-11-20T10:00:00.000Z', page: `Page ${number}`, pageKey: `k${number}`, state, rev: number, ...extra });

describe('sent list', () => {
  it('labels the count and hides it when nothing was sent', () => {
    expect(sentLabel([])).toBeNull();
    expect(sentLabel([row(1, 'done')])).toBe('1 sent');
    expect(sentLabel([row(1, 'done'), row(2, 'queued')])).toBe('2 sent');
  });

  it('asks again only while something is open', () => {
    expect(needsPoll([])).toBe(false);
    expect(needsPoll([row(1, 'done'), row(2, 'cannot'), row(3, 'question')])).toBe(false);
    for (const s of ['queued', 'taken', 'working'] as const) expect(needsPoll([row(1, 'done'), row(2, s)])).toBe(true);
  });

  it('news is a reply newer than the one last looked at', () => {
    const rows = [row(1, 'done', { rev: 5, reply: { text: 'Done.', at: 'x' } }), row(2, 'queued', { rev: 6 })];
    expect(hasNews(rows, {})).toBe(true);
    expect(hasNews(rows, { '1': 5 })).toBe(false);
    expect(hasNews(rows, { '2': 9 })).toBe(true);
    expect(hasNews([row(2, 'queued', { rev: 6 })], {})).toBe(false);
    expect(seenFor(rows)).toEqual({ '1': 5 });
    expect(seenFor([])).toEqual({});
  });

  it('pushes the working chat forward only when sketches wait and no chat has asked lately', () => {
    expect(chatNeeded({ agent: 'none' }, [row(1, 'queued')])).toBe(true);
    expect(chatNeeded({ agent: 'none' }, [row(1, 'done')])).toBe(false);
    expect(chatNeeded({ agent: 'recent' }, [row(1, 'queued')])).toBe(false);
    expect(chatNeeded({ agent: 'waiting' }, [row(1, 'queued')])).toBe(false);
  });

  it('lists the newest first without changing the input', () => {
    const rows = [row(1, 'done'), row(3, 'done'), row(2, 'done')];
    expect(newestFirst(rows).map(r => r.number)).toEqual([3, 2, 1]);
    expect(rows.map(r => r.number)).toEqual([1, 3, 2]);
  });

  it('says how long ago in plain words', () => {
    const now = new Date('2026-11-20T10:30:00.000Z');
    expect(ago('2026-11-20T10:29:40.000Z', now)).toBe('now');
    expect(ago('2026-11-20T10:25:00.000Z', now)).toBe('5 min');
    expect(ago('2026-11-20T10:29:00.000Z', now)).toBe('1 min');
    expect(ago('2026-11-20T08:00:00.000Z', now)).toMatch(/^\d\d:\d\d$/);
    expect(ago('2026-11-20T10:31:00.000Z', now)).toBe('now');
  });

  it('keys a page by address and object, without hash or query noise', () => {
    expect(pageKeyOf('https://h.example/Steadfast/?rid=1&tabrid=2#x', '9')).toBe('https://h.example/Steadfast/?rid=9');
    expect(pageKeyOf('https://h.example/Steadfast/?rid=1')).toBe('https://h.example/Steadfast/');
    expect(pageKeyOf('not a url')).toBe('');
  });
});
