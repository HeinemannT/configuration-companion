// @vitest-environment happy-dom
/**
 * Clearing a filter menu of the code search window: "Everywhere" unticks
 * every place, a "Clear" in the menu's heading row shows while something is
 * ticked, and the chip itself carries a × (and takes Backspace/Delete).
 * Clearing keeps the menu open with its typed filter text.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Msg = { type: string; [k: string]: unknown };

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); await frame(); } };

/** Twelve roots (the menu gets its filter field from eleven rows on). */
const ROOTS = [
  { key: 'templates', name: 'Template category' },
  ...Array.from({ length: 10 }, (_, i) => ({ key: `r${i}`, name: `Root ${i}` })),
  { key: 'organisation', name: 'Organisation' },
];

beforeAll(async () => {
  document.body.innerHTML = '<div id="search-root"></div>';
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: { addListener: () => undefined },
      sendMessage: vi.fn(async (m: Msg) => {
        if (m.type === 'CODE_INDEX_SYNC' || m.type === 'CODE_INDEX_GET_STATUS') {
          return { type: 'CODE_INDEX_STATUS', status: { environment: 'p1@https://bmp.test/W/', state: 'none', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 0 } };
        }
        if (m.type === 'GET_CONNECTION_STATE') return { type: 'CONNECTION_STATE', state: { display: 'connected', environment: 'p1@https://bmp.test/W/' } };
        if (m.type === 'CODE_SEARCH_ROOTS') return { type: 'CODE_SEARCH_ROOTS_RESULT', ok: true, roots: ROOTS, orgs: {} };
        return undefined;
      }),
    },
  };
  await import('../codesearch');
  await settle();
});

const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s);
const trig = () => q<HTMLButtonElement>('[data-fk="trig-where"]')!;
const item = (key: string) => q<HTMLButtonElement>(`[data-fk="where:${key}"]`);
const checked = () => [...document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')].map(e => (e as HTMLElement).dataset.fk);

describe('the whole-word toggle', () => {
  it('draws "ab" over a word-edge bracket in currentColor, named "Match whole word", in both states', () => {
    const b = q<HTMLButtonElement>('.cs-tg[aria-label="Match whole word"]')!;
    expect(b).not.toBeNull();
    const svg = b.querySelector('svg.cs-tg-ww')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('text')?.textContent).toBe('ab');
    expect(svg.querySelector('text')?.getAttribute('fill')).toBe('currentColor');
    const bracket = svg.querySelector('path')!;
    expect(bracket.getAttribute('stroke')).toBe('currentColor');
    expect(bracket.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+v[\d.]+h[\d.]+V[\d.]+$/);
    // No loose "ab" text beside the mark.
    expect([...b.childNodes].filter(n => n.nodeType === Node.TEXT_NODE)).toHaveLength(0);
    b.click();
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.querySelector('svg.cs-tg-ww')).toBe(svg);
    b.click();
    expect(b.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('clearing the Where filter', () => {
  it('"Everywhere" unticks every place and is ticked when nothing else is', async () => {
    // The default: the configuration roots, all ticked.
    expect(trig().textContent).toContain('Configuration roots');
    trig().click();
    await settle();
    expect(item('root:templates')!.getAttribute('aria-checked')).toBe('true');
    expect(item('')!.getAttribute('aria-checked')).toBe('false');
    // No index and no results yet: the places carry no number.
    expect(document.querySelectorAll('.cs-menu [data-fk^="where:root:"] .ui-id')).toHaveLength(0);
    expect(item('root:templates')!.getAttribute('aria-label')).toBe('Template category');
    item('')!.click();
    await settle();
    expect(checked()).toEqual(['where:']);
    expect(trig().textContent).toContain('Everywhere');
    // The menu stays open; nothing ticked: no Clear, no × on the chip.
    expect(q('.cs-menu')).not.toBeNull();
    expect(q('.cs-mclear')).toBeNull();
    expect(q('.cs-chip-x')).toBeNull();
  });

  it('"Clear" in the heading row shows while a place is ticked; clearing keeps the menu and its filter text', async () => {
    item('root:templates')!.click();
    await settle();
    expect(checked()).toEqual(['where:root:templates']);
    expect(q('.cs-mh-row .cs-mclear')?.textContent).toBe('Clear');
    const f = q<HTMLInputElement>('.cs-mf')!;
    f.value = 'Root';
    f.dispatchEvent(new Event('input'));
    await settle();
    item('root:r1')!.click();
    await settle();
    expect(checked()).toEqual(['where:root:r1']);
    expect(trig().textContent).toContain('Where: Template category +1');
    q<HTMLButtonElement>('.cs-mclear')!.click();
    await settle();
    expect(checked()).toEqual([]);
    expect(q('.cs-menu')).not.toBeNull();
    expect(q<HTMLInputElement>('.cs-mf')!.value).toBe('Root');
    expect(q('.cs-mclear')).toBeNull();
    expect(trig().textContent).toContain('Everywhere');
    // Escape closes the menu.
    q('.cs-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(q('.cs-menu')).toBeNull();
  });

  it('the chip\'s × clears without opening the menu; Backspace and Delete on the chip do the same', async () => {
    // Tick a place, then close the menu.
    trig().click();
    await settle();
    item('root:r2')!.click();
    await settle();
    q('.cs-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    const x = q<HTMLButtonElement>('.cs-chip-x')!;
    expect(x.getAttribute('aria-label')).toBe('Clear the Where filter');
    x.click();
    await settle();
    expect(q('.cs-menu')).toBeNull();
    expect(trig().textContent).toContain('Everywhere');
    expect(q('.cs-chip-x')).toBeNull();
    expect(document.activeElement).toBe(trig());

    for (const key of ['Backspace', 'Delete']) {
      trig().click();
      await settle();
      item('root:r3')!.click();
      await settle();
      q('.cs-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(trig().textContent).toContain('Root 3');
      trig().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await settle();
      expect(trig().textContent, key).toContain('Everywhere');
      expect(document.activeElement).toBe(trig());
    }
  });
});
