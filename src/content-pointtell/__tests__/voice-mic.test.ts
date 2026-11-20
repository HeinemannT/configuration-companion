// @vitest-environment happy-dom
/**
 * The microphone in the comment field: click to start listening, click again to stop. A fake recogniser and a fake input stand in for the
 * browser's; every wait is for a condition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();
vi.mock('../../lib/messaging', () => ({ sendRequest: (...a: unknown[]) => sendRequest(...a), sendFireForget: vi.fn() }));
const showToast = vi.fn();
vi.mock('../../lib/toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

let recs: FakeRec[] = [];
class FakeRec {
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
  started = false; stopped = false; aborted = false;
  onresult: ((e: unknown) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null; onend: (() => void) | null = null;
  onsoundstart: (() => void) | null = null; onsoundend: (() => void) | null = null; onspeechstart: (() => void) | null = null; onspeechend: (() => void) | null = null;
  constructor() { recs.push(this); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
}

let tracksStopped = 0;
let closed = 0;
const stream = () => ({ getTracks: () => [{ stop: () => { tracksStopped++; } }] });
class FakeAudioContext {
  resume() { return Promise.resolve(); }
  close() { closed++; return Promise.resolve(); }
  createMediaStreamSource() { return { connect: () => {} }; }
  createAnalyser() { return { fftSize: 512, smoothingTimeConstant: 0, connect: () => {}, getByteTimeDomainData: (b: Uint8Array) => { for (let i = 0; i < b.length; i++) b[i] = 128 + Math.round(60 * Math.sin(i / 3)); } }; }
}

let now = 1000;
async function load(prefs: { on: boolean }) {
  vi.resetModules();
  sendRequest.mockImplementation(async (m: { type: string; on?: boolean }) => {
    if (m.type === 'POINT_TELL_VOICE') return { type: 'POINT_TELL_VOICE_DATA', prefs: { on: m.on === true ? true : prefs.on, lang: 'en-US', noticed: true } };
    return undefined;
  });
  const voice = await import('../voice');
  voice.initVoice();
  await vi.waitFor(() => { expect(sendRequest).toHaveBeenCalled(); });
  return voice;
}

function field() {
  const card = document.createElement('div');
  const wrap = document.createElement('div');
  wrap.className = 'pt-area-wrap';
  const area = document.createElement('textarea');
  area.value = 'typed';
  wrap.appendChild(area);
  card.appendChild(wrap);
  document.body.appendChild(card);
  // The field's box (the fake DOM has no layout): well inside the window, so the listener has room above it.
  for (const [k, v] of Object.entries({ offsetLeft: 400, offsetTop: 300, offsetWidth: 268, offsetHeight: 100 })) Object.defineProperty(card, k, { value: v, configurable: true });
  return { card, wrap, area };
}
/** How far the caret has swelled with the voice (1: not at all). */
const caretSwell = (card: Element): number => parseFloat(card.querySelector<HTMLElement>('.pt-vw-bar')?.style.transform.replace('scaleY(', '') || '1');
const press = (el: Element, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
const tap = (el: HTMLElement) => el.click();

beforeEach(() => {
  document.body.innerHTML = '';
  recs = []; tracksStopped = 0; closed = 0; now = 1000;
  sendRequest.mockReset(); showToast.mockReset();
  const w = window as unknown as Record<string, unknown>;
  w.webkitSpeechRecognition = FakeRec;
  w.SpeechRecognition = undefined;
  w.AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => stream()) }, configurable: true });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 1024, configurable: true });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the microphone: click to start, click to stop', () => {
  it('a click starts listening and the caret follows the real input; the next click keeps the words and stops the input', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    expect(card.classList.contains('pt-listening')).toBe(true);
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    // The real input is opened beside the recogniser, and the bars are drawn from it.
    await vi.waitFor(() => { expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled(); });
    await vi.waitFor(() => { now += 50; expect(caretSwell(card)).toBeGreaterThan(1.1); });
    tap(mic);
    expect(v.listening()).toBe(false);
    expect(recs[0].stopped).toBe(true);
    expect(tracksStopped).toBe(1);
    expect(closed).toBe(1);
    expect(area.value).toBe('typed');
    expect(card.classList.contains('pt-listening')).toBe(false);
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });

  it('says what a click does: Talk, then Stop talking, with the key', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    expect(mic.title).toBe('Talk (F2)');
    expect(mic.getAttribute('aria-label')).toBe('Talk');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    expect(mic.title).toBe('Stop talking (F2)');
    expect(mic.getAttribute('aria-label')).toBe('Stop talking');
    tap(mic);
    expect(mic.title).toBe('Talk (F2)');
  });

  it('holding the button is not a gesture: a press and release on it alone neither starts nor stops', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    press(mic, 'pointerdown');
    now += 900;
    press(mic, 'pointerup');
    await new Promise(r => setTimeout(r, 20));
    expect(v.listening()).toBe(false);
    expect(recs).toHaveLength(0);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    press(mic, 'pointerdown'); press(mic, 'pointerup');
    expect(v.listening()).toBe(true);
    v.endVoice(false);
  });

  it('a second click while the start is still on its way stops it from ever starting', async () => {
    const v = await load({ on: true });
    (FakeRec as unknown as { available?: () => Promise<string> }).available = () => new Promise(r => setTimeout(() => r('unavailable'), 15));
    try {
      const { card, wrap, area } = field();
      const mic = v.micButton(card, area, () => {});
      wrap.appendChild(mic);
      tap(mic);
      tap(mic);
      await new Promise(r => setTimeout(r, 40));
      expect(v.listening()).toBe(false);
      expect(recs.every(r => !r.started)).toBe(true);
    } finally { delete (FakeRec as unknown as { available?: unknown }).available; }
  });

  it('toggleVoice (what F2 in the field calls) starts and stops the same way', async () => {
    const v = await load({ on: true });
    const { card, area } = field();
    v.toggleVoice(card, area, () => {});
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    recs[0].onresult?.({ results: [Object.assign([{ transcript: 'one menu' }], { isFinal: true })] });
    v.toggleVoice(card, area, () => {});
    expect(v.listening()).toBe(false);
    expect(area.value).toBe('typed one menu');
  });

  it('Escape cancels and discards what was heard', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    recs[0].onresult?.({ results: [Object.assign([{ transcript: 'hello there' }], { isFinal: true })] });
    expect(area.value).toBe('typed hello there');
    expect([...card.querySelectorAll('.pt-w')].map(w => w.firstChild?.textContent)).toEqual(['hello', 'there']);
    v.endVoice(false);
    expect(area.value).toBe('typed');
    expect(recs[0].aborted).toBe(true);
    expect(v.listening()).toBe(false);
  });

  it('without a second input stream the caret is driven by the recogniser, and listening still works', async () => {
    const v = await load({ on: true });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('busy'));
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    recs[0].onspeechstart?.();
    await vi.waitFor(() => { now += 50; expect(caretSwell(card)).toBeGreaterThan(1.1); });
    expect(tracksStopped).toBe(0);
    tap(mic);
    expect(v.listening()).toBe(false);
  });

  it('a recognition error (the microphone blocked) shows its sentence', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    recs[0].onerror?.({ error: 'not-allowed' });
    recs[0].onend?.();
    expect(v.listening()).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('microphone is blocked'), 'error', undefined, expect.anything());
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the first press while voice is off', () => {
  it('asks once in the field and starts nothing; "Not now" changes nothing', async () => {
    const v = await load({ on: false });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    expect(card.querySelector('.pt-voice-ask')?.textContent).toContain('Turn on voice comments?');
    expect(card.querySelector('.pt-voice-ask')?.textContent).toContain("audio goes to the browser's speech service");
    expect(recs).toHaveLength(0);
    // A second press does not open a second question.
    tap(mic);
    expect(card.querySelectorAll('.pt-voice-ask')).toHaveLength(1);
    const buttons = [...card.querySelectorAll<HTMLButtonElement>('.pt-voice-ask button')];
    expect(buttons.map(b => b.textContent)).toEqual(['Not now', 'Turn on']);
    buttons[0].click();
    expect(card.querySelector('.pt-voice-ask')).toBeNull();
    expect(sendRequest).not.toHaveBeenCalledWith({ type: 'POINT_TELL_VOICE', on: true });
    expect(v.voiceOn()).toBe(false);
  });

  it('"Turn on" stores the setting and starts listening; the next click stops', async () => {
    const v = await load({ on: false });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    expect(recs).toHaveLength(0);
    card.querySelectorAll<HTMLButtonElement>('.pt-voice-ask button')[1].click();
    await vi.waitFor(() => { expect(sendRequest).toHaveBeenCalledWith({ type: 'POINT_TELL_VOICE', on: true }); });
    await vi.waitFor(() => { expect(v.voiceOn()).toBe(true); });
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    tap(mic);
    expect(v.listening()).toBe(false);
  });

  it('when the setting could not be stored it says so and stays off', async () => {
    const v = await load({ on: false });
    sendRequest.mockImplementation(async () => ({ type: 'POINT_TELL_VOICE_DATA', prefs: { on: false, lang: 'auto', noticed: false } }));
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    card.querySelectorAll<HTMLButtonElement>('.pt-voice-ask button')[1].click();
    await vi.waitFor(() => { expect(showToast).toHaveBeenCalledWith(v.VOICE_ON_FAILED, 'error', undefined, expect.anything()); });
    expect(v.voiceOn()).toBe(false);
  });

  it('a question that opened above the text area is closed back to where the field was', async () => {
    const v = await load({ on: false });
    const { card, area } = field();
    card.dataset.restTop = '240';
    v.askVoice(card, area, () => { card.style.top = '116px'; card.dataset.askUp = '1'; });
    expect(v.asking(card)).toBe(true);
    expect(card.style.top).toBe('116px');
    v.closeAsk(card);
    expect(v.asking(card)).toBe(false);
    expect(card.style.top).toBe('240px');
    expect(card.dataset.askUp).toBeUndefined();
  });

  it('the words land one by one, lighter until they are final; a revised word changes in place', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    const say = (...r: Array<[string, boolean]>) => recs[0].onresult?.({ results: r.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
    const words = () => [...card.querySelectorAll<HTMLElement>('.pt-w')];
    say(['make the Export button a venue', false]);
    const texts = () => words().map(w => w.firstChild?.textContent);
    expect(texts()).toEqual(['make', 'the', 'Export', 'button', 'a', 'venue']);
    expect(words().some(w => w.classList.contains('f'))).toBe(false);
    const last = words()[5];
    say(['make the Export button a menu', false]);
    expect(words()).toHaveLength(6);
    expect(words()[5]).toBe(last);
    expect(last.dataset.w).toBe('menu');
    expect(last.firstChild?.textContent).toBe('menu');
    expect(area.value).toBe('typed make the Export button a menu');
    say(['make the Export button a menu', true], [' and keep it', false]);
    expect(words().filter(w => w.classList.contains('f'))).toHaveLength(6);
    expect(texts()).toEqual(['make', 'the', 'Export', 'button', 'a', 'menu', 'and', 'keep', 'it']);
    expect(words()[6].classList.contains('f')).toBe(false);
    // The layer keeps the typed words in front of the dictation, in the same flow.
    expect(card.querySelector('.pt-vw-base')?.textContent).toBe('typed');
    v.endVoice(false);
  });

  it('letting go keeps exactly what the recogniser gave, with the cursor after it', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    recs[0].onresult?.({ results: [Object.assign([{ transcript: 'one menu' }], { isFinal: true }), Object.assign([{ transcript: ' instead of two' }], { isFinal: false })] });
    tap(mic);
    expect(area.value).toBe('typed one menu instead of two');
    expect(area.readOnly).toBe(false);
    expect(area.selectionStart).toBe(area.value.length);
    expect(area.selectionEnd).toBe(area.value.length);
    await vi.waitFor(() => { expect(card.querySelector('.pt-voice')).toBeNull(); });
  });

  it('a small listener comes out while listening and is gone after, and the field keeps its place', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    const host = card.parentElement?.querySelector<HTMLElement>('.pt-listener');
    expect(host).not.toBeNull();
    expect(host?.querySelectorAll('.mk-body')).toHaveLength(1);
    expect(host?.querySelector('.pt-mascot')?.getAttribute('data-b')).toBe('up');
    expect(host?.style.position).toBe('absolute');
    tap(mic);
    await vi.waitFor(() => { expect(card.parentElement?.querySelector('.pt-listener')).toBeNull(); }, { timeout: 3000 });
  });

  it('nothing heard: the sentence is said, and the listener looks puzzled before it leaves', async () => {
    const v = await load({ on: true });
    const { card, wrap, area } = field();
    const mic = v.micButton(card, area, () => {});
    wrap.appendChild(mic);
    tap(mic);
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    tap(mic);
    expect(showToast).toHaveBeenCalledWith('No speech was recognised. Check the microphone and try again.', 'info', undefined, expect.anything());
    expect(card.parentElement?.querySelector('.pt-listener .pt-mascot')?.getAttribute('data-b')).toBe('ask');
    expect(area.value).toBe('typed');
  });
});

describe('a still press on the page (the draw tool)', () => {
  const at = { x: 300, y: 200, cx: 300, cy: 200, alt: false, shift: false, t: 0, pressure: 0.5, type: 'mouse' };
  async function tool(on: boolean) {
    const v = await load({ on });
    const { pt } = await import('../state');
    const { drawTool } = await import('../draw-tool');
    pt.phase = 'ready'; pt.tool = 'pen';
    pt.layer = document.createElement('div'); document.body.appendChild(pt.layer);
    pt.scene = { targets: [], pills: [], model: { pageId: 'p', nodes: [] } } as unknown as typeof pt.scene;
    const opened: string[][] = [];
    // The real openFor opens the note field (openNew, then render); here a field stands in for it.
    const t = drawTool(ids => { opened.push(ids); pt.fieldEl = field().card; });
    return { v, pt, t, opened };
  }

  it('with voice comments off: not holdable, nothing opens and nothing asks for the microphone', async () => {
    const { t, opened } = await tool(false);
    expect(t.holdable?.(at)).toBe(false);
    expect(t.holdStart?.(at)).toBe(false);
    expect(opened).toHaveLength(0);
    expect(recs).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('with voice comments on: a note opens at the point, listens, and keeps the words when let go', async () => {
    const { v, pt, t, opened } = await tool(true);
    expect(t.holdable?.(at)).toBe(true);
    expect(t.holdStart?.(at)).toBe(true);
    expect(opened).toEqual([[]]); // nothing under the point: a note on the page
    await vi.waitFor(() => { expect(v.listening()).toBe(true); });
    expect(pt.fieldEl?.classList.contains('pt-listening')).toBe(true);
    recs[0].onresult?.({ results: [Object.assign([{ transcript: 'make this a menu' }], { isFinal: true })] });
    t.holdEnd?.();
    expect(v.listening()).toBe(false);
    expect(pt.fieldEl?.querySelector('textarea')?.value).toBe('typed make this a menu');
  });

  it('the eraser never starts voice', async () => {
    const { pt, t } = await tool(true);
    pt.tool = 'eraser';
    expect(t.holdable?.(at)).toBe(false);
  });
});
