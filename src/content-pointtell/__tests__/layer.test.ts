// @vitest-environment happy-dom
/**
 * The layer's floor: everything Point and tell puts on the page sets its position and stacking inline, so
 * a missing or broken stylesheet cannot drop it into the page flow; a page with no layout gets a sentence
 * and no pointer surface; leaving removes it all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();
const sendFireForget = vi.fn();
vi.mock('../../lib/messaging', () => ({ sendRequest: (...a: unknown[]) => sendRequest(...a), sendFireForget: (...a: unknown[]) => sendFireForget(...a) }));
vi.mock('../../content-blueprint', () => ({ getBlueprintPageRid: () => '7282092580979928955' }));
vi.mock('../../content-blueprint/font-face', () => ({ blueprintFontFaceCss: () => '' }));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('../../content-pointtell.css', () => ({ default: '/* test */' }));
vi.mock('../../styles/mark.css', () => ({ default: '/* mark */' }));

import { fixtureModel } from '../../lib/point-tell/__tests__/fixture';

async function load() {
  vi.resetModules();
  return import('../index');
}
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body><div data-rid="1">x</div></body>';
  sessionStorage.clear();
  sendRequest.mockReset(); sendFireForget.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { getURL: (p: string) => p } };
});

const inlineFloor = (el: HTMLElement | null, position: string) => {
  expect(el, 'element missing').toBeTruthy();
  expect(el!.style.position).toBe(position);
  expect(Number(el!.style.zIndex)).toBeGreaterThan(2147483000);
};

describe('the layer', () => {
  it('is on the document element with its position and stacking inline, before anything loads', async () => {
    sendRequest.mockReturnValue(new Promise(() => { /* the layout never arrives */ }));
    const pt = await load();
    pt.enablePointTell();
    const layer = document.getElementById('crev-pointtell-layer');
    expect(layer?.parentElement).toBe(document.documentElement);
    inlineFloor(layer, 'absolute');
    expect(layer!.style.pointerEvents).toBe('none');
    inlineFloor(layer!.querySelector('.pt-dock'), 'fixed');
    expect(layer!.textContent).toContain('Loading page');
    expect(layer!.querySelector('.pt-surface')).toBeNull();
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'POINT_TELL_STATE', active: true });
  });

  it('with a layout: the pointer surface and the bar are positioned inline too', async () => {
    sendRequest.mockImplementation(async (m: { type: string }) => m.type === 'LAYOUT_LOAD'
      ? { ok: true, env: 'e', ctx: { pageId: 'p', editingTemplate: false }, model: fixtureModel() } : undefined);
    const pt = await load();
    pt.enablePointTell();
    await settle();
    const layer = document.getElementById('crev-pointtell-layer')!;
    const surface = layer.querySelector<HTMLElement>('.pt-surface');
    inlineFloor(surface, 'fixed');
    expect(surface!.style.pointerEvents).toBe('auto');
    inlineFloor(layer.querySelector('.pt-dock'), 'fixed');
    // The dock sits above the surface, the surface above the highlight.
    expect(Number(layer.querySelector<HTMLElement>('.pt-dock')!.style.zIndex)).toBeGreaterThan(Number(surface!.style.zIndex));
    // The ink canvas is positioned inline too, click-through, above the surface and below the badges.
    const ink = layer.querySelector<HTMLCanvasElement>('canvas.pt-ink');
    inlineFloor(ink, 'fixed');
    expect(ink!.style.pointerEvents).toBe('none');
    expect(Number(ink!.style.zIndex)).toBeGreaterThan(Number(surface!.style.zIndex));
  });

  it('a page with no layout: one sentence, no surface that could swallow input', async () => {
    sendRequest.mockResolvedValue({ ok: false, error: 'Not an editable page (no tabset resolved)' });
    const pt = await load();
    pt.enablePointTell();
    await settle();
    const layer = document.getElementById('crev-pointtell-layer')!;
    expect(layer.querySelector('.pt-surface')).toBeNull();
    expect(layer.textContent).toContain('needs the page layout, and this page has none Companion can read');
  });

  it('leaving removes the layer and says so', async () => {
    sendRequest.mockImplementation(async () => ({ ok: true, env: 'e', ctx: { pageId: 'p' }, model: fixtureModel() }));
    const pt = await load();
    pt.enablePointTell();
    await settle();
    pt.disablePointTell();
    expect(document.getElementById('crev-pointtell-layer')).toBeNull();
    expect(document.getElementById('crev-pointtell-style')).toBeNull();
    expect(sendFireForget).toHaveBeenLastCalledWith({ type: 'POINT_TELL_STATE', active: false });
    pt.disablePointTell(); // twice is harmless
    expect(sendFireForget).toHaveBeenCalledTimes(2);
  });

  it('a reply that arrives after leaving changes nothing', async () => {
    let answer: (v: unknown) => void = () => {};
    sendRequest.mockReturnValue(new Promise(r => { answer = r; }));
    const pt = await load();
    pt.enablePointTell();
    pt.disablePointTell();
    answer({ ok: true, env: 'e', ctx: { pageId: 'p' }, model: fixtureModel() });
    await settle();
    expect(document.getElementById('crev-pointtell-layer')).toBeNull();
  });
});

describe('failure sentences', () => {
  it('say what is wrong in one sentence', async () => {
    const { failureSentence } = await load();
    expect(failureSentence('Not an editable page (no tabset resolved)')).toContain('has none Companion can read');
    expect(failureSentence('Blueprint requires BMP 5.6.3 or newer.')).toBe('Point and tell needs BMP 5.6.3 or newer.');
    expect(failureSentence('')).toBe('Point and tell could not read this page.');
  });
});

describe('the paper', () => {
  const ready = async () => {
    sendRequest.mockImplementation(async (m: { type: string }) => m.type === 'LAYOUT_LOAD'
      ? { ok: true, env: 'e', ctx: { pageId: 'p', editingTemplate: false }, model: fixtureModel() } : undefined);
    const pt = await load();
    pt.enablePointTell();
    await settle();
    return pt;
  };
  const notATab = (layer: HTMLElement) => {
    // Nothing of ours can be found by a query over BMP's tabs, and nothing is put into its tab strip.
    expect(layer.querySelectorAll('[role="tab"], [role="tablist"], .corpo-tabSet, .corpo-tabs__tab').length).toBe(0);
  };

  it('a drawn tab: its label, the paper and the veil set position and stacking inline, click-through', async () => {
    const pt = await ready();
    const { pt: st } = await import('../state');
    const { fixtureScene } = await import('../../lib/point-tell/__tests__/fixture');
    const { addMark } = await import('../marks');
    const { renderPaper, applyPaper } = await import('../paper');
    addMark({ text: 'Contracts', targets: [], reading: 'Add tab after Details', meaning: { kind: 'add', tab: true, place: { after: 'tab_details' } }, ink: { strokes: [{ points: [[300, 50], [300, 20], [390, 20], [390, 50]] }], place: {} } });
    st.scene = { ...fixtureScene(), tabRow: { rect: { left: 100, top: 46, width: 1000, height: 40 } } };
    st.paper = 'draft:1';
    applyPaper();
    renderPaper();
    const layer = document.getElementById('crev-pointtell-layer')!;
    const wrap = layer.querySelector<HTMLElement>('.pt-paper-layer');
    inlineFloor(wrap, 'absolute');
    for (const cls of ['.pt-paper', '.pt-veil', '.pt-tab-label']) {
      const e = layer.querySelector<HTMLElement>(cls);
      inlineFloor(e, 'absolute');
      expect(e!.style.pointerEvents, cls).toBe('none');
    }
    expect(layer.querySelectorAll('.pt-paper-col')).toHaveLength(6);
    expect(layer.querySelector('.pt-tab-label')!.textContent).toBe('Contracts');
    notATab(layer);
    // The label sits above the ink, the paper below the pointer surface.
    expect(Number(layer.querySelector<HTMLElement>('.pt-tab-label')!.style.zIndex)).toBeGreaterThan(2147483606);
    expect(Number(layer.querySelector<HTMLElement>('.pt-paper')!.style.zIndex)).toBeLessThan(2147483604);
    pt.disablePointTell();
  });

  it('a drawn page: the sheet, the rule, the title field and the card set position and stacking inline', async () => {
    const pt = await ready();
    const { pt: st } = await import('../state');
    const { addMark } = await import('../marks');
    const { enterPage } = await import('../page-draft');
    const { openCard } = await import('../create-card');
    const m = addMark({ text: 'Supplier contracts', targets: [], reading: 'New page under X', meaning: { kind: 'add', page: true, place: { into: 'draft:page' } } });
    enterPage(m!.n);
    expect(st.page?.name).toBe('Supplier contracts');
    const layer = document.getElementById('crev-pointtell-layer')!;
    for (const cls of ['.pt-sheet-page', '.pt-paper', '.pt-tab-rule']) inlineFloor(layer.querySelector<HTMLElement>(cls), 'absolute');
    const title = layer.querySelector<HTMLInputElement>('.pt-page-title');
    inlineFloor(title, 'absolute');
    expect(title!.style.pointerEvents).toBe('auto');
    expect(title!.value).toBe('Supplier contracts');
    // The title is above the pointer surface, so a click lands in it.
    expect(Number(title!.style.zIndex)).toBeGreaterThan(2147483604);
    openCard({ text: '{}', snapshot: { at: 1, sig: 's', scope: 'instance', refs: [], colors: {}, now: {}, marks: [] }, result: { steps: [], reports: [], origins: {}, final: st.model!, ready: 0, review: 0, notPossible: 0 } });
    const card = layer.querySelector<HTMLElement>('.pt-card');
    inlineFloor(card, 'fixed');
    expect(card!.textContent).toContain('Create page');
    expect(card!.querySelector<HTMLButtonElement>('.pt-primary')!.disabled).toBe(true);
    notATab(layer);
    pt.disablePointTell();
  });
});
