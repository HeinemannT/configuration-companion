// @vitest-environment happy-dom
/**
 * The shared progress of the local code copy (copy-progress.ts) and its
 * words (copy-status-text.ts): driven by a CodeIndexStatus and the clock
 * only. Phase in words, n of m on a determinate bar (indeterminate while the
 * total is unknown), requests and elapsed time, the time left only once this
 * sync's own pace tells it, the governor's waits with a countdown, Stop.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCopyProgress } from '../copy-progress';
import { copyProblemView, copyProgressView, durationWords, serverScriptsSentence, timeLeft } from '../copy-status-text';
import type { CodeIndexStatus } from '../messages';

const T0 = new Date(2026, 10, 27, 14, 0).getTime();
const base: CodeIndexStatus = { environment: 'p1@https://bmp.test/W/', state: 'building', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 1 };
const st = (more: Partial<CodeIndexStatus>): CodeIndexStatus => ({ ...base, ...more });

describe('the words', () => {
  it('durations read as people say them', () => {
    expect(durationWords(4_000)).toBe('4 s');
    expect(durationWords(134_000)).toBe('2 min 14 s');
    expect(durationWords(120_000)).toBe('2 min');
    expect(durationWords(3_900_000)).toBe('1 h 5 min');
  });

  it('listing, reading, writing; the place when the copy is read place by place', () => {
    expect(copyProgressView(st({ progress: { phase: 'listing', read: 0, toRead: 0, startedAt: T0 } }), T0 + 4_000)).toMatchObject({ title: 'Making the copy', line: 'Listing the server\'s code.', fraction: null, facts: ['4 s'] });
    expect(copyProgressView(st({ progress: { phase: 'listing', read: 0, toRead: 0, listed: 8400, source: 3, sources: 12 } }), T0)!.line).toBe('Listing the server\'s code: 8,400 objects so far, place 3 of 12.');
    expect(copyProgressView(st({ progress: { phase: 'reading', read: 1240, toRead: 3573, chars: 4_300_000, posts: 42, startedAt: T0 } }), T0 + 134_000)).toMatchObject({
      line: 'Reading the code: 1,240 of 3,573 objects (4.3 M characters).', facts: ['2 min 14 s', '42 requests'], running: true,
    });
    expect(copyProgressView(st({ progress: { phase: 'reading', read: 400, toRead: 1200, place: 'Group', source: 3, sources: 12 } }), T0)!.line).toBe('Reading the code of Group (3 of 12): 400 of 1,200 objects.');
    expect(copyProgressView(st({ progress: { phase: 'reading', read: 10, toRead: 10 } }), T0)!.line).toBe('Writing the copy on this computer.');
    expect(copyProgressView(st({ state: 'refreshing', progress: { phase: 'listing', read: 0, toRead: 0 } }), T0)).toMatchObject({ title: 'Refreshing the copy', line: 'Asking the server what changed.' });
    expect(copyProgressView(st({ state: 'paused', progress: { phase: 'reading', read: 976, toRead: 1632 } }), T0)).toMatchObject({ title: 'Copying stopped', running: false, line: '976 of 1,632 objects read. Resume continues from there.' });
    expect(copyProgressView(st({ state: 'ready' }), T0)).toBeNull();
  });

  it('the governor\'s waits, with what is left of them', () => {
    expect(copyProgressView(st({ progress: { phase: 'reading', read: 1, toRead: 9 }, wait: { kind: 'budget', until: T0 + 4_000 } }), T0)).toMatchObject({ line: 'Companion keeps its load on the server low. Waiting 4 s.', waiting: true });
    expect(copyProgressView(st({ progress: { phase: 'reading', read: 1, toRead: 9 }, wait: { kind: 'slow', until: T0 + 110_000 } }), T0)!.line).toBe('The server answers slowly. Companion waits 1 min 50 s before the next request.');
    // Over: the work line again.
    expect(copyProgressView(st({ progress: { phase: 'reading', read: 1, toRead: 9 }, wait: { kind: 'budget', until: T0 - 1 } }), T0)).toMatchObject({ waiting: false });
  });

  it('time left only from this sync\'s own pace: 10 s and 2 % at least', () => {
    const s = st({ progress: { phase: 'reading', read: 300, toRead: 1000 } });
    expect(timeLeft(s, T0 + 60_000, null)).toBeNull();
    expect(timeLeft(s, T0 + 5_000, { at: T0, read: 100, toRead: 1000 })).toBeNull();
    expect(timeLeft(s, T0 + 60_000, { at: T0, read: 295, toRead: 1000 })).toBeNull();
    // 200 objects a minute, 700 to go: about 4 min (3.5 rounded).
    expect(timeLeft(s, T0 + 60_000, { at: T0, read: 100, toRead: 1000 })).toBe('about 4 min left');
    expect(timeLeft(st({ progress: { phase: 'reading', read: 950, toRead: 1000 } }), T0 + 60_000, { at: T0, read: 100, toRead: 1000 })).toBe('less than a minute left');
  });

  it('a problem says where it lives and what helps', () => {
    const o = copyProblemView({ kind: 'overload', until: T0 + 30 * 60_000, detail: 'HTTP 503' }, T0);
    expect(o).toMatchObject({ where: 'server', actions: ['retry'], retryAt: T0 + 30 * 60_000, detail: 'HTTP 503' });
    expect(o.sentence).toBe('The server answered like an overloaded one, so copying stopped. Companion sends it no background work until 14:30. Searches still read the server.');
    expect(copyProblemView({ kind: 'busy' }, T0)).toMatchObject({ where: 'computer', actions: ['retry'] });
    expect(copyProblemView({ kind: 'too-large', sources: ['Group'] }, T0).actions).toEqual([]);
    expect(copyProblemView({ kind: 'not-listed', sources: ['Portal'] }, T0).sentence).toBe('The server did not list the code of Portal. The copy on this computer is not complete for them.');
    // Where the 13 MB are: on the server, not on this computer.
    expect(serverScriptsSentence({ entries: 213, bytes: 13_000_000, since: null, restartSeen: false }, T0)).toBe('Companion has left about 213 parsed scripts (about 13 MB) in this server\'s memory, not disk space on this computer, and starts the count again by itself when it sees the server restart. Other background work that needs a new script waits; a copy you start does not.');
  });

  it('plain words: no em dash, no "index"', () => {
    const src = readFileSync(join(__dirname, '..', 'copy-status-text.ts'), 'utf8') + readFileSync(join(__dirname, '..', 'copy-progress.ts'), 'utf8');
    const strings = [...src.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2]);
    expect(strings.filter(t => /—/.test(t))).toEqual([]);
    expect(strings.filter(t => /\bindex(es|ed)?\b/i.test(t))).toEqual([]);
  });
});

describe('the component', () => {
  it('a determinate bar with the mark on its leading edge, reading; Stop calls back', () => {
    let now = T0;
    const onStop = vi.fn();
    const p = createCopyProgress({ onStop, now: () => now });
    document.body.append(p.el);
    expect(p.el.hidden).toBe(true);
    p.update(st({ progress: { phase: 'reading', read: 250, toRead: 1000, posts: 12, startedAt: T0 } }));
    expect(p.el.hidden).toBe(false);
    expect(p.el.style.getPropertyValue('--cp')).toBe('0.25');
    expect(p.el.hasAttribute('data-known')).toBe(true);
    expect(p.el.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25');
    expect(p.el.querySelector('.crev-cp-rider')!.getAttribute('data-mood')).toBe('read');
    expect(p.el.querySelector('.crev-cp-rider svg')).not.toBeNull();
    expect(p.el.querySelector('.crev-cp-title')!.textContent).toBe('Making the copy');
    const stop = p.el.querySelector<HTMLButtonElement>('.crev-cp-stop')!;
    expect(stop.hidden).toBe(false);
    stop.click();
    expect(onStop).toHaveBeenCalledOnce();
    // 20 s later, 200 more read: the time left appears.
    now = T0 + 20_000;
    p.update(st({ progress: { phase: 'reading', read: 450, toRead: 1000, posts: 20, startedAt: T0 } }));
    expect(p.el.querySelector('.crev-cp-facts')!.textContent).toBe('20 s · 20 requests · less than a minute left');
    p.destroy();
  });

  it('indeterminate while the total is unknown; a wait rests the mark; a finished copy hides it', () => {
    const p = createCopyProgress({ now: () => T0 });
    p.update(st({ progress: { phase: 'listing', read: 0, toRead: 0 } }));
    expect(p.el.hasAttribute('data-known')).toBe(false);
    expect(p.el.querySelector('[role="progressbar"]')!.hasAttribute('aria-valuenow')).toBe(false);
    // No onStop: no Stop.
    expect(p.el.querySelector<HTMLButtonElement>('.crev-cp-stop')!.hidden).toBe(true);
    p.update(st({ progress: { phase: 'reading', read: 1, toRead: 9 }, wait: { kind: 'budget', until: T0 + 4_000 } }));
    expect(p.el.hasAttribute('data-wait')).toBe(true);
    expect(p.el.querySelector('.crev-cp-rider')!.hasAttribute('data-mood')).toBe(false);
    p.update(st({ state: 'ready', builtAt: T0, syncedAt: T0 }));
    expect(p.el.hidden).toBe(true);
    p.destroy();
  });

  it('its stylesheet has no dark variant and stops moving under reduced motion', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'styles', 'copy-progress.css'), 'utf8');
    expect(css).not.toMatch(/dark/i);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
