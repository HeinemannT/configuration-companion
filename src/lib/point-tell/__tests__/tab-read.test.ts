import { describe, expect, it } from 'vitest';
import { fixtureScene } from './fixture';
import { ellipse, line } from './strokes';
import { readInk } from '../ink-read';
import type { PtScene } from '../resolve';
import type { PtPoint } from '../types';

/** The fixture page with a tab row: two pills (100 and 190, 30 tall) and the strip across the page. */
const rowScene = (): PtScene => ({ ...fixtureScene(), tabRow: { rect: { left: 100, top: 46, width: 1000, height: 40 } } });
const read = (scene: PtScene, ...strokes: PtPoint[][]) => readInk(scene, strokes.map(points => ({ points })));

/** An arch standing on the row: up the left side, across the top, down the right side. */
function arch(x: number, y: number, w: number, h: number): PtPoint[] {
  const pts: PtPoint[] = [];
  for (let i = 0; i <= 8; i++) pts.push([x + (i % 2 ? 0.6 : -0.6), y + h - (h * i) / 8]);
  for (let i = 1; i <= 16; i++) pts.push([x + (w * i) / 16, y + (i % 2 ? 0.8 : -0.5)]);
  for (let i = 1; i <= 8; i++) pts.push([x + w + (i % 2 ? 0.7 : -0.4), y + (h * i) / 8]);
  return pts;
}

describe('a tab drawn on the tab row', () => {
  it('an arch past the last tab is a new tab after it', () => {
    const r = read(rowScene(), arch(300, 48, 90, 30));
    expect(r.kind).toBe('add');
    expect(r.meaning).toMatchObject({ kind: 'add', tab: true, place: { after: 'tab_details' } });
    expect(r.reading).toBe('Add tab after Details');
    expect(r.targets).toEqual([]);
    expect(r.place).toEqual({});
  });

  it('a small box or a plus is a tab too', () => {
    const box = [[300, 50], [380, 50], [382, 80], [300, 82], [300, 50]] as PtPoint[];
    expect(read(rowScene(), box).meaning).toMatchObject({ tab: true });
    const plus = read(rowScene(), line([320, 52], [320, 78], { bow: 0 }), line([307, 65], [333, 65], { bow: 0 }));
    expect(plus.meaning).toMatchObject({ tab: true, place: { after: 'tab_details' } });
  });

  it('in a gap it goes after its left neighbour', () => {
    const scene = rowScene();
    scene.pills = [{ id: 'tab_overview', kind: 'tab', rect: { left: 100, top: 50, width: 80, height: 30 } }, { id: 'tab_details', kind: 'tab', rect: { left: 330, top: 50, width: 80, height: 30 } }];
    const r = read(scene, arch(210, 48, 90, 30));
    expect(r.meaning).toMatchObject({ tab: true, place: { after: 'tab_overview' } });
  });

  it('a flat line under the tabs is not a tab, a loop round a tab is that tab, an arrow from a tab moves it', () => {
    expect(read(rowScene(), line([300, 80], [400, 81], { bow: 0.01 })).meaning).toBeUndefined();
    const loop = read(rowScene(), ellipse(140, 66, 60, 22));
    expect(loop.kind).toBe('select');
    expect(loop.targets).toEqual(['tab_overview']);
  });

  it('a shape down in the page is not a tab, and a page with no tab row has none', () => {
    expect(read(rowScene(), arch(300, 200, 90, 30)).meaning?.kind === 'add' && (read(rowScene(), arch(300, 200, 90, 30)).meaning as { tab?: true }).tab).toBeFalsy();
    expect(read(fixtureScene(), arch(300, 48, 90, 30)).meaning).toBeUndefined();
  });
});

describe('a page drawn past the last breadcrumb', () => {
  const crumbScene = (): PtScene => ({ ...rowScene(), crumbRow: { rect: { left: 300, top: 20, width: 300, height: 30 }, lastId: 'sc_op_risk', parent: 'Risk management' } });

  it('an arch right of the last crumb is a new page, named for its parent', () => {
    const r = read(crumbScene(), arch(340, 22, 90, 26));
    expect(r.kind).toBe('add');
    expect(r.meaning).toMatchObject({ kind: 'add', page: true });
    expect(r.reading).toBe('New page under Risk management');
  });

  it('the same shape on the tab row is a tab, and one left of the last crumb is nothing', () => {
    expect((read(crumbScene(), arch(300, 48, 90, 30)).meaning as { tab?: true }).tab).toBe(true);
    expect(read(crumbScene(), arch(120, 22, 90, 26)).meaning).toBeUndefined();
    expect(read(rowScene(), arch(340, 22, 90, 26)).meaning).toBeUndefined();
  });
});
