// @vitest-environment happy-dom
/**
 * The note before a broad search that reads the server: which searches get
 * it, when it is skipped, and how it is answered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askHeavySearch, heavyCopy, isBroadPlace, loadMuted, needsWarning, placeKey, ReadPlaces, saveMuted } from '../heavy-search';
import type { EscapeLayer } from '../../lib/escape-layers';

describe('which places are broad', () => {
  const none = { scope: false, where: [], defaultWhere: false };
  it('treats everywhere, the default roots, the organisation root and three places as broad', () => {
    expect(isBroadPlace(none)).toBe(true);
    expect(isBroadPlace({ ...none, where: ['root:a', 'root:b'], defaultWhere: true })).toBe(true);
    expect(isBroadPlace({ ...none, where: ['root:organisation'] })).toBe(true);
    expect(isBroadPlace({ ...none, where: ['root:a', 'root:b', 'root:c'] })).toBe(true);
  });
  it('leaves Under an object and one or two places alone', () => {
    expect(isBroadPlace({ ...none, scope: true })).toBe(false);
    expect(isBroadPlace({ ...none, scope: true, defaultWhere: true })).toBe(false);
    expect(isBroadPlace({ ...none, where: ['root:a'] })).toBe(false);
    expect(isBroadPlace({ ...none, where: ['root:a', 'org:1'] })).toBe(false);
  });
});

describe('when to ask', () => {
  const base = { readsServer: true, broad: true, readLately: false, muted: false };
  it('asks only for a broad search that reads the server, not read lately, not muted', () => {
    expect(needsWarning(base)).toBe(true);
    expect(needsWarning({ ...base, readsServer: false })).toBe(false);
    expect(needsWarning({ ...base, broad: false })).toBe(false);
    expect(needsWarning({ ...base, readLately: true })).toBe(false);
    expect(needsWarning({ ...base, muted: true })).toBe(false);
  });
  it('counts a place as read for as long as the worker keeps its code', () => {
    const p = new ReadPlaces(1000);
    const k = placeKey('p@s', ['root:b', 'root:a']);
    expect(k).toBe(placeKey('p@s', ['root:a', 'root:b']));
    expect(p.recent(k, 0)).toBe(false);
    p.note(k, 0);
    expect(p.recent(k, 999)).toBe(true);
    expect(p.recent(k, 1000)).toBe(false);
    expect(p.recent(placeKey('other@s', ['root:a', 'root:b']), 1)).toBe(false);
  });
});

describe('the answer is kept in storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('reads and writes one flag, and asks again when storage fails', async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: { get: async (k: string) => ({ [k]: data[k] }), set: async (o: Record<string, unknown>) => { Object.assign(data, o); } } } });
    expect(await loadMuted()).toBe(false);
    await saveMuted(true);
    expect(await loadMuted()).toBe(true);
    vi.stubGlobal('chrome', { storage: { local: { get: async () => { throw new Error('blocked'); }, set: async () => { throw new Error('blocked'); } } } });
    expect(await loadMuted()).toBe(false);
    await expect(saveMuted(true)).resolves.toBeUndefined();
  });
});

describe('the dialog', () => {
  function open(canCopy = true) {
    document.body.innerHTML = '<div class="cs"></div>';
    let layer: EscapeLayer | undefined;
    const unregister = vi.fn();
    const result = askHeavySearch({ parent: () => document.querySelector('.cs') as HTMLElement, escape: l => { layer = l; return unregister; } }, { canCopy });
    return { result, layer: () => layer!, unregister };
  }
  const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement;

  it('says how the search works, in a modal with focus on Search', () => {
    open();
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.textContent).toContain('keeps what it read for 20 minutes');
    expect(dlg.textContent).toContain('Under an object');
    expect(document.activeElement).toBe(button('Search'));
  });
  it('does not offer a copy on a server that cannot keep one', () => {
    open(false);
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('copy on this computer');
    expect(heavyCopy(true).paragraphs.join(' ')).toContain('copy on this computer');
  });
  it('searches on Search, with the checkbox state', async () => {
    const { result, unregister } = open();
    (document.getElementById('cs-heavy-mute') as HTMLInputElement).checked = true;
    button('Search').click();
    expect(await result).toEqual({ choice: 'search', dontAsk: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(unregister).toHaveBeenCalled();
  });
  it('cancels on Cancel and on Escape, and leaves to the place menu on Choose a place', async () => {
    const a = open();
    button('Cancel').click();
    expect((await a.result).choice).toBe('cancel');
    const b = open();
    expect(b.layer().kind).toBe('dialog');
    expect(b.layer().isOpen()).toBe(true);
    b.layer().close(null);
    expect((await b.result).choice).toBe('cancel');
    expect(b.layer().isOpen()).toBe(false);
    const c = open();
    button('Choose a place').click();
    expect((await c.result).choice).toBe('narrow');
  });
  it('stays open when the backdrop is clicked', () => {
    open();
    (document.querySelector('.rp-scrim') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
