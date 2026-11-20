/**
 * Point and tell: voice comments. Two ways in: press on the page and keep still for a moment (pointer.ts, draw-tool.ts)
 * and a note opens there and listens until the press is let go; or, in a comment field already open, click the small
 * microphone (or press F2) to start listening and again to stop. The words go into the field and nowhere else, and
 * the user still saves with Enter. While listening, the words are shown as they are recognised (voice-view.ts: each
 * lands with a small rise, lighter until it is final, a revised word changes in place, a soft caret follows the end)
 * and a small copy of the product's mark rises from behind the field's edge and listens (listener.ts). Escape while
 * listening cancels and discards.
 *
 * It uses the browser's speech recognition from the page the extension is on, so the microphone permission is
 * the site's own (Chrome asks once). Recognition runs on the device when the browser has the language
 * installed; otherwise the browser's speech service does it. The caret and the ripples are driven by the real input
 * level: a second stream of the same microphone (same permission) goes to an analyser beside the recogniser, and is
 * stopped with it. If that stream is not possible, the recogniser's own events drive them instead. The level is read
 * once a frame while listening (requestAnimationFrame); at rest nothing is scheduled. Under reduced motion there is no
 * level at all: the words appear, the listener shows a still pose.
 *
 * The microphone is always in the field; while the setting is off, the first press of it (or of F2) asks once, in
 * the field, whether to turn voice comments on, and says where the audio goes. "Turn on" stores the same setting as
 * Preferences > Voice comments and starts listening. While the setting is off, a still press on the page is a click.
 */
import { sendRequest } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import { showToast } from '../lib/toast';
import { NOTHING_HEARD, VOICE_TOGGLE_KEY, langFor, micLabel, readVoicePrefs, voiceErrorLine, voiceNotice, type VoicePrefs } from '../lib/point-tell/voice';
import { EventLevel, levelOf, rmsOf, smooth } from '../lib/point-tell/voice-level';
import { heardWords, loudNow, phraseEnded, spokenText, type HeardResult, type HeardWord } from '../lib/point-tell/voice-words';
import { ICON_MIC } from '../lib/icons';
import { createListener, type Listener } from './listener';
import { listenPose } from './mascot';
import { reducedMotion } from './motion';
import { createVoiceView, type VoiceView } from './voice-view';

interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally?: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onsoundstart: (() => void) | null; onsoundend: (() => void) | null; onspeechstart: (() => void) | null; onspeechend: (() => void) | null;
}
type RecognitionCtor = (new () => RecognitionLike) & { available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string> };

const ctor = (): RecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

type VoiceData = Extract<InspectorMessage, { type: 'POINT_TELL_VOICE_DATA' }>;
let prefs: VoicePrefs = readVoicePrefs(undefined);

/** Ask the worker for the stored setting (on entering the mode, so a change in the settings counts from the next time). */
export function initVoice(): void {
  void sendRequest<VoiceData>({ type: 'POINT_TELL_VOICE' }).then(r => { if (r?.prefs) prefs = readVoicePrefs(r.prefs); }).catch(() => {});
}

/** Whether the microphone is shown: the browser can recognise speech (whether the setting is on is asked on the first press). */
export const voiceSupported = (): boolean => ctor() !== null;
/** Whether the setting is on. */
export const voiceOn = (): boolean => prefs.on;

/** The one question asked before the first use. It says where the audio goes. */
export const VOICE_ASK = "Turn on voice comments? The browser turns speech into text; unless it does this on the device, the audio goes to the browser's speech service.";
export const VOICE_ON_FAILED = 'Voice comments could not be turned on. Turn them on under Preferences in the side panel.';

/** Store the setting (the same one as Preferences) and say whether it is on now. */
async function turnOn(): Promise<boolean> {
  const r = await sendRequest<VoiceData>({ type: 'POINT_TELL_VOICE', on: true }).catch(() => undefined);
  if (r?.prefs) prefs = readVoicePrefs(r.prefs);
  if (!prefs.on) showToast(VOICE_ON_FAILED, 'error', undefined, { key: 'crev-pt-voice' });
  return prefs.on;
}

/** Whether the question is open in `card`. */
export const asking = (card: HTMLElement): boolean => card.querySelector('.pt-voice-ask') !== null;

export function closeAsk(card: HTMLElement): void {
  card.querySelector('.pt-voice-ask')?.remove();
  // The question opened above the text area: the field goes back to where it was.
  if (card.dataset.askUp) { delete card.dataset.askUp; card.style.top = `${card.dataset.restTop ?? 0}px`; }
}

/** Ask once, in the field, whether to turn voice comments on. "Turn on" stores the setting and starts listening. */
export function askVoice(card: HTMLElement, area: HTMLTextAreaElement, fit: () => void): void {
  if (asking(card) || session) return;
  const box = document.createElement('div');
  box.className = 'pt-voice-ask';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Voice comments');
  const text = document.createElement('div');
  text.className = 'pt-voice-ask-text';
  text.textContent = VOICE_ASK;
  const row = document.createElement('div');
  row.className = 'pt-voice-ask-row';
  const button = (label: string, cls: string, on: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `pt-btn ${cls}`.trim(); b.textContent = label;
    // The text area keeps the focus: the words typed so far and the caret stay where they are.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.stopPropagation(); on(); });
    return b;
  };
  row.append(
    button('Not now', '', () => { closeAsk(card); area.focus({ preventScroll: true }); }),
    button('Turn on', 'pt-primary', () => { closeAsk(card); void turnOn().then(ok => { area.focus({ preventScroll: true }); if (ok && area.isConnected) void startVoice(card, area); }); }),
  );
  box.append(text, row);
  card.appendChild(box);
  fit();
}

// ── Listening ───────────────────────────────────────────────────────────────────────────────────

/** The real input level: a second stream of the same microphone into an analyser. Null when it cannot be had. */
interface Meter { rms(): number; stop(): void }

async function openMeter(): Promise<Meter | null> {
  try {
    const md = navigator.mediaDevices;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!md?.getUserMedia || !AC) return null;
    const stream = await md.getUserMedia({ audio: true });
    const ac = new AC();
    void ac.resume().catch(() => {});
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 512; an.smoothingTimeConstant = 0.3;
    src.connect(an); // not connected on to the speakers: nothing is played back
    const buf = new Uint8Array(an.fftSize);
    return {
      rms: () => { an.getByteTimeDomainData(buf); return rmsOf(buf); },
      stop: () => { stream.getTracks().forEach(t => t.stop()); void ac.close().catch(() => {}); },
    };
  } catch { return null; }
}

interface Session {
  rec: RecognitionLike; area: HTMLTextAreaElement; card: HTMLElement; view: VoiceView; listener: Listener | null;
  /** What the field held before, and every word heard since (final and interim). */
  base: string; words: HeardWord[]; heard: boolean; told: boolean;
  meter: Meter | null; events: EventLevel; level: number; lastLoud: number; lastFrame: number; raf: number; frame: () => void;
}
let session: Session | null = null;
/** Starting is asynchronous; any end of listening makes a start that is still on its way give up. */
let startSeq = 0;
/** A start is on its way (the recogniser is being asked whether it can work on the device): a second press stops it. */
let pending = false;

export const listening = (): boolean => session !== null;

function paint(s: Session, on: boolean): void {
  s.card.classList.toggle('pt-listening', on);
  s.area.readOnly = on;
  const mic = s.card.querySelector<HTMLElement>('.pt-mic');
  if (mic) { mic.setAttribute('aria-pressed', String(on)); mic.title = `${micLabel(on)} (${VOICE_TOGGLE_KEY})`; mic.setAttribute('aria-label', micLabel(on)); }
  const r = s.card.getBoundingClientRect();
  // The dock's mark looks toward the field and stays calm while the small listener is out; with no listener it listens itself.
  listenPose(on, r.left + r.width / 2, r.top + r.height / 2, s.listener !== null);
}

/** The words the recogniser has now: the first alternative of every result, final or still interim, in order. */
function heardNow(e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }): HeardWord[] {
  const results: HeardResult[] = [];
  for (let i = 0; i < e.results.length; i++) {
    const r = e.results[i];
    results.push({ text: r[0]?.transcript ?? '', final: r.isFinal });
  }
  return heardWords(results);
}

/** The result list changed: show what is new, revised or final, and let the listener react. */
function showHeard(s: Session, words: HeardWord[]): void {
  s.words = words;
  if (words.length) s.heard = true;
  s.area.value = spokenText(s.base, words);
  s.area.scrollTop = s.area.scrollHeight;
  const diff = s.view.words(words, s.area.scrollTop);
  s.listener?.gaze(s.view.caretAt());
  if (phraseEnded(diff)) s.listener?.nod();
}

/** One frame while listening: the level, the caret, the ripples. Nothing is scheduled when the listening is over. */
function frame(s: Session): void {
  if (session !== s) return;
  const now = performance.now();
  const raw = s.meter ? levelOf(s.meter.rms()) : s.events.next(Math.random());
  s.level = smooth(s.level, raw, now - s.lastFrame);
  s.lastFrame = now;
  s.view.level(s.level);
  s.listener?.frame(s.level, now);
  if (loudNow(raw, now, s.lastLoud)) { s.lastLoud = now; s.listener?.startle(); }
  s.raf = requestAnimationFrame(s.frame);
}

/** Start listening into `area`. Resolves once listening (or the attempt) is over its first step. */
export async function startVoice(card: HTMLElement, area: HTMLTextAreaElement): Promise<void> {
  const C = ctor();
  if (session || !C || !prefs.on) return;
  const my = ++startSeq;
  const rec = new C();
  const lang = langFor(prefs, navigator.language || 'en');
  rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  let onDevice = false;
  pending = true;
  try {
    if (C.available && (await C.available({ langs: [lang], processLocally: true })) === 'available') { rec.processLocally = true; onDevice = true; }
  } catch { /* the cloud service then */ }
  if (my === startSeq) pending = false;
  if (session || my !== startSeq) return;
  const wrap = card.querySelector<HTMLElement>('.pt-area-wrap');
  if (!wrap) return;
  const view = createVoiceView(wrap);
  const s: Session = { rec, area, card, view, listener: null, base: area.value, words: [], heard: false, told: false, meter: null, events: new EventLevel(), level: 0, lastLoud: -1e9, lastFrame: performance.now(), raf: 0, frame: () => {} };
  s.frame = () => frame(s);
  session = s;
  rec.onresult = (e) => { showHeard(s, heardNow(e)); s.events.event('result'); };
  rec.onsoundstart = () => s.events.event('soundstart');
  rec.onspeechstart = () => s.events.event('speechstart');
  rec.onspeechend = () => { s.events.event('speechend'); if (s.words.length) s.listener?.nod(); };
  rec.onsoundend = () => s.events.event('soundend');
  rec.onerror = (e) => { const line = voiceErrorLine(e.error); if (line) { s.told = true; showToast(line, 'error', undefined, { key: 'crev-pt-voice' }); } };
  rec.onend = () => { if (session === s) endVoice(true); };
  try { rec.start(); } catch { session = null; view.remove(); return; }
  view.begin(s.base);
  if (card.parentElement) s.listener = createListener(card.parentElement, card);
  paint(s, true);
  s.listener?.gaze(view.caretAt());
  if (!reducedMotion()) {
    // The real level, beside the recogniser; until it is there (or when it cannot be had) the recogniser's events drive the caret and the ripples.
    void openMeter().then(m => { if (!m) return; if (session !== s) m.stop(); else s.meter = m; });
    s.raf = requestAnimationFrame(s.frame);
  }
  if (!prefs.noticed) {
    prefs = { ...prefs, noticed: true };
    showToast(voiceNotice(onDevice), 'info', undefined, { key: 'crev-pt-voice' });
    void sendRequest({ type: 'POINT_TELL_VOICE', noticed: true }).catch(() => {});
  }
}

/** Stop listening. `keep`: what was heard stays in the field, with the cursor after it; else the field is put back. */
export function endVoice(keep: boolean): void {
  startSeq++;
  pending = false;
  const s = session;
  if (!s) return;
  session = null;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.meter?.stop(); s.meter = null;
  try { s.rec.onend = null; s.rec.onresult = null; keep ? s.rec.stop() : s.rec.abort(); } catch { /* already over */ }
  const nothing = keep && !s.heard && !s.told;
  s.area.value = keep ? spokenText(s.base, s.words) : s.base;
  // Listening that ended with nothing heard says so, so it never looks like a dead button.
  if (nothing) showToast(NOTHING_HEARD, 'info', undefined, { key: 'crev-pt-voice' });
  s.view.end(keep);
  if (!keep) s.view.discard();
  s.listener?.leave(!keep ? 'discarded' : nothing ? 'nothing' : 'kept');
  paint(s, false);
  if (keep) {
    s.area.focus({ preventScroll: true });
    s.area.setSelectionRange(s.area.value.length, s.area.value.length);
    s.area.scrollTop = s.area.scrollHeight;
  }
  // The layer fades out over the stylesheet's 200 ms, into the words in the field.
  // While the layer fades out the text area's own placeholder waits, so the two never show on top of each other.
  s.card.classList.add('pt-vo');
  window.setTimeout(() => { s.view.remove(); s.card.classList.remove('pt-vo'); }, keep ? 260 : 420);
}

// ── The microphone button: on and off ───────────────────────────────────────────────────────────

/** Start or stop listening into this field (the microphone and F2). While the setting is off it asks first. */
export function toggleVoice(card: HTMLElement, area: HTMLTextAreaElement, fit: () => void): void {
  if (listening() || pending) { endVoice(true); return; }
  if (voiceOn()) void startVoice(card, area); else askVoice(card, area, fit);
}

/** The microphone button for the field: a click starts listening, the next click stops it (the words stay). */
export function micButton(card: HTMLElement, area: HTMLTextAreaElement, fit: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pt-mic';
  b.innerHTML = ICON_MIC;
  b.title = `${micLabel(false)} (${VOICE_TOGGLE_KEY})`; b.setAttribute('aria-label', micLabel(false)); b.setAttribute('aria-keyshortcuts', VOICE_TOGGLE_KEY); b.setAttribute('aria-pressed', 'false');
  // The text area keeps its focus and selection.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.stopPropagation(); toggleVoice(card, area, fit); });
  return b;
}
