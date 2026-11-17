import { describe, it, expect } from 'vitest';
import type { ActivityEntry } from '../../lib/types';
import {
  collapseRuns, dayLabel, entriesJson, entriesText, exportFileName, filterEntries, formatDuration,
  groupByDay, markEndedPauses, problemCount,
} from '../tabs/log-model';

const day = (y: number, m: number, d: number, hh = 12, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss).getTime();
const NOW = day(2026, 11, 11, 15);

function e(id: number, time: number, change: Partial<ActivityEntry> = {}): ActivityEntry {
  return { id, time, level: 'success', category: 'change', message: `m${id}`, ...change };
}

describe('log model', () => {
  it('filters by event kind within the server scope', () => {
    const list = [
      e(1, NOW, { profileId: 'a' }),
      e(2, NOW, { profileId: 'b', level: 'error', category: 'system' }),
      e(3, NOW, { profileId: 'a', level: 'warn', category: 'system' }),
      e(4, NOW, { category: 'system', level: 'info' }),
    ];
    const opts = { scope: 'this' as const, activeProfileId: 'a', profileCount: 2 };
    expect(filterEntries(list, { ...opts, event: 'activity' }).map(x => x.id)).toEqual([1]);
    expect(filterEntries(list, { ...opts, event: 'problems' }).map(x => x.id)).toEqual([3]);
    expect(filterEntries(list, { ...opts, event: 'all' }).map(x => x.id)).toEqual([1, 3, 4]);
    expect(filterEntries(list, { ...opts, scope: 'all', event: 'problems' }).map(x => x.id)).toEqual([2, 3]);
    expect(problemCount(list, opts)).toBe(1);
  });

  it('ends a script pause at the first later resume of the same server (older resume lines had no action)', () => {
    const pause = { level: 'warn' as const, category: 'system' as const, action: 'script-pause' };
    const list = markEndedPauses([
      e(1, 100, { ...pause, profileId: 'a' }),
      e(2, 200, { level: 'info', category: 'system', message: 'Background work resumed: Companion now holds about 0 parsed scripts.', profileId: 'a' }),
      e(3, 300, { ...pause, profileId: 'a' }),
      e(4, 400, { level: 'info', category: 'system', action: 'script-resume', profileId: 'a' }),
      e(5, 500, { level: 'info', category: 'system', action: 'script-resume', profileId: 'a' }),
      e(6, 450, { ...pause, profileId: 'b' }),
      e(7, 600, { ...pause, profileId: 'a' }),
    ]);
    expect(list.map(x => [x.id, x.endedAt])).toEqual([[1, 200], [2, undefined], [3, 400], [4, undefined], [5, undefined], [6, undefined], [7, undefined]]);
    const opts = { scope: 'all' as const, activeProfileId: 'a', profileCount: 2 };
    expect(problemCount(list, opts)).toBe(2);
    expect(filterEntries(list, { ...opts, event: 'problems' }).map(x => x.id)).toEqual([1, 3, 6, 7]);
    // Marking again after the resume left the list clears a stale end.
    expect(markEndedPauses(list.filter(x => x.id !== 4 && x.id !== 5)).find(x => x.id === 3)?.endedAt).toBeUndefined();
  });

  it('ends every earlier pause of the server at a resume: grouped repeats and lines without the action tag', () => {
    const paused = 'Background work paused: Companion already holds about 900 parsed scripts (9 MB) in this server\'s memory.';
    const resumed = 'Background work resumed: Companion now holds about 0 parsed scripts (0 MB) in this server\'s memory.';
    const pause = { level: 'warn' as const, category: 'system' as const, message: paused };
    const list = markEndedPauses([
      // Written by an earlier build: no action tag; one also has no server.
      e(1, 100, { ...pause, profileId: 'a', count: 54 }),
      e(2, 200, { ...pause, count: 69 }),
      // Current build, folded repeats (×12) of the same sentence.
      e(3, 300, { ...pause, action: 'script-pause', profileId: 'a', count: 12 }),
      e(4, 310, { ...pause, action: 'script-pause', profileId: 'a' }),
      e(5, 400, { level: 'info', category: 'system', action: 'script-resume', message: resumed, profileId: 'a' }),
      // Another server's pause is not ended by this resume.
      e(6, 350, { ...pause, action: 'script-pause', profileId: 'b', count: 3 }),
    ]);
    expect(list.map(x => [x.id, x.endedAt])).toEqual([[1, 400], [2, 400], [3, 400], [4, 400], [5, undefined], [6, undefined]]);
    const opts = { scope: 'this' as const, activeProfileId: 'a', profileCount: 2 };
    // Nothing of server a is counted; the grouped rows show as ended.
    expect(problemCount(list, opts)).toBe(0);
    const problems = filterEntries(list, { ...opts, event: 'problems' });
    expect(problems.map(x => x.id)).toEqual([1, 2, 3, 4]);
    expect(collapseRuns(problems).map(r => [r.count, r.entry.endedAt])).toEqual([[54 + 69 + 12 + 1, 400]]);
    // The resume line is information: Activity and All, not Problems.
    expect(filterEntries(list, { ...opts, event: 'activity' }).map(x => x.id)).toEqual([5]);
    expect(filterEntries(list, { ...opts, event: 'all' }).map(x => x.id)).toEqual([1, 2, 3, 4, 5]);
    // Server b's pause stays open and counted.
    expect(problemCount(list, { ...opts, activeProfileId: 'b' })).toBe(1);
  });

  it('a legacy resume line without the action also counts as Activity', () => {
    const resume = e(1, 1, { level: 'info', category: 'system', message: 'Background work resumed: Companion now holds about 0 parsed scripts.' });
    const opts = { scope: 'all' as const, activeProfileId: 'a', profileCount: 1 };
    expect(filterEntries([resume], { ...opts, event: 'activity' })).toHaveLength(1);
    expect(filterEntries([resume], { ...opts, event: 'problems' })).toHaveLength(0);
  });

  it('collapses identical consecutive messages without detail, newest first', () => {
    const rows = collapseRuns([e(1, 1, { message: 'x' }), e(2, 2, { message: 'x' }), e(3, 3, { message: 'y' }), e(4, 4, { message: 'y', detail: 'd' })]);
    expect(rows.map(r => [r.entry.id, r.count])).toEqual([[4, 1], [3, 1], [2, 2]]);
  });

  it('groups by calendar day with Today, Yesterday, then a date', () => {
    const rows = collapseRuns([e(1, day(2026, 11, 1)), e(2, day(2026, 11, 10, 23, 59)), e(3, day(2026, 11, 11, 0, 1))]);
    const groups = groupByDay(rows, NOW);
    expect(groups.map(g => [g.label === 'Today' || g.label === 'Yesterday' ? g.label : 'date', g.rows.length]))
      .toEqual([['Today', 1], ['Yesterday', 1], ['date', 1]]);
    expect(dayLabel(day(2025, 3, 2), NOW)).toMatch(/2025/);
  });

  it('formats durations', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(94)).toBe('94 ms');
    expect(formatDuration(1240)).toBe('1.2 s');
    expect(formatDuration(65_000)).toBe('1 min 5 s');
  });

  it('exports oldest first as text and JSON, in the stored record format', () => {
    const list = [e(2, day(2026, 11, 11, 14, 31, 52), { level: 'error', message: 'Execute failed', detail: 'Line 4: x', durationMs: 1200 }), e(1, day(2026, 11, 11, 14, 29, 3))];
    const text = entriesText(list, () => 'DEV');
    expect(text.split('\n')[0]).toBe('2026-11-11 14:29:03  Succeeded  m1');
    expect(text).toContain('2026-11-11 14:31:52  Failed  Execute failed  (1.2 s)\n  Change\n  Line 4: x');
    expect(JSON.parse(entriesJson(list)).map((x: ActivityEntry) => x.id)).toEqual([1, 2]);
    expect(exportFileName(day(2026, 11, 11, 9, 5))).toBe('companion-log-20261111-0905.json');
  });
});
