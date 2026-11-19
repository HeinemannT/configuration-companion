import { describe, expect, it } from 'vitest';
import { NOTHING_HEARD, joinSpoken, langFor, readVoicePrefs, voiceErrorLine, voiceNotice } from '../voice';

describe('voice comments, the pure part', () => {
  it('is off until turned on, and ignores rubbish', () => {
    expect(readVoicePrefs(undefined)).toEqual({ on: false, lang: 'auto', noticed: false });
    expect(readVoicePrefs({ on: 'yes', lang: 'fr-FR' })).toEqual({ on: false, lang: 'auto', noticed: false });
    expect(readVoicePrefs({ on: true, lang: 'de-DE', noticed: true })).toEqual({ on: true, lang: 'de-DE', noticed: true });
  });
  it('follows the browser language unless one was chosen', () => {
    const auto = readVoicePrefs({ on: true });
    expect(langFor(auto, 'de')).toBe('de-DE');
    expect(langFor(auto, 'de-AT')).toBe('de-DE');
    expect(langFor(auto, 'en-GB')).toBe('en-US');
    expect(langFor(auto, 'fr')).toBe('en-US');
    expect(langFor({ ...auto, lang: 'en-US' }, 'de')).toBe('en-US');
  });
  it('joins spoken phrases to what was typed, and keeps the phrase being heard apart', () => {
    expect(joinSpoken('Make this', [' wider ', 'and red'], ' by half')).toEqual({ text: 'Make this wider and red', interim: 'by half' });
    expect(joinSpoken('', ['hello'], '')).toEqual({ text: 'hello', interim: '' });
    expect(joinSpoken('line\n', ['next'], '')).toEqual({ text: 'line\nnext', interim: '' });
  });
  it('says nothing for silence or a cancel, and one plain line for the rest', () => {
    expect(voiceErrorLine('no-speech')).toBe(NOTHING_HEARD);
    expect(voiceErrorLine('aborted')).toBeNull();
    expect(voiceErrorLine('not-allowed')).toMatch(/blocked/);
    expect(voiceErrorLine('network')).toMatch(/speech service/);
  });
  it('says where the audio goes', () => {
    expect(voiceNotice(true)).toMatch(/on this device/);
    expect(voiceNotice(false)).toMatch(/sent to the browser/);
  });
});
