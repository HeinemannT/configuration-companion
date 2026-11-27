/**
 * @vitest-environment happy-dom
 *
 * Browse's "Locate on page", the page side: a shown object is ringed at
 * once; one on a tab that is not open gets that tab clicked (as a user
 * would), is waited for, then ringed; what cannot be shown is answered with
 * the reason, and nothing switches while the page is not visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { locateInPage, settled, tabsFromDom, waitFor } from '../content-locate';

/** In this test a node is shown when no ancestor carries `hidden`. */
const shown = (el: Element): boolean => !el.closest('[hidden]');

/** BMP 5.6.20 tabs: the anchor is the tab. Clicking one selects it and shows its panel. */
function page(selected: 'a' | 'b' = 'a'): void {
  document.body.innerHTML = `
    <nav>
      <a class="corpo-tabs__tab" role="tab" id="tab-a" aria-controls="panel-a" aria-selected="${selected === 'a'}" data-text="Overview" href="/portal?rid=1&tabrid=10">Overview</a>
      <a class="corpo-tabs__tab" role="tab" id="tab-b" aria-controls="panel-b" aria-selected="${selected === 'b'}" data-text="Controls" href="/portal?rid=1&tabrid=20">Controls</a>
    </nav>
    <section role="tabpanel" id="panel-a" ${selected === 'a' ? '' : 'hidden'}><div data-rid="11">Heat map</div></section>
    <section role="tabpanel" id="panel-b" ${selected === 'b' ? '' : 'hidden'}><div data-rid="21">Control inputs</div></section>`;
  for (const t of document.querySelectorAll<HTMLElement>('[role=tab]')) {
    t.addEventListener('click', e => {
      e.preventDefault();
      for (const o of document.querySelectorAll<HTMLElement>('[role=tab]')) o.setAttribute('aria-selected', String(o === t));
      // BMP shows the panel a moment later.
      setTimeout(() => {
        for (const p of document.querySelectorAll<HTMLElement>('[role=tabpanel]')) p.hidden = p.id !== t.getAttribute('aria-controls');
      }, 60);
    });
  }
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('locateInPage', () => {
  it('rings a shown object at once and switches nothing', async () => {
    page('a');
    const ring = vi.fn();
    const clicks = vi.fn();
    document.getElementById('tab-b')!.addEventListener('click', clicks);
    expect(await locateInPage(['11'], [{ rid: '10', name: 'Overview' }], ring, { shown })).toEqual({ found: '11' });
    expect(ring).toHaveBeenCalledWith(document.querySelector('[data-rid="11"]'), '11');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('opens the tab that holds it, waits for it, then rings it', async () => {
    page('a');
    const ring = vi.fn();
    const answer = await locateInPage(['21'], [{ rid: '20', name: 'Controls' }], ring, { shown, waitMs: 1500 });
    expect(answer).toEqual({ found: '21', tab: 'Controls', switched: true });
    expect(document.getElementById('tab-b')!.getAttribute('aria-selected')).toBe('true');
    expect(ring).toHaveBeenCalledOnce();
  });

  it('finds the tab from the ARIA tab panel when the panel did not name one', async () => {
    page('a');
    expect(tabsFromDom(['21'])).toEqual([{ rid: '20', name: 'Controls' }]);
    const answer = await locateInPage(['21'], [], vi.fn(), { shown, waitMs: 1500 });
    expect(answer).toEqual({ found: '21', tab: 'Controls', switched: true });
  });

  it('says which tab when the tab button is not on the page', async () => {
    page('a');
    const answer = await locateInPage(['99'], [{ rid: '77', name: 'Archive' }], vi.fn(), { shown, waitMs: 200 });
    expect(answer).toEqual({ found: null, tab: 'Archive', why: 'other-tab' });
  });

  it('the tab is open but the object is not shown: not shown, no click', async () => {
    page('b');
    document.querySelector('[data-rid="21"]')!.setAttribute('hidden', ''); // a collapsed area
    const clicks = vi.fn();
    for (const t of document.querySelectorAll('[role=tab]')) t.addEventListener('click', clicks);
    const answer = await locateInPage(['21'], [{ rid: '20', name: 'Controls' }], vi.fn(), { shown, waitMs: 200 });
    expect(answer).toEqual({ found: null, tab: 'Controls', why: 'not-shown' });
    expect(clicks).not.toHaveBeenCalled();
  });

  it('a tab with a rid is found by its rid only, not by a tab of the same name', async () => {
    page('a');
    const clicks = vi.fn();
    for (const t of document.querySelectorAll('[role=tab]')) t.addEventListener('click', clicks);
    // Rid 30 is not on the page; the tab named Controls has rid 20.
    const answer = await locateInPage(['21'], [{ rid: '30', name: 'Controls' }], vi.fn(), { shown, waitMs: 200 });
    expect(answer).toEqual({ found: null, tab: 'Controls', why: 'other-tab' });
    expect(clicks).not.toHaveBeenCalled();
  });

  it('a tab without a rid is found by its name', async () => {
    page('a');
    const answer = await locateInPage(['21'], [{ rid: '', name: 'Controls' }], vi.fn(), { shown, waitMs: 1500 });
    expect(answer).toEqual({ found: '21', tab: 'Controls', switched: true });
  });

  it('a newer locate takes over: the older one rings nothing and answers not shown', async () => {
    page('a');
    const older = vi.fn();
    const newer = vi.fn();
    const first = locateInPage(['21'], [{ rid: '20', name: 'Controls' }], older, { shown, waitMs: 1500, settleMs: 0 });
    const second = locateInPage(['11'], [], newer, { shown });
    expect(await second).toEqual({ found: '11' });
    expect(await first).toEqual({ found: null, why: 'not-shown' });
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledOnce();
  });

  it('rings the element shown after the tab settled, not one a re-render took off the page', async () => {
    page('a');
    const ring = vi.fn();
    const pending = locateInPage(['21'], [{ rid: '20', name: 'Controls' }], ring, { shown, waitMs: 2000, settleMs: 400 });
    // The tab panel shows at 60 ms; a re-render then replaces the widget.
    await new Promise(r => setTimeout(r, 150));
    const old = document.querySelector('[data-rid="21"]')!;
    const fresh = old.cloneNode(true) as Element;
    old.replaceWith(fresh);
    expect(await pending).toEqual({ found: '21', tab: 'Controls', switched: true });
    expect(ring).toHaveBeenCalledWith(fresh, '21');
  });

  it('switched, but the object never appears in time: not shown on that tab', async () => {
    page('a');
    const answer = await locateInPage(['55'], [{ rid: '20', name: 'Controls' }], vi.fn(), { shown, waitMs: 300 });
    expect(answer).toEqual({ found: null, tab: 'Controls', switched: true, why: 'not-shown' });
  });

  it('nothing known about the object: not shown', async () => {
    page('a');
    expect(await locateInPage(['55'], [], vi.fn(), { shown, waitMs: 100 })).toEqual({ found: null, why: 'not-shown' });
  });

  it('a page that is not visible switches nothing and says so', async () => {
    page('a');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const clicks = vi.fn();
    document.getElementById('tab-b')!.addEventListener('click', clicks);
    expect(await locateInPage(['21'], [{ rid: '20', name: 'Controls' }], vi.fn(), { shown })).toEqual({ found: null, why: 'page-behind' });
    expect(clicks).not.toHaveBeenCalled();
  });
});

describe('waitFor', () => {
  it('answers on a DOM change before its limit, and null at the limit', async () => {
    document.body.innerHTML = '<div id="box"></div>';
    setTimeout(() => document.getElementById('box')!.append(Object.assign(document.createElement('span'), { id: 'late' })), 30);
    const t0 = Date.now();
    expect(await waitFor(() => document.getElementById('late'), 2000)).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await waitFor(() => document.getElementById('never'), 80)).toBeNull();
  });
});

describe('settled', () => {
  it('waits while a freshly opened tab still moves the object, then resolves', async () => {
    let top = 0;
    const el = { getBoundingClientRect: () => ({ left: 0, top, width: 10, height: 10 }) } as unknown as Element;
    const t0 = Date.now();
    const moves = setInterval(() => { if (top < 300) top += 100; }, 50);
    await settled(el, 2000);
    clearInterval(moves);
    expect(top).toBe(300);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('an element taken off the page is not settled', async () => {
    const el = document.createElement('div');
    const t0 = Date.now();
    await settled(el, 250);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it('gives up after its time', async () => {
    let top = 0;
    const el = { getBoundingClientRect: () => ({ left: 0, top: top++, width: 10, height: 10 }) } as unknown as Element;
    const t0 = Date.now();
    await settled(el, 200);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
