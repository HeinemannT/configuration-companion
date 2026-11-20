/**
 * Point and tell: voice comments, the pure part. What is stored (off by default), which language is
 * spoken, how the recognised words join the text already in the field, and the one line shown for each
 * way recognition can fail. The browser's speech recognition itself is in content-pointtell/voice.
 */
export const VOICE_KEY = 'crev_pt_voice';
/** In an open comment field: start listening, and press again to stop. A function key does not type and does not scroll. */
export const VOICE_TOGGLE_KEY = 'F2';
/** What the microphone in the field does when pressed: start, or (while listening) stop. */
export const micLabel = (listening: boolean): string => (listening ? 'Stop talking' : 'Talk');

export type VoiceLang = 'en-US' | 'de-DE';
export interface VoicePrefs {
  /** Off until the user turns it on in the extension's settings. */
  on: boolean;
  /** 'auto' follows the browser's language. */
  lang: 'auto' | VoiceLang;
  /** The first-use line about where the audio goes was shown. */
  noticed: boolean;
}

export const VOICE_DEFAULTS: VoicePrefs = { on: false, lang: 'auto', noticed: false };

export function readVoicePrefs(raw: unknown): VoicePrefs {
  if (typeof raw !== 'object' || raw === null) return { ...VOICE_DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    on: r.on === true,
    lang: r.lang === 'en-US' || r.lang === 'de-DE' ? r.lang : 'auto',
    noticed: r.noticed === true,
  };
}

/** The language to listen for: the chosen one, else German for a German browser, else English. */
export function langFor(prefs: VoicePrefs, uiLanguage: string): VoiceLang {
  if (prefs.lang !== 'auto') return prefs.lang;
  return /^de\b/i.test(uiLanguage) ? 'de-DE' : 'en-US';
}

/** The words so far: what was in the field, then each finished phrase; the phrase still being heard is returned apart. */
export function joinSpoken(base: string, finals: string[], interim: string): { text: string; interim: string } {
  let text = base;
  for (const f of finals) {
    const w = f.trim();
    if (!w) continue;
    text = text && !/\s$/.test(text) ? `${text} ${w}` : `${text}${w}`;
  }
  return { text, interim: interim.trim() };
}

/** Said when listening ended and no word came through (a silent room, a muted microphone, a service that answered with nothing). */
export const NOTHING_HEARD = 'No speech was recognised. Check the microphone and try again.';

/** The line for a recognition error; null when nothing needs saying. */
export function voiceErrorLine(code: string): string | null {
  switch (code) {
    case 'aborted': return null;
    case 'no-speech': return NOTHING_HEARD;
    case 'not-allowed': case 'service-not-allowed': return 'The microphone is blocked for this site. Allow it in the browser\'s site settings.';
    case 'audio-capture': return 'No microphone was found.';
    case 'language-not-supported': return 'This language is not available for voice.';
    case 'network': return 'The speech service could not be reached.';
    default: return `Voice stopped (${code}).`;
  }
}

/** The one line said before the first use: where the audio goes. */
export const voiceNotice = (onDevice: boolean): string =>
  (onDevice ? 'Speech is turned into text on this device.' : 'Your voice is sent to the browser\'s speech service to become text.');
