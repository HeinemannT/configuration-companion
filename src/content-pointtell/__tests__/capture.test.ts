import { describe, expect, it, vi } from 'vitest';
import { NEEDS_INVOCATION, captureWithFallback, createShotRun, isPermissionRefusal, viaDisplayMedia, type CaptureOutcome } from '../capture';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const REFUSED = "Either the '<all_urls>' or 'activeTab' permission is required.";

describe('captureWithFallback', () => {
  it('uses the worker\'s picture and asks Chrome for nothing more', async () => {
    const viaDisplay = vi.fn();
    const out = await captureWithFallback({ viaWorker: async () => ({ ok: true, dataUrl: PNG }), viaDisplay });
    expect('blob' in out && out.blob.type).toBe('image/png');
    expect(viaDisplay).not.toHaveBeenCalled();
  });

  it('falls back to Chrome\'s own tab capture when the permission is refused', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const out = await captureWithFallback({ viaWorker: async () => ({ ok: false, error: REFUSED }), viaDisplay: async () => blob });
    expect(out).toEqual({ blob });
  });

  it('says what to do when that is declined or unavailable too', async () => {
    const out = await captureWithFallback({ viaWorker: async () => ({ ok: false, error: REFUSED }), viaDisplay: async () => { throw new Error('NotAllowedError'); } });
    expect(out).toEqual({ error: NEEDS_INVOCATION });
    expect(NEEDS_INVOCATION).toBe('Open Point and tell with its shortcut or from the right-click menu to take pictures.');
  });

  it('reports another failure as it is, without the prompt', async () => {
    const viaDisplay = vi.fn();
    const out = await captureWithFallback({ viaWorker: async () => ({ ok: false, error: 'This tab is not the one shown.' }), viaDisplay });
    expect(out).toEqual({ error: 'Could not take a picture: This tab is not the one shown.' });
    expect(viaDisplay).not.toHaveBeenCalled();
  });

  it('treats no answer from the worker as a failure', async () => {
    const out = await captureWithFallback({ viaWorker: async () => undefined, viaDisplay: vi.fn() });
    expect(out).toEqual({ error: 'Could not take a picture: no answer from Companion' });
  });

  it('recognises Chrome\'s refusal wording', () => {
    expect(isPermissionRefusal(REFUSED)).toBe(true);
    expect(isPermissionRefusal('Not connected')).toBe(false);
    expect(isPermissionRefusal(undefined)).toBe(false);
  });
});

describe('createShotRun', () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const setup = () => {
    let current = true;
    let settle!: (o: CaptureOutcome) => void;
    let fail!: (e: unknown) => void;
    const states: boolean[] = [];
    const run = vi.fn(() => new Promise<CaptureOutcome>((ok, bad) => { settle = ok; fail = bad; }));
    const shot = createShotRun({ isCurrent: () => current, run, setWaiting: w => states.push(w) });
    return { shot, run, states, leave: () => { current = false; }, accept: () => settle({ blob }), decline: () => settle({ error: NEEDS_INVOCATION }), crash: () => fail(new Error('x')) };
  };

  it('waits while the prompt is open, and only the waiting flag says so', async () => {
    const s = setup();
    const p = s.shot.press();
    expect(s.shot.waiting()).toBe(true);
    expect(s.states).toEqual([true]);
    s.accept();
    expect(await p).toEqual({ blob });
    expect(s.shot.waiting()).toBe(false);
    expect(s.states).toEqual([true, false]);
  });

  it('ignores a second press while the prompt is open, and works again after', async () => {
    const s = setup();
    const p = s.shot.press();
    expect(await s.shot.press()).toBeNull();
    expect(s.run).toHaveBeenCalledTimes(1);
    s.decline();
    await p;
    const q = s.shot.press();
    expect(s.run).toHaveBeenCalledTimes(2);
    s.accept();
    expect(await q).toEqual({ blob });
  });

  it('gives the sentence for a decline or dismissal and clears the waiting mark', async () => {
    const s = setup();
    const p = s.shot.press();
    s.decline();
    expect(await p).toEqual({ error: NEEDS_INVOCATION });
    expect(s.shot.waiting()).toBe(false);
  });

  it('clears the waiting mark and gives the sentence when the run throws', async () => {
    const s = setup();
    const p = s.shot.press();
    s.crash();
    expect(await p).toEqual({ error: NEEDS_INVOCATION });
    expect(s.states).toEqual([true, false]);
  });

  it('drops a picture that arrives after the mode was left', async () => {
    const s = setup();
    const p = s.shot.press();
    s.leave();
    s.accept();
    expect(await p).toBeNull();
    expect(s.shot.waiting()).toBe(false);
  });

  it('does not start when the mode is off', async () => {
    const s = setup();
    s.leave();
    expect(await s.shot.press()).toBeNull();
    expect(s.run).not.toHaveBeenCalled();
  });
});

describe('viaDisplayMedia', () => {
  it('stops a stream that arrives after the mode was left and does nothing else', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    let grant!: (s: MediaStream) => void;
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => new Promise<MediaStream>(r => { grant = r; }) } });
    let current = true;
    const p = viaDisplayMedia(() => current);
    current = false;
    grant(stream);
    await expect(p).rejects.toThrow('left');
    expect(stop).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('rejects when the prompt is declined', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => Promise.reject(new DOMException('no', 'NotAllowedError')) } });
    await expect(viaDisplayMedia(() => true)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
