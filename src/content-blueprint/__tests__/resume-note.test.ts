import { describe, it, expect } from 'vitest';
import { encodeResume, readResume, appliedMessage } from '../resume-note';

describe('resume note', () => {
  it('round-trips prefer and message within the TTL', () => {
    const raw = encodeResume('instance', 'Blueprint: 3 changes applied.', 1000);
    expect(readResume(raw, 1000 + 29_999)).toEqual({ prefer: 'instance', message: 'Blueprint: 3 changes applied.' });
  });
  it('expires after 30 s and rejects junk', () => {
    expect(readResume(encodeResume('template', 'x', 1000), 31_000)).toBeNull();
    expect(readResume('not json', 1)).toBeNull();
    expect(readResume('{}', 1)).toBeNull();
  });
  it('works without a message (old payload shape)', () => {
    expect(readResume(JSON.stringify({ t: 5 }), 6)).toEqual({ prefer: 'template' });
  });
  it('words the applied count in singular and plural', () => {
    expect(appliedMessage(1)).toBe('Blueprint: 1 change applied.');
    expect(appliedMessage(3)).toBe('Blueprint: 3 changes applied.');
    expect(appliedMessage(undefined)).toBe('Blueprint: changes applied.');
  });
});
