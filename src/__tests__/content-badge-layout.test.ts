import { describe, expect, it } from 'vitest';
import { clearOfText, layoutBadges, type BadgeInput, type Box } from '../content-badge-layout';

const box = (top: number, left: number, w: number, h: number): Box => ({ top, left, bottom: top + h, right: left + w });
const badge = (natural: Box, host: Box, visibleTop = 0): BadgeInput => ({ natural, host, visibleTop });
const moved = (b: Box, o: { dx: number; dy: number }): Box => ({ top: b.top + o.dy, bottom: b.bottom + o.dy, left: b.left + o.dx, right: b.right + o.dx });
const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('badge collision layout', () => {
  it('leaves badges that do not collide where they are', () => {
    const out = layoutBadges([badge(box(10, 100, 60, 20), box(8, 0, 200, 100)), badge(box(10, 400, 60, 20), box(8, 300, 200, 100))], 1280);
    expect(out).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });

  it('stacks badges that share a corner (nested widgets) so none covers another', () => {
    const host = box(0, 0, 400, 300);
    const items = [0, 1, 2].map(() => badge(box(2, 300, 90, 20), host));
    const out = layoutBadges(items, 1280);
    const placed = items.map((it, i) => moved(it.natural, out[i]));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
  });

  it('nudges a badge left when it overlaps another by a sliver', () => {
    const out = layoutBadges([badge(box(10, 100, 60, 20), box(0, 0, 400, 300)), badge(box(10, 50, 58, 20), box(0, 0, 400, 300))], 1280);
    expect(out[1].dy).toBe(0);
    expect(out[1].dx).toBeLessThan(0);
  });

  it('pulls a badge below a sticky header or the viewport top, but not below its host', () => {
    const [underHeader] = layoutBadges([badge(box(30, 100, 60, 20), box(28, 0, 300, 400), 64)], 1280);
    expect(30 + underHeader.dy).toBe(66);
    const [scrolledOff] = layoutBadges([badge(box(-50, 100, 60, 20), box(-52, 0, 300, 100))], 1280);
    expect(-50 + scrolledOff.dy).toBe(2);
    const [shortHost] = layoutBadges([badge(box(-50, 100, 60, 20), box(-52, 0, 300, 60))], 1280);
    expect(-50 + shortHost.dy + 20).toBeLessThanOrEqual(8);
  });

  it('keeps a badge inside the viewport horizontally', () => {
    const [right] = layoutBadges([badge(box(10, 1250, 60, 20), box(0, 1000, 400, 100))], 1280);
    expect(1250 + right.dx + 60).toBeLessThanOrEqual(1278);
  });

  it('places 500 badges quickly', () => {
    const host = box(0, 0, 2000, 2000);
    const items = Array.from({ length: 500 }, (_, i) => badge(box((i % 50) * 30, Math.floor(i / 50) * 100, 80, 20), host));
    // Best of three runs: a guard against a quadratic layout, not a benchmark.
    // A single wall-clock sample failed when a loaded full run preempted it.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      layoutBadges(items, 1280);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(200);
  });

  // Geometry of the sandbox's "Result" tab: 44x42 host, text 162-178, the
  // compact badge (22x20) tucked in at 151-171 covered the text.
  const tabHost = box(150, 24, 44, 42);
  const tabText: Box = { top: 162, left: 24, bottom: 178, right: 68 };
  const tabBadge = box(151, 45, 22, 20);
  const open: Box = { top: 0, left: 0, bottom: 800, right: 1280 };

  it('moves a small host badge off its text, right of it when there is no room above', () => {
    const off = clearOfText(tabBadge, tabText, { ...open, top: 148 });
    expect(off).not.toBeNull();
    const placed = moved(tabBadge, off!);
    expect(overlap(placed, tabText)).toBe(false);
    expect(placed.left).toBeGreaterThanOrEqual(tabText.right);
    const [viaLayout] = layoutBadges([{ ...badge(tabBadge, tabHost), text: tabText, clip: { ...open, top: 148 } }], 1280);
    expect(viaLayout).toEqual({ dx: Math.round(off!.dx), dy: Math.round(off!.dy), fit: true });
  });

  it('puts the badge above the text when that fits', () => {
    const off = clearOfText(tabBadge, tabText, open)!;
    expect(moved(tabBadge, off).bottom).toBeLessThanOrEqual(tabText.top);
  });

  it('leaves a badge that does not touch the text alone', () => {
    expect(clearOfText(box(100, 300, 22, 20), tabText, open)).toEqual({ dx: 0, dy: 0 });
  });

  it('shrinks to a dot when no place next to the text is inside the clip area', () => {
    const clip: Box = { top: 150, left: 24, bottom: 192, right: 68 };
    expect(clearOfText(tabBadge, tabText, clip)).toBeNull();
    const [out] = layoutBadges([{ ...badge(tabBadge, tabHost), text: tabText, clip }], 1280);
    expect(out.dot).toBe(true);
  });

  it('shrinks a wide badge to its tile and keeps it off the text of a neighbouring tab', () => {
    // "Organisation Overview" tab with a full badge; "Schedules" starts 4px right of its text.
    const text: Box = { top: 162, left: 24, bottom: 178, right: 190 };
    const neighbour: Box = { top: 162, left: 224, bottom: 178, right: 290 };
    const wide = box(151, 90, 100, 42);
    const off = clearOfText(wide, text, { ...open, top: 148 }, [neighbour])!;
    expect(off.fit).toBe(true);
    const tile = moved({ top: 151, bottom: 171, right: 190, left: 168 }, off);
    expect(overlap(tile, text)).toBe(false);
    expect(overlap(tile, neighbour)).toBe(false);
  });

  it('keeps 4px between a badge and its element text', () => {
    const off = clearOfText(tabBadge, tabText, { ...open, top: 148 })!;
    expect(moved({ top: 151, bottom: 171, right: 67, left: 45 }, off).left).toBeGreaterThanOrEqual(tabText.right + 4);
  });

  it('moves a widget badge off the page controls it would cover (kebab, pencil)', () => {
    const host = box(200, 700, 680, 300);
    const natural = box(204, 1230, 146, 42);
    const kebab: Box = { top: 230, left: 1350, bottom: 262, right: 1370 };
    const pencil: Box = { top: 230, left: 1326, bottom: 262, right: 1346 };
    const [o] = layoutBadges([{ ...badge(natural, host), controls: [kebab, pencil], clip: { ...open, right: 1400 } }], 1400);
    const placed = moved(natural, o);
    expect(overlap(placed, kebab) || overlap(placed, pencil)).toBe(false);
  });

  describe('tab strips', () => {
    // A strip that clips at 138..182; tabs 150..180. Each tab's corner tile
    // (22x20, right-anchored) hangs 10px past its tab's right edge.
    const strip: Box = { top: 138, left: 0, bottom: 182, right: 1280 };
    const tab = (left: number, right: number, textLeft: number, textRight: number, group?: number): BadgeInput => ({
      natural: box(140, right - 12, 22, 20), host: { top: 150, bottom: 180, left, right }, visibleTop: 0, anchor: 'right',
      text: { top: 158, bottom: 172, left: textLeft, right: textRight }, clip: strip, ...(group != null ? { group } : {}),
    });
    const within = (o: { dx: number; dy: number; dot?: boolean; fit?: boolean }, it: BadgeInput) => {
      const b = moved(o.fit ? { ...it.natural, left: it.natural.right - 22 } : it.natural, o);
      return b.left >= it.host.left && b.right <= it.host.right && b.top >= strip.top && b.bottom <= strip.bottom;
    };

    it('a tab\'s badge never hangs past its tab: inside it, or the dot', () => {
      const items = [tab(0, 120, 12, 60, 1), tab(120, 240, 132, 180, 1)];
      const out = layoutBadges(items, 1280);
      out.forEach((o, i) => expect(o.dot || within(o, items[i]), JSON.stringify(o)).toBe(true));
      expect(out.some(o => o.dot)).toBe(false);
    });

    it('a badge that cannot be fully visible becomes the dot, and then every tab of its strip does', () => {
      // The second tab is too narrow for a tile beside its text.
      const items = [tab(0, 120, 12, 60, 1), tab(120, 170, 128, 166, 1), tab(300, 420, 312, 360, 2)];
      const out = layoutBadges(items, 1280);
      expect(out[1].dot).toBe(true);
      expect(out[0].dot).toBe(true);
      // Another strip keeps its tile.
      expect(out[2].dot).toBeUndefined();
      expect(within(out[2], items[2])).toBe(true);
    });
  });

  it('hides the badge of an element scrolled under a sticky header', () => {
    const [o] = layoutBadges([badge(box(40, 100, 60, 20), box(30, 0, 300, 70), 91)], 1280);
    expect(o.hidden).toBe(true);
  });
});
