import { describe, expect, it } from 'vitest';
import { DESKTOP_MIN_VERSION, needsUpdate, type StatusResult } from '../../claude-link';
import { chatWaiting, factLines, getButton, setupState, statusView } from '../desktop-setup';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const ok = (over: Partial<Extract<StatusResult, { ok: true }>> = {}): StatusResult => ({ ok: true, port: 47615, rev: 0, agent: 'none', sketches: [], ...over });

describe('the Claude Desktop page', () => {
  it('looks first, then says not found when nothing answers', () => {
    expect(setupState(undefined)).toEqual({ kind: 'checking' });
    expect(statusView(setupState(undefined)).dot).toBe('idle');
    const none = setupState({ ok: false });
    expect(none).toEqual({ kind: 'none' });
    expect(statusView(none).text).toBe('Claude Desktop not found');
    expect(getButton(none)).toEqual({ label: 'Get the extension', primary: true });
    expect(chatWaiting(none)).toBe(false);
    expect(factLines(none)).toEqual([]);
  });

  it('shows the connected version, the copies that answered, the chat and the settings', () => {
    const s = setupState(ok({
      version: '0.3.0', caps: ['key', 'config'], configRev: 2026112001, wait: 45,
      answered: [{ port: 47616, version: '0.3.0' }, { port: 47615, version: '0.2.5' }],
      copies: [{ waiting: 1, beatAt: iso(2000), lastCallAt: iso(2000), alive: true }],
    }), NOW);
    expect(s).toMatchObject({ kind: 'connected', version: '0.3.0', update: false, taking: true, configRev: 2026112001 });
    expect(statusView(s)).toEqual({ dot: 'ok', text: 'Connected', version: '0.3.0' });
    expect(getButton(s)).toEqual({ label: 'Get the extension', primary: false });
    expect(chatWaiting(s)).toBe(true);
    expect(factLines(s)).toEqual([
      '2 copies answered: 0.3.0 on port 47616, 0.2.5 on port 47615',
      'A chat is taking sketches',
      'Settings from Companion: 2026112001',
    ]);
  });

  it('does not ask for an update when the installed one works, even when this build ships a newer one', () => {
    const s = setupState(ok({ version: '0.2.5' }), NOW);
    expect(s).toMatchObject({ kind: 'connected', update: false });
    expect(statusView(s).text).toBe('Connected');
    expect(getButton(s).label).toBe('Get the extension');
    // No settings line for a desktop extension that takes none.
    expect(factLines(s)).toEqual(['One copy answered: 0.2.5 on port 47615', 'No chat is taking sketches']);
  });

  it('offers Update below the minimum, also for one too old to name its version', () => {
    for (const res of [ok({ version: '0.2.1' }), ok()]) {
      const s = setupState(res, NOW);
      expect(s).toMatchObject({ kind: 'connected', update: true });
      expect(statusView(s)).toMatchObject({ dot: 'warn', text: 'Older version connected' });
      expect(getButton(s)).toEqual({ label: 'Update', primary: true });
    }
  });

  it('the minimum rule: below it, or a needed capability missing', () => {
    expect(DESKTOP_MIN_VERSION).toBe('0.2.2');
    expect(needsUpdate('0.2.2')).toBe(false);
    expect(needsUpdate('0.2.5')).toBe(false);
    expect(needsUpdate('0.2.1')).toBe(true);
    expect(needsUpdate(undefined)).toBe(true);
    expect(needsUpdate('0.2.5', [], ['requeue'])).toBe(true);
    expect(needsUpdate('0.3.0', ['requeue'], ['requeue'])).toBe(false);
  });

  it('an older listener: a chat takes sketches while one waits or called lately', () => {
    expect(chatWaiting(setupState(ok({ version: '0.2.5', agent: 'waiting' }), NOW))).toBe(true);
    expect(chatWaiting(setupState(ok({ version: '0.2.5', agent: 'recent' }), NOW))).toBe(true);
    expect(chatWaiting(setupState(ok({ version: '0.2.5', agent: 'none' }), NOW))).toBe(false);
  });
});
