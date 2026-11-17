// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const VIEW = '1304972940111718401';
const SET = '1521507040334396171';
const BTN = '2081208944661642130';
const DATE = '7635189582946656799';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });

function obj(rid: string, type: string, name: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}): FullObject {
  return { rid, type, name, businessId: rid.slice(-4), props: { name: t(name), ...props }, references, overridden: [] };
}

function payload(over: Partial<ObjectRootPayload> = {}): ObjectRootPayload {
  return {
    rid: VIEW,
    root: obj(VIEW, 'InputView', 'Update date', { description: t(''), persistence: { kind: 'enum', text: 'session', enumClass: 'PersistStrategy' } },
      { inputSet: [SET], parent: ['5972812378060422527'], createdBy: ['3663406580886322153'] }),
    rows: [{ rid: SET, parent: VIEW }, { rid: BTN, parent: SET }, { rid: DATE, parent: SET }],
    nodes: {
      [SET]: obj(SET, 'InputSet', 'Inputs', {}, { parent: ['8230411327538902142'] }),
      // Newer server: the gate came back.
      [BTN]: obj(BTN, 'ButtonInput', 'Write', {
        showExpression: code(''), useShowExpression: bool(false),
        expression: code('key_date.change(x := 1)'),
        initExpression: code(Array.from({ length: 14 }, (_, i) => `_l${i} := ${i}`).join('\n')),
      }, { parent: [SET] }),
      // Older server: enableExpression without its gate property.
      [DATE]: obj(DATE, 'DateInput', 'New date', { enableExpression: code('x = 1'), key: t('key_date') }, { parent: [SET] }),
    },
    posts: 2,
    ms: 60,
    ...over,
  };
}

function source(p: ObjectRootPayload | Error, extra: Partial<ObjectWindowSource> = {}): ObjectWindowSource & { openRoot: Mock<ObjectWindowSource['openRoot']> } {
  return {
    openRoot: vi.fn<ObjectWindowSource['openRoot']>(async () => { if (p instanceof Error) throw p; return p; }),
    readSummaries: vi.fn(async () => []),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })),
    run: vi.fn(async () => ({ ok: true })),
    ...extra,
  } as ObjectWindowSource & { openRoot: Mock<ObjectWindowSource['openRoot']> };
}

function mount(src: ObjectWindowSource) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); },
    back: () => { void controller.back(); },
    forward: () => { void controller.forward(); },
    retry: () => { void controller.retry(); },
    copy: vi.fn(),
    openInEditor: vi.fn(),
    openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: (rid, prop, base) => controller.toggleReset(rid, prop, base),
    discard: () => { void controller.discard(); },
    save: () => { void controller.save(); },
    setTarget: t => controller.setTarget(t),
    compare: vi.fn(),
    access: vi.fn(),
  };
  const view = new ObjectWindowView(root, handlers);
  controller = new ObjectWindowController(view, src);
  return { root, view, controller, handlers };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('object window view', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('paints the header from the hint before the read lands', async () => {
    let release!: (p: ObjectRootPayload) => void;
    const src = source(payload());
    src.openRoot.mockImplementation(() => new Promise(r => { release = r; }));
    const { root, controller } = mount(src);
    const opening = controller.open(VIEW, { name: 'Hinted name', type: 'InputView' });
    expect(root.querySelector('.ow-head-name')?.textContent).toBe('Hinted name');
    expect(root.querySelector('.ow-head-kind')?.textContent).toBe('Input view');
    release(payload());
    await opening;
    expect(root.querySelector('.ow-head-name')?.textContent).toBe('Update date');
  });

  it('renders the InputView tree with marker columns and swaps the pane without a network call', async () => {
    const src = source(payload());
    const { root, view, controller } = mount(src);
    await controller.open(VIEW, { type: 'InputView' });
    const rows = [...root.querySelectorAll('.ow-row')].map(r => r.getAttribute('data-rid'));
    expect(rows).toEqual([VIEW, SET, BTN, DATE]);
    expect([...root.querySelectorAll('.ow-tree-head .m')].map(m => m.textContent)).toEqual(['S', 'E', 'A']);
    view.select(BTN);
    expect(src.openRoot).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Write');
    // Copy menu offers business id, rid and lookup("rid").
    expect([...root.querySelectorAll('.ow-menu code')].map(c => c.textContent)).toEqual(['2130', BTN, `lookup("${BTN}")`]);
  });

  it('shows a gate switch only when the gate property came back', async () => {
    const { root, view, controller } = mount(source(payload()));
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    const show = [...root.querySelectorAll('.ow-unset')].find(e => e.textContent?.includes('Show expression'));
    expect(show?.querySelector('[role="switch"]')).not.toBeNull();
    view.select(DATE);
    const enable = [...root.querySelectorAll('.ow-blk')].find(e => e.textContent?.includes('Enable expression'));
    expect(enable).toBeTruthy();
    expect(enable!.querySelector('[role="switch"]')).toBeNull();
    // A block the table lists but the read did not return is not drawn.
    expect(root.textContent).not.toContain('Default expression');
  });

  it('caps long expressions at 12 lines with expand', async () => {
    const { root, view, controller } = mount(source(payload()));
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    const init = [...root.querySelectorAll('.ow-blk')].find(e => e.textContent?.includes('Init expression'))!;
    expect(init.querySelectorAll('.ow-ln')).toHaveLength(14);
    const expand = init.querySelector<HTMLButtonElement>('[aria-label^="Expand"]')!;
    expand.click();
    expect([...root.querySelectorAll('.ow-blk.expanded')]).toHaveLength(1);
  });

  it('does not inline code above 20,000 characters', async () => {
    const big = 'x := 1\n'.repeat(4000);
    const p = payload();
    p.nodes[BTN].props.expression = code(big);
    const { root, view, controller, handlers } = mount(source(p));
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    const blk = [...root.querySelectorAll('.ow-blk')].find(e => e.querySelector('.lbl')?.textContent === 'Expression')!;
    expect(blk.textContent).toContain('28,000 chars');
    expect(blk.querySelector('.ow-code')!.textContent!.length).toBeLessThan(6000);
    blk.querySelector<HTMLButtonElement>('[aria-label="Open in editor"]')!.click();
    expect(handlers.openInEditor).toHaveBeenCalledWith(BTN, 'expression', 'ButtonInput');
  });

  it('a failed structure listing leaves a root-only tree and a quiet note', async () => {
    const { root, controller } = mount(source(payload({ rows: null, nodes: {}, structureError: 'EC failed' })));
    await controller.open(VIEW, { type: 'InputView' });
    expect(root.querySelectorAll('.ow-row')).toHaveLength(1);
    expect(root.querySelector('.ow-tree-note')?.textContent).toBe('Structure could not be listed.');
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Update date');
  });

  it('never fetches field labels on open or selection; All properties uses readable accessors', async () => {
    const fieldList = vi.fn(async () => []);
    const { root, view, controller } = mount(source(payload(), { fieldList }));
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    await flush(); await flush();
    expect(fieldList).not.toHaveBeenCalled();
    expect(root.querySelector('.ow-props')).not.toBeNull();
    expect([...root.querySelectorAll('.ow-pr .pn')].map(e => e.textContent)).not.toContain('initExpression');
  });

  it('unknown types get a root-only tree and the generic property list', async () => {
    const odd = obj('424242424242', 'BrandNewWidget', 'Odd', { colour: t('red'), weird: { kind: 'unknown', text: '' } });
    const { root, controller } = mount(source({ rid: odd.rid, root: odd, rows: null, nodes: {}, posts: 1, ms: 5 }));
    await controller.open(odd.rid);
    expect(root.querySelectorAll('.ow-row')).toHaveLength(1);
    // The class name in words, as the code search names the type.
    expect(root.querySelector('.ow-head-kind')?.textContent).toBe('Brand new widget');
    expect(root.querySelector('.ow-tree-head .m')).toBeNull();
    const names = [...root.querySelectorAll('.ow-pr .pn')].map(e => e.textContent);
    expect(names).toContain('Colour');
  });

  it('a failed root read shows a readable message, not a blank window', async () => {
    const { root, controller } = mount(source(new Error('Object not found')));
    await controller.open(VIEW, { name: 'Hint' });
    expect(root.querySelector('.ow')?.getAttribute('data-phase')).toBe('fatal');
    expect(root.querySelector('.ow-fatal')?.textContent).toContain('Object not found');
    expect(root.querySelector('.ow-fatal')?.textContent).toContain(VIEW);
  });

  it('navigates in-frame with back and forward, reusing the cache', async () => {
    const other = obj('555555555555', 'Scorecard', 'Board');
    const src = source(payload());
    src.openRoot.mockImplementation(async (rid) => (rid === VIEW ? payload() : { rid, root: other, rows: null, nodes: {}, posts: 1, ms: 1 }));
    const { root, controller } = mount(src);
    await controller.open(VIEW, { type: 'InputView' });
    await controller.open('555555555555');
    expect(root.querySelector('.ow-head-name')?.textContent).toBe('Board');
    root.querySelector<HTMLButtonElement>('.ow-titlebar [aria-label^="Back"]')!.click();
    await flush();
    expect(root.querySelector('.ow-head-name')?.textContent).toBe('Update date');
    const fwd = root.querySelector<HTMLButtonElement>('.ow-titlebar [aria-label^="Forward"]')!;
    expect(fwd.disabled).toBe(false);
    expect(src.openRoot).toHaveBeenCalledTimes(2);
  });

  it('builds relations from the references map and names targets in one call', async () => {
    const readSummaries = vi.fn(async (rids: string[]) => ({ summaries: [{ rid: '5972812378060422527', type: 'Category', name: 'Folder', businessId: 'f1' }], missing: rids.filter(r => r !== '5972812378060422527') }));
    const { root, controller } = mount(source(payload(), { readSummaries }));
    await controller.open(VIEW, { type: 'InputView' });
    await flush();
    expect(readSummaries).toHaveBeenCalledTimes(1);
    const rel = root.querySelector('.ow-detail')!.textContent!;
    expect(rel).toContain('Relations');
    expect(rel).toContain('Folder');
    expect(rel).toContain('Contains 1');
  });

  it('never shows a bare rid where a name belongs: placeholder while reading, neutral fallback after', async () => {
    let answer!: (s: Array<{ rid: string; type: string; name: string; businessId: string }>) => void;
    const readSummaries = vi.fn(() => new Promise<Array<{ rid: string; type: string; name: string; businessId: string }>>(r => { answer = r; }));
    const { root, controller } = mount(source(payload(), { readSummaries }));
    await controller.open(VIEW, { type: 'InputView' });
    const crumbs = () => root.querySelector('.ow-crumbs')!.textContent!;
    // First paint: the parent's name is being read.
    expect(crumbs()).not.toContain('5972812378060422527');
    expect(root.querySelector('.ow-crumb')!.classList.contains('ow-pending')).toBe(true);
    expect(root.querySelector('.ow-crumb')!.textContent).toBe('…');
    // The read answers without the parent or the creator: asked once more at
    // once, and after a second empty answer the neutral fallbacks show.
    answer([]);
    await flush();
    expect(readSummaries).toHaveBeenCalledTimes(2);
    answer([]);
    await flush();
    expect(root.querySelector('.ow-crumb')!.textContent).toBe('Parent');
    const detail = root.querySelector('.ow-detail')!.textContent!;
    expect(detail).toContain('Created bycould not be read');
    expect(root.querySelector('.ow-ref .ui-unread')).not.toBeNull();
    expect(detail).not.toContain('3663406580886322153');
    // The rid stays where rids are shown on purpose: the RID chip.
    expect(detail).toContain(`RID${VIEW}`);
  });

  it('names the parent once the summary read lands', async () => {
    const readSummaries = vi.fn(async () => [{ rid: '5972812378060422527', type: 'Category', name: 'Folder', businessId: 'f1' }]);
    const { root, controller } = mount(source(payload(), { readSummaries }));
    await controller.open(VIEW, { type: 'InputView' });
    await flush();
    expect(root.querySelector('.ow-crumb')!.textContent).toBe('Folder');
    expect(root.querySelector('.ow-crumb')!.classList.contains('ow-pending')).toBe(false);
  });

  it('a loading root without a hinted name shows a quiet placeholder, not its rid', async () => {
    const src = source(payload());
    src.openRoot.mockImplementation(() => new Promise(() => { /* never lands */ }));
    const { root, controller } = mount(src);
    void controller.open(VIEW);
    await flush();
    expect(root.querySelector('.ow-head-name')!.textContent).toBe('Loading…');
    expect(root.querySelector('.ow-crumbs')!.textContent).not.toContain(VIEW);
  });

  it('a data object asks for its presenting template without waiting for the name read', async () => {
    const ISSUE = '4359639872573959006', TPL = '2900378040243201069';
    const issue: ObjectRootPayload = {
      rid: ISSUE, root: obj(ISSUE, 'CeIssue', 'Issue', {}, { template: [TPL], parent: ['5972812378060422527'] }),
      rows: null, nodes: {}, posts: 1, ms: 10,
    };
    const tpl: ObjectRootPayload = { rid: TPL, root: obj(TPL, 'EnterpriseTemplate', 'Issue template'), rows: [], nodes: {}, posts: 2, ms: 10 };
    const readSummaries = vi.fn(() => new Promise<never>(() => { /* never answers */ }));
    const src = source(issue, { readSummaries });
    src.openRoot.mockImplementation(async rid => (rid === TPL ? tpl : issue));
    const { controller } = mount(src);
    await controller.open(ISSUE, { type: 'CeIssue' });
    await flush();
    expect(readSummaries).toHaveBeenCalled();
    expect(src.openRoot).toHaveBeenCalledWith(TPL, 'EnterpriseTemplate');
  });
});
