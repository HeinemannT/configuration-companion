// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted: unknown[] = [];
vi.mock('../frame-parent', () => ({
  postToParent: (m: unknown) => { posted.push(m); },
  fromParent: () => true,
}));
const confirmModal = vi.fn();
vi.mock('../modal', () => ({ confirmModal: (o: unknown) => confirmModal(o) }));

import { watchDirtyForHost } from '../frame-close-handshake';
import { installDirtyGuards } from '../../editor-core/overlay';

/** Send a close request and wait for the newest answer. */
function closeRequest(): Promise<{ ok: boolean }> {
  const before = posted.length;
  return new Promise(resolve => {
    const wait = setInterval(() => {
      const r = posted.slice(before).find(m => (m as { type: string }).type === 'CREV_OVERLAY_CLOSE_RESPONSE') as { ok: boolean } | undefined;
      if (r) { clearInterval(wait); resolve(r); }
    }, 1);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CREV_OVERLAY_CLOSE_REQUEST' } }));
  });
}

// One window per test file in reality; here one guard is installed and its predicates switched.
let dirty = false;
let count = 0;
installDirtyGuards({ isDirty: () => dirty, count: () => count, bodyText: 'b' });

describe('the unsaved-work rule in windows (installDirtyGuards)', () => {
  beforeEach(() => { confirmModal.mockReset(); });

  it('never asks when nothing is unsaved', async () => {
    dirty = false;
    await expect(closeRequest()).resolves.toMatchObject({ ok: true });
    expect(confirmModal).not.toHaveBeenCalled();
  });

  it('asks once and names how many changes would be lost', async () => {
    dirty = true; count = 3;
    confirmModal.mockResolvedValue(false);
    await expect(closeRequest()).resolves.toMatchObject({ ok: false });
    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(confirmModal).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard 3 unsaved changes?', confirmLabel: 'Discard', cancelLabel: 'Keep editing' }));
  });

  it('keeps the window when the prompt itself fails', async () => {
    dirty = true;
    confirmModal.mockRejectedValue(new Error('boom'));
    await expect(closeRequest()).resolves.toMatchObject({ ok: false });
  });
});

describe('the browser prompt before the window is destroyed (beforeunload)', () => {
  const unload = () => {
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(e);
    return e;
  };

  it('asks for the browser prompt while something is unsaved', () => {
    dirty = true;
    expect(unload().defaultPrevented).toBe(true);
  });

  it('lets the window go without a prompt when nothing is unsaved', () => {
    dirty = false;
    expect(unload().defaultPrevented).toBe(false);
  });
});

describe('watchDirtyForHost', () => {
  it('tells the host when the unsaved state changes, once per change', () => {
    dirty = false;
    window.dispatchEvent(new Event('input')); // the window's own watcher settles on "clean"
    posted.length = 0;
    let d = false;
    const stop = watchDirtyForHost(() => d, 60_000);
    d = true;
    window.dispatchEvent(new Event('input'));
    window.dispatchEvent(new Event('input'));
    d = false;
    window.dispatchEvent(new Event('keyup'));
    stop();
    expect(posted.filter(m => (m as { type: string }).type === 'CREV_FRAME_DIRTY')).toEqual([
      { type: 'CREV_FRAME_DIRTY', dirty: false },
      { type: 'CREV_FRAME_DIRTY', dirty: true },
      { type: 'CREV_FRAME_DIRTY', dirty: false },
    ]);
  });
});
