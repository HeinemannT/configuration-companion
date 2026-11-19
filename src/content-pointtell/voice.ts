/**
 * Point and tell: voice comments. While the comment field is open, hold F2 (or press the small microphone) and
 * speak; the words go into the field and nowhere else, and the user still saves with Enter. Interim words show
 * under the field in a lighter tone and become text when they are final. Escape while listening only cancels
 * the listening.
 *
 * It uses the browser's speech recognition from the page the extension is on, so the microphone permission is
 * the site's own (Chrome asks once). Recognition runs on the device when the browser has the language
 * installed; otherwise the browser's speech service does it, and the first use says so in one line. Off until
 * the user turns it on in the extension's settings (Voice comments).
 */
import { sendRequest } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import { showToast } from '../lib/toast';
import { NOTHING_HEARD, VOICE_HOLD_KEY, joinSpoken, langFor, readVoicePrefs, voiceErrorLine, voiceNotice, type VoicePrefs } from '../lib/point-tell/voice';
import { ICON_MIC } from '../lib/icons';
import { listenPose } from './mascot';

interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally?: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
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

/** Whether the microphone is offered: the setting is on and the browser can recognise speech. */
export const voiceOffered = (): boolean => prefs.on && ctor() !== null;

interface Session { rec: RecognitionLike; area: HTMLTextAreaElement; card: HTMLElement; ghost: HTMLElement; base: string; interim: string; heard: boolean; told: boolean }
let session: Session | null = null;

export const listening = (): boolean => session !== null;

function paint(s: Session | null, on: boolean): void {
  if (!s) return;
  s.card.classList.toggle('pt-listening', on);
  s.area.readOnly = on;
  s.card.querySelector('.pt-mic')?.setAttribute('aria-pressed', String(on));
  const r = s.card.getBoundingClientRect();
  listenPose(on, r.left + r.width / 2, r.top + r.height / 2);
}

function setGhost(s: Session, text: string): void {
  s.interim = text;
  s.ghost.textContent = text;
  s.ghost.hidden = !text;
}

/** Start listening into `area`. */
export async function startVoice(card: HTMLElement, area: HTMLTextAreaElement, ghost: HTMLElement): Promise<void> {
  const C = ctor();
  if (session || !C || !prefs.on) return;
  const rec = new C();
  const lang = langFor(prefs, navigator.language || 'en');
  rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  let onDevice = false;
  try {
    if (C.available && (await C.available({ langs: [lang], processLocally: true })) === 'available') { rec.processLocally = true; onDevice = true; }
  } catch { /* the cloud service then */ }
  if (session) return;
  const s: Session = { rec, area, card, ghost, base: area.value, interim: '', heard: false, told: false };
  session = s;
  rec.onresult = (e) => {
    const finals: string[] = [], heard: string[] = [];
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      (r.isFinal ? finals : heard).push(r[0].transcript);
    }
    const j = joinSpoken(s.base, finals, heard.join(' '));
    if (j.text !== s.base || j.interim) s.heard = true;
    area.value = j.text;
    setGhost(s, j.interim);
  };
  rec.onerror = (e) => { const line = voiceErrorLine(e.error); if (line) { s.told = true; showToast(line, 'error', undefined, { key: 'crev-pt-voice' }); } };
  rec.onend = () => { if (session === s) endVoice(true); };
  try { rec.start(); } catch { session = null; return; }
  paint(s, true);
  if (!prefs.noticed) {
    prefs = { ...prefs, noticed: true };
    showToast(voiceNotice(onDevice), 'info', undefined, { key: 'crev-pt-voice' });
    void sendRequest({ type: 'POINT_TELL_VOICE', noticed: true }).catch(() => {});
  }
}

/** Stop listening. `keep`: what was heard stays in the field (also the phrase still being heard); else the field is put back. */
export function endVoice(keep: boolean): void {
  const s = session;
  if (!s) return;
  session = null;
  try { s.rec.onend = null; s.rec.onresult = null; keep ? s.rec.stop() : s.rec.abort(); } catch { /* already over */ }
  if (keep) { const j = joinSpoken(s.area.value, [s.interim], ''); s.area.value = j.text; } else s.area.value = s.base;
  // Listening that ended with nothing heard says so, so it never looks like a dead button.
  if (keep && !s.heard && !s.told && !s.interim.trim()) showToast(NOTHING_HEARD, 'info', undefined, { key: 'crev-pt-voice' });
  setGhost(s, '');
  paint(s, false);
}

/** The microphone button for the field. */
export function micButton(onToggle: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pt-mic';
  b.innerHTML = ICON_MIC;
  b.title = `Speak (hold ${VOICE_HOLD_KEY})`; b.setAttribute('aria-label', 'Speak'); b.setAttribute('aria-pressed', 'false');
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  return b;
}
