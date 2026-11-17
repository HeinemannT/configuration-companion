/**
 * Tests for small UI-side helpers introduced in this session.
 *
 * A pure function with security implications:
 *   - isInsecureUrl drives the inline HTTP-downgrade warning
 *
 * Pure functions are cheap to test and the cost of a regression is high
 * (silent http password posting), so it
 * earns dedicated coverage.
 */
import { describe, it, expect } from 'vitest';
import { isInsecureUrl } from '../tabs/connect-tab';

describe('isInsecureUrl (HTTP downgrade warning trigger)', () => {
  it('returns true for explicit http://', () => {
    expect(isInsecureUrl('http://bmp.example.com/Steadfast')).toBe(true);
    expect(isInsecureUrl('http://localhost:8080')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isInsecureUrl('HTTP://example.com')).toBe(true);
    expect(isInsecureUrl('Http://example.com')).toBe(true);
  });

  it('tolerates leading whitespace (paste artifacts)', () => {
    expect(isInsecureUrl('  http://example.com')).toBe(true);
  });

  it('returns false for https://', () => {
    expect(isInsecureUrl('https://example.com')).toBe(false);
  });

  it('returns false for bare hostnames', () => {
    // normalizeUrl() upgrades these to https:// before any request goes
    // out, so the warning would be misleading. Explicit downgrade only.
    expect(isInsecureUrl('example.com/Steadfast')).toBe(false);
    expect(isInsecureUrl('bmp.example.com')).toBe(false);
  });

  it('returns false for empty / whitespace input', () => {
    expect(isInsecureUrl('')).toBe(false);
    expect(isInsecureUrl('   ')).toBe(false);
  });

  it('rejects "httpsmuggled.com" — not a false positive on http* prefix', () => {
    // Without the `://` boundary the regex would match "httpsmuggled" → wrong.
    expect(isInsecureUrl('httpsmuggled.com')).toBe(false);
  });
});
