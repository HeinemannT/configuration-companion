import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspacePersistence } from './persistence';
import { restoreDraft, type DraftStore } from './storage';
import type { SavedWorkspace } from './workspace';

const data = (revision = 0) => ({ version: 1, revision, state: { rid: 'role-a' } }) as SavedWorkspace;
afterEach(() => { vi.useRealTimers(); });

it('debounces without evaluating full snapshot factories on navigation events', async () => {
  vi.useFakeTimers();
  const snapshots: SavedWorkspace[] = [];
  const write = vi.fn(async (read: () => SavedWorkspace) => { snapshots.push(structuredClone(read())); });
  const open = vi.fn(async () => ({ write, close: vi.fn() }));
  const persistence = createWorkspacePersistence(open, vi.fn()), read = vi.fn(() => data());
  for (let i = 0; i < 20; i++) await persistence.persist(read);
  expect(read).not.toHaveBeenCalled(); expect(persistence.pending).toBe(true);
  await vi.advanceTimersByTimeAsync(350);
  expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
  expect(persistence.pending).toBe(false); expect(snapshots).toHaveLength(1);
  await persistence.persist(read, true); expect(open).toHaveBeenCalledTimes(1);
});

it('samples queued state at dispatch and waits for durability before resolving immediate saves', async () => {
  let connect!: (store: DraftStore) => void, finish!: () => void;
  const snapshots: SavedWorkspace[] = [];
  const store: DraftStore = { close: vi.fn(), write: read => {
    snapshots.push(structuredClone(read()));
    return new Promise(resolve => { finish = resolve; });
  } };
  const persistence = createWorkspacePersistence(() => new Promise(resolve => { connect = resolve; }), vi.fn());
  let revision = 0;
  const read = vi.fn(() => data(revision));
  const first = persistence.persist(read, true);
  await vi.waitFor(() => expect(connect).toBeTypeOf('function'));
  revision = 1; connect(store);
  await vi.waitFor(() => expect(snapshots).toHaveLength(1));
  expect(snapshots[0].revision).toBe(1); expect(persistence.pending).toBe(true);
  const second = persistence.persist(read, true); revision = 2;
  finish(); await first;
  await vi.waitFor(() => expect(snapshots).toHaveLength(2));
  expect(snapshots[1].revision).toBe(2); expect(snapshots[0].revision).toBe(1);
  finish(); await second; expect(persistence.pending).toBe(false);
});

it('keeps the close guard after failed storage and recovers on a later save', async () => {
  vi.useFakeTimers();
  const close = vi.fn(), error = new Error('Quota exceeded'), onError = vi.fn();
  const open = vi.fn().mockResolvedValueOnce({ close, write: vi.fn().mockRejectedValue(error) })
    .mockResolvedValue({ close: vi.fn(), write: vi.fn().mockResolvedValue(undefined) });
  const persistence = createWorkspacePersistence(open, onError);
  await persistence.persist(() => data()); await vi.advanceTimersByTimeAsync(350);
  expect(onError).toHaveBeenCalledWith(error); expect(close).toHaveBeenCalledTimes(1);
  expect(persistence.pending).toBe(true);
  await persistence.persist(() => data(1), true);
  expect(open).toHaveBeenCalledTimes(2); expect(persistence.pending).toBe(false);
});

it('restores legacy saves and only overlays view state belonging to the same checkpoint', () => {
  const legacy = data(), checkpoint = { ...data(2), checkpointId: 'new', context: ['new context'] };
  const stale = { checkpointId: 'old', state: { raw: 'stale JSON draft' }, context: ['old context'] };
  expect(restoreDraft(legacy, stale)).toEqual(legacy);
  expect(restoreDraft(checkpoint, stale)).toEqual(checkpoint);
  expect(restoreDraft(checkpoint, { ...stale, checkpointId: 'new' })).toMatchObject({ revision: 2, state: stale.state, context: stale.context });
  expect(restoreDraft(undefined, stale)).toBeUndefined();
});
