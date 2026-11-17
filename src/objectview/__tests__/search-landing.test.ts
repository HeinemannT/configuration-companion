// @vitest-environment happy-dom
/** A code search match opens the object window on its property and line,
 *  with the search as the first trail step; Back returns to the search. */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const EXPR = '9223372036854775807';
const OTHER = '9223372036854775801';
const code = (text: string): PropValue => ({ kind: 'code', text });
const lines = Array.from({ length: 40 }, (_, i) => (i === 29 ? '_d := today' : `_v${i} := ${i}`)).join('\n');
const ROOT: FullObject = { rid: EXPR, type: 'ExtendedExpression', name: 'Assessment create prepared', businessId: 'assessment_create_prepared',
  props: { name: { kind: 'text', text: 'Assessment create prepared' }, expression: code(lines) }, references: {}, overridden: [] };
const payload = (root: FullObject): ObjectRootPayload => ({ rid: root.rid, root, rows: [], nodes: {}, posts: 1, ms: 1 });

function mount() {
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async (rid: string) => payload(rid === EXPR ? ROOT : { ...ROOT, rid: OTHER, name: 'Other' })),
    readSummaries: vi.fn(async () => []), fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })), run: vi.fn(async () => ({ ok: true })),
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const toOrigin = vi.fn();
  const findReferences = vi.fn();
  const searchCode = vi.fn();
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); }, back: () => { void controller.back(); }, forward: () => { void controller.forward(); },
    retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(), edit: vi.fn(), revert: vi.fn(), toggleReset: vi.fn(),
    discard: vi.fn(), save: vi.fn(), setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
    selectionChanged: (sel, trail, via) => controller.selectionChanged(sel, trail, via), neighbour: dir => controller.neighbour(dir),
    toOrigin, findReferences, searchCode,
  };
  const onOrigin = vi.fn();
  const view = new ObjectWindowView(root, handlers);
  controller = new ObjectWindowController(view, src, { onOrigin });
  return { root, controller, toOrigin, onOrigin, findReferences, searchCode };
}

const origin = { kind: 'search' as const, label: 'Search: today', mode: 'text' as const, query: 'today' };

describe('landing from code search', () => {
  it('marks the line, opens the block and starts the trail with the search', async () => {
    const { root, controller, toOrigin } = mount();
    await controller.land(EXPR, undefined, { focus: { prop: 'expression', line: 30 }, origin });
    const hot = root.querySelector('.ow-ln.hot');
    expect(hot?.querySelector('.n')?.textContent).toBe('30');
    expect(hot?.closest('.ow-blk')?.classList.contains('expanded')).toBe(true);
    const steps = [...root.querySelectorAll('.ow-trail-a')].map(a => a.textContent);
    expect(steps).toEqual(['Search: today', 'Assessment create prepared · expression · line 30']);
    (root.querySelector('.ow-trail-a.origin') as HTMLElement).click();
    expect(toOrigin).toHaveBeenCalledWith(origin);
  });

  it('Back from the first step returns to the search; the same root keeps one history step', async () => {
    const { root, controller, onOrigin } = mount();
    await controller.open(EXPR);
    await controller.land(EXPR, undefined, { focus: { prop: 'expression', line: 2 }, origin });
    const back = root.querySelector<HTMLButtonElement>('button[aria-label^="Back"]')!;
    expect(back.disabled).toBe(false);
    expect(back.title).toBe('Back to Search: today (Alt+← or Ctrl+[)');
    await controller.back();
    expect(onOrigin).toHaveBeenCalledWith(origin);
  });

  it('offers search and find references for the selected object', async () => {
    const { root, controller, findReferences, searchCode } = mount();
    await controller.open(EXPR);
    const items = [...root.querySelectorAll('.ow-titlebar [role="menuitem"]')].map(b => b.textContent);
    expect(items).toContain('Used in code');
    (root.querySelectorAll<HTMLElement>('.ow-titlebar [role="menuitem"]')[1]).click();
    expect(findReferences).toHaveBeenCalledWith(expect.objectContaining({ rid: EXPR, businessId: 'assessment_create_prepared' }), expect.objectContaining({ rid: EXPR }));
    (root.querySelectorAll<HTMLElement>('.ow-titlebar [role="menuitem"]')[0]).click();
    expect(searchCode).toHaveBeenCalledWith(expect.objectContaining({ rid: EXPR }), true);
  });
});
