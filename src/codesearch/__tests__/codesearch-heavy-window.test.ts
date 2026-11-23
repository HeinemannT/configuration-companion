// @vitest-environment happy-dom
/**
 * The code search window asks before a broad search reads the server, and
 * not when the answer comes from a copy, the place was read lately, or the
 * user turned the note off.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Msg = { type: string; [k: string]: unknown };
const sent: Msg[] = [];
const store: Record<string, unknown> = {};
const state = 'none';
const ENV = 'p1@https://bmp.test/W/';

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await frame(); } };
const starts = () => sent.filter(m => m.type === 'CODE_SEARCH_START');
const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) => [...document.querySelectorAll('.rp-dlg button')].find(b => b.textContent === label) as HTMLButtonElement;
function ask(text: string): void {
  const q = document.querySelector<HTMLInputElement>('.cs-q')!;
  q.value = text;
  q.dispatchEvent(new Event('input'));
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="search-root"></div>';
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => { Object.assign(store, o); } } },
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: { addListener: () => undefined },
      sendMessage: vi.fn(async (m: Msg) => {
        sent.push(m);
        if (m.type === 'CODE_INDEX_GET_STATUS') return { type: 'CODE_INDEX_STATUS', status: { environment: ENV, state, syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 0 } };
        if (m.type === 'GET_CONNECTION_STATE') return { type: 'CONNECTION_STATE', state: { display: 'connected', environment: ENV } };
        if (m.type === 'CODE_SEARCH_ROOTS') return { type: 'CODE_SEARCH_ROOTS_RESULT', ok: true, roots: [], orgs: {} };
        if (m.type === 'CODE_SEARCH_STATUS') return { type: 'CODE_SEARCH_STATUS_RESULT', id: m.id, running: true };
        return undefined;
      }),
    },
  };
  await import('../codesearch');
  await settle();
});

describe('the note before a broad server read', () => {
  it('asks first and sends nothing on Choose a place; the Where menu opens', async () => {
    ask('today');
    await settle();
    expect(dialog()).not.toBeNull();
    expect(starts()).toHaveLength(0);
    expect(document.activeElement).toBe(button('Search'));
    button('Choose a place').click();
    await settle();
    expect(dialog()).toBeNull();
    expect(starts()).toHaveLength(0);
    expect(document.querySelector('#cs-menu-where')).not.toBeNull();
  });

  it('Escape is Cancel: nothing is sent', async () => {
    ask('today');
    await settle();
    expect(dialog()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(dialog()).toBeNull();
    expect(starts()).toHaveLength(0);
  });

  it('searches after Search, and the checkbox turns the note off for good', async () => {
    ask('today');
    await settle();
    (document.getElementById('cs-heavy-mute') as HTMLInputElement).checked = true;
    button('Search').click();
    await settle();
    expect(dialog()).toBeNull();
    expect(starts()).toHaveLength(1);
    expect(store['crev-code-search-skip-server-note']).toBe(true);
  });

  it('does not ask again for the same places', async () => {
    ask('tomorrow');
    await settle();
    expect(dialog()).toBeNull();
    expect(starts()).toHaveLength(2);
  });
});
