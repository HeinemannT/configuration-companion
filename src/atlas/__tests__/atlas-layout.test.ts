/**
 * The pure layout rules of the Atlas page: long lists, cut name lists, which
 * lists stay open, and where the card that opens on a resting pointer goes.
 */
import { describe, expect, it } from 'vitest';
import { ListMemory, listPart, nameList, placeCard } from '../atlas-layout';

const items = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('Atlas long lists', () => {
  it('shows a short list whole, and no expander for one or two more', () => {
    expect(listPart(items(10), 10, false)).toEqual({ shown: items(10), hidden: 0, toggle: null });
    expect(listPart(items(12), 10, false).toggle).toBeNull();
  });

  it('shows the first part of a long list with "Show all", and all of it with "Show fewer"', () => {
    const closed = listPart(items(42), 10, false);
    expect(closed.shown).toEqual(items(10));
    expect(closed.hidden).toBe(32);
    expect(closed.toggle).toBe('Show all 42');
    const open = listPart(items(42), 10, true);
    expect(open.shown).toHaveLength(42);
    expect(open.toggle).toBe('Show fewer');
    expect(listPart(items(1500), 10, false).toggle).toBe('Show all 1,500');
  });

  it('keeps the picked item in its place when the list is closed', () => {
    const p = listPart(items(30), 5, false, i => i === 20);
    expect(p.shown).toEqual([0, 1, 2, 3, 4, 20]);
    expect(p.hidden).toBe(24);
  });

  it('cuts a list of names after a few', () => {
    expect(nameList([])).toBe('');
    expect(nameList(['A', 'B'])).toBe('A, B');
    expect(nameList(['A', 'B', 'C', 'D', 'E', 'F'], 4)).toBe('A, B, C, D and 2 more');
  });

  it('keeps a list open while the view shows the same thing, and closes every list of the view when it changes', () => {
    const m = new ListMemory();
    m.toggle('type', 'CeAssuranceActivity', 'in');
    expect(m.isOpen('type', 'CeAssuranceActivity', 'in')).toBe(true);
    expect(m.isOpen('type', 'CeAssuranceActivity', 'out')).toBe(false);
    // Another view keeps its own lists.
    m.toggle('route', 'A>B', 'routes');
    expect(m.isOpen('type', 'CeAssuranceActivity', 'in')).toBe(true);
    // Another type: the lists of One type close.
    expect(m.isOpen('type', 'CeRisk', 'in')).toBe(false);
    expect(m.isOpen('type', 'CeAssuranceActivity', 'in')).toBe(false);
    expect(m.isOpen('route', 'A>B', 'routes')).toBe(true);
    m.toggle('route', 'A>B', 'routes');
    expect(m.isOpen('route', 'A>B', 'routes')).toBe(false);
  });
});

describe('Atlas card placement', () => {
  const viewport = { width: 1200, height: 800 };
  const anchor = (top: number, left = 500, w = 100, h = 30) => ({ left, top, right: left + w, bottom: top + h });

  it('goes below the anchor when it fits there, centred on it', () => {
    const p = placeCard(anchor(100), { width: 300, height: 200 }, viewport);
    expect(p).toEqual({ left: 400, top: 138, side: 'below', maxHeight: null });
  });

  it('goes above when it does not fit below but fits above, and ends just above the anchor', () => {
    const p = placeCard(anchor(600), { width: 300, height: 250 }, viewport);
    expect(p.side).toBe('above');
    expect(p.top + 250).toBe(592);
    expect(p.maxHeight).toBeNull();
  });

  it('is decided from the measured height: the same card never changes side for the same anchor', () => {
    const size = { width: 300, height: 180 };
    expect(placeCard(anchor(560), size, viewport)).toEqual(placeCard(anchor(560), size, viewport));
  });

  it('never covers the anchor: when neither side fits, the side with more room, cut to it', () => {
    const tall = { width: 300, height: 900 };
    const low = placeCard(anchor(500), tall, viewport);
    expect(low.side).toBe('above');
    expect(low.top).toBe(8);
    expect(low.top + (low.maxHeight ?? 0)).toBeLessThanOrEqual(500 - 8);
    const high = placeCard(anchor(200), tall, viewport);
    expect(high.side).toBe('below');
    expect(high.top).toBeGreaterThanOrEqual(230);
    expect(high.top + (high.maxHeight ?? 0)).toBeLessThanOrEqual(800 - 8);
  });

  it('stays inside the viewport at the left and right edges', () => {
    expect(placeCard(anchor(100, 0, 20), { width: 300, height: 100 }, viewport).left).toBe(8);
    expect(placeCard(anchor(100, 1180, 20), { width: 300, height: 100 }, viewport).left).toBe(1200 - 8 - 300);
  });
});
