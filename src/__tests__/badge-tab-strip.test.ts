// @vitest-environment happy-dom
/**
 * Which badges belong to one tab strip (content-badge-layout stripOf): the
 * tabs of one BMP tab set share a group, another tab set gets its own, and
 * an element outside any tab set has none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBadgeLayout, stripOf } from '../content-badge-layout';

describe('tab strip of a badged element', () => {
  it('groups the tabs of one tab set, wrapped or not, apart from another set', () => {
    document.body.innerHTML = `
      <div class="corpo-tabSet"><ul>
        <li><a class="corpo-tabSet__tab" id="a1"><span id="a1t">Overview</span></a></li>
        <li><a class="corpo-tabSet__tab" id="a2">Risks</a></li>
      </ul></div>
      <div role="tablist"><button role="tab" id="b1">One</button><button role="tab" id="b2">Two</button></div>
      <a id="plain">Link</a>`;
    const cache = new Map<Element, number | null>();
    const g = (id: string) => stripOf(document.getElementById(id)!, cache);
    expect(g('a1')).toBeDefined();
    expect(g('a1')).toBe(g('a2'));
    // A badge on an element inside the tab belongs to the same strip.
    expect(g('a1t')).toBe(g('a1'));
    expect(g('b1')).toBe(g('b2'));
    expect(g('b1')).not.toBe(g('a1'));
    expect(g('plain')).toBeUndefined();
  });
});

describe('tab strip narrower than its tabs', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('gives a tab scrolled out of view the same dot as the visible tabs of its strip', () => {
    // Three tabs 100 px wide in a 600 px window; the third sits past the right edge.
    document.body.innerHTML = `<div class="corpo-tabSet"><ul>
      <li><a class="corpo-tabSet__tab" id="t0">Overview<span class="crev-label"></span></a></li>
      <li><a class="corpo-tabSet__tab" id="t1">Risks<span class="crev-label"></span></a></li>
      <li><a class="corpo-tabSet__tab" id="t2">Controls<span class="crev-label"></span></a></li>
    </ul></div>`;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    const lefts: Record<string, number> = { t0: 0, t1: 100, t2: 700 };
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const tab = this.closest('.corpo-tabSet__tab');
      if (!tab) return rect(0, 0, 0, 0);
      const left = lefts[tab.id];
      // The badge in full (60 x 20) at the tab's top-left; the tab 100 x 30.
      return this.classList.contains('crev-label') ? rect(left, 0, 60, 20) : rect(left, 0, 100, 30);
    });
    // Each tab's text fills it, so no place in a visible tab fits a tile: dots.
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const tab = (this.startContainer.parentElement ?? (this.startContainer as Element)).closest('.corpo-tabSet__tab');
      const list = tab ? [rect(lefts[tab.id] + 2, 4, 96, 22)] : [];
      return Object.assign(list, { item: (i: number) => list[i] ?? null }) as unknown as DOMRectList;
    });
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] });
    runBadgeLayout();
    const dot = (id: string) => document.querySelector(`#${id} > .crev-label`)!.classList.contains('crev-label--dot');
    expect([dot('t0'), dot('t1'), dot('t2')]).toEqual([true, true, true]);
  });
});
