import { describe, expect, it } from 'vitest';
import { hitTest, targetsInBox, nearestEdge } from '../hit';
import { resolvePlace, resolveArrow, resolveBox, inkPlace, objectsIn, placeWords } from '../resolve';
import { fixtureModel, fixtureScene } from './fixture';

const scene = fixtureScene();

describe('hit', () => {
  it('the deepest object wins: the smallest rectangle under the point', () => {
    expect(hitTest(scene.targets, 200, 200)?.id).toBe('tbl_open_risks');
    expect(hitTest(scene.targets, 300, 330)?.id).toBe('txt_info');
    expect(hitTest(scene.targets, 800, 350)?.id).toBe('cont_notes');
    expect(hitTest(scene.targets, 50, 50)).toBeNull();
  });

  it('a box takes the objects whose centre it holds', () => {
    const ids = targetsInBox(scene.targets, { left: 90, top: 430, width: 360, height: 60 }).map(t => t.id);
    expect(ids).toEqual(['btn_new_risk', 'btn_export']);
  });

  it('the nearest edge decides before (left, top) or after (right, bottom)', () => {
    const r = { left: 0, top: 0, width: 100, height: 40 };
    expect(nearestEdge(r, 10, 20)).toEqual({ side: 'left', before: true });
    expect(nearestEdge(r, 90, 20)).toEqual({ side: 'right', before: false });
    expect(nearestEdge(r, 50, 3)).toEqual({ side: 'top', before: true });
    expect(nearestEdge(r, 50, 38)).toEqual({ side: 'bottom', before: false });
  });
});

describe('resolvePlace: where a point lands', () => {
  const widgetMover = { id: 'btn_export', kind: 'widget' as const };

  it('left half of a widget: before it, with the words, row and tab', () => {
    const r = resolvePlace(scene, 120, 460, widgetMover);
    expect(r).toMatchObject({ ok: true, place: { before: 'btn_new_risk' }, words: 'before "New risk"', tabId: 'tab_overview', row: 3 });
  });

  it('right half of a widget: after it, and it offers the other side', () => {
    const s = resolvePlace(scene, 420, 460, { id: 'btn_new_risk', kind: 'widget' });
    expect(s).toMatchObject({ ok: true, place: { after: 'btn_export' } });
    if (s.ok) expect(s.alternatives[0].place).toEqual({ before: 'btn_export' });
  });

  it('the trailing gap of a row: after the last object of that row', () => {
    const r = resolvePlace(scene, 700, 460, { id: 'btn_new_risk', kind: 'widget' });
    expect(r).toMatchObject({ ok: true, place: { after: 'btn_export' } });
  });

  it('inside a container but not over a widget: among its children, by row and column', () => {
    const r = resolvePlace(scene, 900, 410, { id: 'btn_export', kind: 'widget' });
    expect(r).toMatchObject({ ok: true, place: { after: 'txt_info' }, containerId: 'cont_notes', tabId: 'tab_overview' });
    if (r.ok) expect(r.col).toBe(5);
  });

  it('below the last row of the tab: into the tab', () => {
    const r = resolvePlace(scene, 500, 495, widgetMover);
    expect(r).toMatchObject({ ok: true, place: { into: 'tab_overview' }, words: 'into tab "Overview"' });
  });

  it('on a tab pill: into that tab', () => {
    const r = resolvePlace(scene, 230, 60, widgetMover);
    expect(r).toMatchObject({ ok: true, place: { into: 'tab_details' }, tabId: 'tab_details' });
  });

  it('a tab is placed only beside another tab', () => {
    expect(resolvePlace(scene, 120, 60, { id: 'tab_details', kind: 'tab' })).toMatchObject({ ok: true, place: { before: 'tab_overview' } });
    expect(resolvePlace(scene, 120, 200, { id: 'tab_details', kind: 'tab' })).toEqual({ ok: false, reason: 'A tab is placed beside another tab.' });
    expect(resolvePlace(scene, 230, 60, { id: 'tab_details', kind: 'tab' })).toEqual({ ok: false, reason: 'That is the tab itself.' });
  });

  it('outside the page content: refused', () => {
    expect(resolvePlace(scene, 20, 600, widgetMover)).toEqual({ ok: false, reason: 'Not a place on this page.' });
    expect(resolvePlace(scene, 500, 700, widgetMover)).toEqual({ ok: false, reason: 'Not a place on this page.' });
  });

  it('the object itself is not a place', () => {
    expect(resolvePlace(scene, 300, 460, widgetMover)).toEqual({ ok: false, reason: 'That is the object itself.' });
    // nor anything inside a container being moved
    expect(resolvePlace(scene, 300, 200, { id: 'cont_top', kind: 'container' })).toEqual({ ok: false, reason: 'That is the object itself.' });
  });

  it('a gap between two containers is no place for a widget (strict) and the nearest legal place for an add', () => {
    const strict = resolvePlace(scene, 500, 310, { id: 'btn_new_risk', kind: 'widget' });
    expect(strict).toEqual({ ok: false, reason: 'BMP shows widgets after all containers, and this place is between containers' });
    const near = resolvePlace(scene, 500, 310, { id: 'btn_new_risk', kind: 'widget' }, 'nearest');
    expect(near).toMatchObject({ ok: true, remapped: true, place: { before: 'btn_export' } });
  });

  it('a container is never placed after a widget', () => {
    const r = resolvePlace(scene, 250, 460, { id: 'cont_top', kind: 'container' });
    expect(r).toEqual({ ok: false, reason: 'BMP shows containers before widgets. Place it beside a container instead' });
    // before the first widget is legal
    expect(resolvePlace(scene, 110, 460, { id: 'cont_top', kind: 'container' })).toMatchObject({ ok: true, place: { before: 'btn_new_risk' } });
  });

  it('members of a group are placed in Blueprint, not from a sketch', () => {
    const m = fixtureModel();
    m.tabs[0].children[3].children = [{ id: 'm1', kind: 'widget', className: 'ActionButton', name: 'Inner', cols: { L: 1 }, children: [] }];
    m.tabs[0].children[3].className = 'ButtonGroup';
    const s = fixtureScene(m);
    s.targets.push({ id: 'm1', kind: 'widget', rect: { left: 270, top: 444, width: 60, height: 30 } });
    expect(resolvePlace(s, 280, 460, { id: 'btn_new_risk', kind: 'widget' })).toEqual({ ok: false, reason: '"Export" holds its own members; place them in Blueprint' });
  });

  it('words name the place', () => {
    const m = fixtureModel();
    expect(placeWords(m, { before: 'btn_export' })).toBe('before "Export"');
    expect(placeWords(m, { after: 'cont_top' })).toBe('after "Col 6"');
    expect(placeWords(m, { into: 'tab_details' })).toBe('into tab "Details"');
  });
});

describe('resolveArrow: move an object', () => {
  it('Export to the left of New risk', () => {
    const r = resolveArrow(scene, 'btn_export', 120, 460);
    expect(r).toMatchObject({ ok: true, meaning: { kind: 'move', to: { before: 'btn_new_risk' }, words: 'Move "Export" before "New risk"' }, grid: { tabId: 'tab_overview', row: 3 } });
  });

  it('where it already is: nothing to move', () => {
    expect(resolveArrow(scene, 'btn_export', 700, 460)).toEqual({ ok: false, reason: 'It is already there.' });
  });

  it('onto another tab: into it', () => {
    expect(resolveArrow(scene, 'btn_export', 230, 60)).toMatchObject({ ok: true, meaning: { to: { into: 'tab_details' }, words: 'Move "Export" into tab "Details"' } });
  });

  it('an object that is not in the model', () => {
    expect(resolveArrow(scene, 'ghost', 120, 460)).toEqual({ ok: false, reason: 'That object is not in the page layout.' });
  });

  it('a container onto the table: a place BMP cannot render is refused with the reason', () => {
    const r = resolveArrow(scene, 'cont_notes', 250, 460); // the right half of "New risk": after a widget
    expect(r).toEqual({ ok: false, reason: 'BMP shows containers before widgets. Place it beside a container instead' });
  });
});

describe('resolveBox: objects, or a place to add', () => {
  it('over two objects: a group', () => {
    const r = resolveBox(scene, { left: 90, top: 430, width: 360, height: 60 });
    expect(r).toMatchObject({ ok: true, kind: 'objects', ids: ['btn_new_risk', 'btn_export'] });
  });

  it('over one object: that object', () => {
    expect(resolveBox(scene, { left: 250, top: 430, width: 200, height: 60 })).toMatchObject({ ok: true, kind: 'objects', ids: ['btn_export'] });
  });

  it('over a whole container: the container, not its members', () => {
    const r = resolveBox(scene, { left: 90, top: 90, width: 1020, height: 220 });
    expect(r).toMatchObject({ ok: true, kind: 'objects', ids: ['cont_top'] });
  });

  it('inside the body of a widget: that widget', () => {
    expect(resolveBox(scene, { left: 200, top: 200, width: 100, height: 60 })).toMatchObject({ ok: true, kind: 'objects', ids: ['tbl_open_risks'] });
  });

  it('over empty space beside the buttons: add there, about a third of the width', () => {
    const r = resolveBox(scene, { left: 500, top: 440, width: 333, height: 40 });
    expect(r).toMatchObject({ ok: true, kind: 'place', meaning: { kind: 'add', place: { after: 'btn_export' }, columns: 2 } });
    if (r.ok && r.kind === 'place') expect(r.meaning.words).toBe('after "Export", about 2 columns wide');
  });

  it('over empty space below everything: into the tab', () => {
    const r = resolveBox(scene, { left: 100, top: 484, width: 1000, height: 20 });
    expect(r).toMatchObject({ ok: true, kind: 'place', meaning: { place: { into: 'tab_overview' }, columns: 6 } });
  });

  it('a box too small, or off the page, is no place', () => {
    expect(resolveBox(scene, { left: 10, top: 10, width: 2, height: 2 })).toEqual({ ok: false, reason: 'Not a place on this page.' });
    expect(resolveBox(scene, { left: 5, top: 700, width: 60, height: 60 })).toEqual({ ok: false, reason: 'Not a place on this page.' });
  });

  it('objectsIn includes tab pills inside the box', () => {
    expect(objectsIn(scene, { left: 90, top: 40, width: 200, height: 50 })).toEqual(['tab_overview', 'tab_details']);
  });
});

describe('inkPlace: where freehand ink sits in page-grid terms', () => {
  it('a circle around Export: the objects under it, its tab, row and width', () => {
    const circle = { points: [[250, 430], [450, 430], [450, 490], [250, 490], [250, 430]] as Array<[number, number]> };
    const g = inkPlace(scene, [circle]);
    expect(g).toMatchObject({ tabId: 'tab_overview', over: ['btn_export'] });
    expect(g.cols).toBe(1);
  });

  it('a scribble over empty space: a place, no objects', () => {
    const g = inkPlace(scene, [{ points: [[520, 442], [700, 478]] }]);
    expect(g.over).toBeUndefined();
    expect(g).toMatchObject({ tabId: 'tab_overview', row: 3 });
  });

  it('no strokes: nothing', () => { expect(inkPlace(scene, [])).toEqual({}); });
});
