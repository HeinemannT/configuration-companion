import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: number; time: number; level: string; message: string; profileId?: string };
const { activity, logActivity } = vi.hoisted(() => {
  const activity: Row[] = [];
  const logActivity = vi.fn((level: string, message: string, _detail?: string, _meta?: unknown, profileId?: string) => {
    const entry = { id: activity.length + 1, time: Date.now(), level, message, profileId };
    activity.push(entry);
    return entry;
  });
  return { activity, logActivity };
});
vi.mock('../activity', () => ({ getActivityLog: () => activity, logActivity }));

import { holdLogEntryForPanel, logIdForError, takeHeldLogEntry } from '../toast-log';

beforeEach(() => { activity.length = 0; logActivity.mockClear(); vi.useRealTimers(); });

describe('logIdForError', () => {
  it('reuses a recent error entry that says the same thing', () => {
    activity.push({ id: 5, time: Date.now() - 1000, level: 'error', message: 'Save failed: boom' });
    expect(logIdForError('Save failed: boom')).toBe(5);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('records an error entry when none matches, so the link lands somewhere', () => {
    activity.push({ id: 5, time: Date.now() - 1000, level: 'info', message: 'Save failed: boom' });
    const id = logIdForError('Save failed: boom', 'p1', 'detail');
    expect(logActivity).toHaveBeenCalledWith('error', 'Save failed: boom', 'detail', expect.anything(), 'p1');
    expect(id).toBe(2);
  });

  it('does not reuse an old entry', () => {
    activity.push({ id: 5, time: Date.now() - 60_000, level: 'error', message: 'Save failed: boom' });
    logIdForError('Save failed: boom');
    expect(logActivity).toHaveBeenCalled();
  });
});

describe('held entry for a panel that is opening', () => {
  it('is handed over once, and only while fresh', () => {
    holdLogEntryForPanel(1, 9);
    expect(takeHeldLogEntry(1)).toBe(9);
    expect(takeHeldLogEntry(1)).toBeUndefined();
    vi.useFakeTimers();
    holdLogEntryForPanel(2, 4);
    vi.advanceTimersByTime(11_000);
    expect(takeHeldLogEntry(2)).toBeUndefined();
  });
});
