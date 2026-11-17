// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { describeFailure } from '../connection-copy';
import { failedNote, failureBlock, unreadValue } from '../failure-form';
import { discardTitle, mustAskBeforeLeaving, unsavedCount } from '../unsaved';
import { coverageText } from '../coverage-line';
import { indexCoverage, notSearchedReason } from '../used-in-code';

describe('describeFailure: one set of failure sentences', () => {
  it('a transport error reads as the connection sentence, the raw text only as detail', () => {
    const c = describeFailure({ error: 'TypeError: Failed to fetch' });
    expect(c.title).toBe('Server unreachable');
    expect(c.sentence).toMatch(/does not answer/);
    expect(c.sentence).not.toContain('Failed to fetch');
    expect(c.detail).toBe('TypeError: Failed to fetch');
    expect(c.retry).toBe(true);
  });
  it('kinds map to their sentences', () => {
    expect(describeFailure({ error: 'x', kind: 'not-signed-in' }).fix).toBe('open-bmp');
    expect(describeFailure({ error: 'x', kind: 'timeout' }).title).toBe('No answer in time');
    expect(describeFailure({ error: 'x', kind: 'permission' }).retry).toBe(false);
    expect(describeFailure({ error: 'x', online: false }).title).toBe('No network');
  });
  it('an unknown cause keeps the detail visible', () => {
    expect(describeFailure({ error: 'No object with RID 1' }).showDetail).toBe(true);
  });
});

describe('failure forms: never look like data', () => {
  it('failedNote: text, reason behind Details (not a tooltip), Retry', () => {
    const retry = vi.fn();
    const n = failedNote('The scan failed.', 'timeout', retry);
    expect(n.querySelector('.ui-failed-t')!.textContent).toBe('The scan failed.');
    expect(n.querySelector('details summary')!.textContent).toBe('Details');
    expect(n.querySelector('.ui-failed-detail')!.textContent).toBe('timeout');
    (n.querySelector('.ui-failed-retry') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledOnce();
  });
  it('failureBlock: title, sentence, Retry only where it applies', () => {
    const b = failureBlock(describeFailure({ error: 'x', kind: 'permission' }), vi.fn());
    expect(b.querySelector('.ui-failed-retry')).toBeNull();
    expect(b.getAttribute('role')).toBe('alert');
  });
  it('unreadValue: "could not be read" with the reason for screen readers', () => {
    const v = unreadValue('not signed in');
    expect(v.textContent).toBe('could not be read: not signed in');
    expect(v.title).toBe('not signed in');
  });
});

describe('unsaved: one word, one rule', () => {
  it('names the count and asks only when something is unsaved', () => {
    expect(unsavedCount(1)).toBe('1 unsaved change');
    expect(discardTitle(3)).toBe('Discard 3 unsaved changes?');
    expect(discardTitle()).toBe('Discard unsaved changes?');
    expect(mustAskBeforeLeaving(0)).toBe(false);
    expect(mustAskBeforeLeaving(2)).toBe(true);
    expect(mustAskBeforeLeaving(false)).toBe(false);
  });
});

describe('"In code" coverage', () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  it('states the index size and time, pending objects and what cannot be found', () => {
    const text = coverageText(indexCoverage({ objects: 3025, syncedAt: new Date(2026, 10, 12, 14, 2).getTime(), builtAt: null, pending: 4 }), now);
    expect(text).toBe('Searched 3,025 objects with code in the copy from 12 Nov, 14:02. 4 changed objects are not read yet. References built from text at run time are not found.');
  });
  it('says why nothing was searched', () => {
    expect(coverageText({ kind: 'not-searched', reason: notSearchedReason('none') })).toBe('Not searched: no code copy on this computer.');
    expect(notSearchedReason('building')).toBe('the code copy is still being made');
    expect(notSearchedReason(null)).toBe('no answer about the code copy');
  });
});
