// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import type { RefResolution } from '../../lib/code-ref-resolve';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const SET = '1521507040334396171';
const BTN = '2081208944661642130';
const ACT = '7000000000000000001';
const JOB = '7000000000000000002';
const STEP = '7000000000000000003';
const EXPR = '9223372036854775807';
const INNER = '9223372036854775806';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const obj = (rid: string, type: string, name: string, props: Record<string, PropValue> = {}): FullObject =>
  ({ rid, type, name, businessId: `id_${rid.slice(-3)}`, props: { name: t(name), ...props }, references: {}, overridden: [] });

const ROOT = obj(SET, 'InputSet', 'Publishing operations');
const BUTTON = obj(BTN, 'ButtonInput', 'Publish', {
  buttonType: { kind: 'enum', text: 'ButtonInputType.expression' },
  expression: code('// call\n_v := t.ab_validate.expression\n_x := t.get("ab-gone")\n"t.ab_in_string"'),
});
const ACTION = obj(ACT, 'ButtonInput', 'Publish or resume', { buttonType: { kind: 'enum', text: 'ButtonInputType.action' } });
const TARGET = obj(EXPR, 'ExtendedExpression', 'validate definition', { expression: code('_a := 1\n_b := t.ab_inner.expression') });
const INNER_OBJ = obj(INNER, 'ExtendedExpression', 'inner', { expression: code('_c := 3') });

const payload: ObjectRootPayload = {
  rid: SET, root: ROOT, rows: [{ rid: BTN, parent: SET }, { rid: ACT, parent: SET }],
  nodes: { [BTN]: BUTTON, [ACT]: ACTION }, posts: 2, ms: 1,
};

const RESOLVED: Record<string, RefResolution> = {
  't.ab_validate': { found: true, target: { rid: EXPR, type: 'ExtendedExpression', name: 'validate definition', businessId: 'ab_validate', codeProp: 'expression' } },
  't.ab-gone': { found: false },
  't.ab_inner': { found: true, target: { rid: INNER, type: 'ExtendedExpression', name: 'inner', businessId: 'ab_inner', codeProp: 'expression' } },
};

function mount() {
  const resolveRefs = vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(k => [k, RESOLVED[k] ?? { found: false as const }])));
  const listReferenced = vi.fn(async () => ({
    rows: [{ rid: JOB, parent: ACT }, { rid: STEP, parent: JOB }],
    nodes: { [JOB]: obj(JOB, 'NotificationTransportGroup', 'Publish job'), [STEP]: obj(STEP, 'ExtendedTransport', '1. prepare', { expression: code('x') }) },
  }));
  const readObjects = vi.fn(async (rids: string[]) => ({ objects: Object.fromEntries(rids.map(r => [r, r === EXPR ? TARGET : INNER_OBJ])), errors: {} }));
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async () => payload),
    readSummaries: vi.fn(async () => []),
    fieldList: vi.fn(async () => []),
    readObjects,
    run: vi.fn(async () => ({ ok: true })),
    resolveRefs,
    listReferenced,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); },
    back: () => { void controller.back(); },
    forward: () => { void controller.forward(); },
    retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    edit: vi.fn(), revert: vi.fn(), toggleReset: vi.fn(), discard: vi.fn(), save: vi.fn(), setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
    followRefs: items => controller.followReferences(items),
    reveal: (target, trail, attach, hops) => controller.reveal(target, trail, attach, hops),
    selectionChanged: (sel, trail, via) => controller.selectionChanged(sel, trail, via),
    neighbour: dir => controller.neighbour(dir),
  };
  const view = new ObjectWindowView(root, handlers);
  controller = new ObjectWindowController(view, src);
  return { root, view, controller, resolveRefs, listReferenced, readObjects };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

describe('following code references in the object window', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('follows an action button after the paint, as referenced rows, with one listing', async () => {
    const { root, controller, listReferenced } = mount();
    await controller.open(SET);
    expect(listReferenced).not.toHaveBeenCalled();
    await flush();
    expect(listReferenced).toHaveBeenCalledTimes(1);
    expect(listReferenced.mock.calls[0]).toEqual([[{ rid: ACT, via: 'actionObject', depth: 1 }]]);
    const job = root.querySelector(`.ow-row[data-rid="${JOB}"]`)!;
    expect(job.classList.contains('ref')).toBe(true);
    expect(root.querySelector(`.ow-row[data-rid="${STEP}"]`)?.classList.contains('ref')).toBe(false);
    expect(root.querySelector('.ow-legend')?.textContent).toContain('referenced, not a child');
  });

  it('draws links, resolves them in one batch and peeks the target under the line', async () => {
    const { root, view, controller, resolveRefs, readObjects } = mount();
    await controller.open(SET);
    view.select(BTN);
    await flush();
    expect(resolveRefs).toHaveBeenCalledTimes(1);
    expect(resolveRefs.mock.calls[0][0].sort()).toEqual(['t.ab-gone', 't.ab_validate']);
    const links = [...root.querySelectorAll<HTMLElement>('.ow-detail .ow-code .ow-xref')];
    expect(links.map(l => l.textContent)).toEqual(['t.ab_validate.expression', 't.get("ab-gone")']);
    expect(links[1].classList.contains('nf')).toBe(true);
    expect(root.querySelector('.ow-calls-h .hint')?.textContent).toBe('1 of 2 references resolved; 1 not found.');
    links[0].click();
    await flush();
    expect(readObjects).toHaveBeenCalledWith([EXPR]);
    const peek = root.querySelector('.ow-peek')!;
    expect(peek.getAttribute('aria-label')).toBe('Code of validate definition, Extended expression, called on line 2');
    expect(peek.querySelector('.cnt')?.textContent).toBe('2 lines');
    // the peek sits right after the calling line (line 2)
    expect(peek.previousElementSibling?.querySelector('.n')?.textContent).toBe('2');
  });

  it('says how many references could not be read, with a retry that asks again', async () => {
    const { root, view, controller, resolveRefs } = mount();
    resolveRefs.mockRejectedValueOnce(new Error('timeout'));
    await controller.open(SET);
    view.select(BTN);
    await flush();
    expect(root.querySelector('.ow-calls-h .hint')?.textContent).toBe('0 of 2 references resolved; 2 could not be read.');
    const retry = [...root.querySelectorAll<HTMLElement>('.ow-calls-h button')].find(b => b.textContent === 'Retry')!;
    expect(retry).toBeTruthy();
    retry.click();
    await flush();
    expect(resolveRefs).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.ow-calls-h .hint')?.textContent).toBe('1 of 2 references resolved; 1 not found.');
    expect([...root.querySelectorAll('.ow-calls-h button')].some(b => b.textContent === 'Retry')).toBe(false);
  });

  it('opens a reference inside the window: referenced row, trail, "Reached from", Back', async () => {
    const { root, view, controller } = mount();
    await controller.open(SET);
    view.select(BTN);
    await flush();
    const link = root.querySelector<HTMLElement>('.ow-detail .ow-xref')!;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await flush();
    expect(root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid')).toBe(EXPR);
    expect(root.querySelector(`.ow-row[data-rid="${EXPR}"]`)?.classList.contains('ref')).toBe(true);
    expect([...root.querySelectorAll('.ow-trail-a')].map(a => a.textContent)).toEqual(['Publishing operations', 'Publish', 'validate definition']);
    expect(root.querySelector('.ow-from')?.textContent).toBe('Reached from Publish, expression line 2');
    // Reached by reference and still editable in place (same save path).
    expect(root.querySelector('.ow-sub-name button[aria-label="Rename"]')).not.toBeNull();
    expect(root.querySelector('.ow-titlebar [aria-label^="Back"]')?.getAttribute('aria-label')).toBe('Back to Publish (Alt+← or Ctrl+[)');
    await controller.back();
    expect(root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid')).toBe(BTN);
    await controller.forward();
    expect(root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid')).toBe(EXPR);
  });

  it('makes each hop of a followed chain one history step, also across a root change', async () => {
    const { root, view, controller } = mount();
    await controller.open(SET);
    view.select(BTN);
    await flush();
    root.querySelector<HTMLElement>('.ow-detail .ow-xref')!.click();
    await flush();
    root.querySelector<HTMLElement>('.ow-peek .ow-xref')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await flush();
    const sel = () => root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid');
    expect(sel()).toBe(INNER);
    await controller.back();
    expect(sel()).toBe(EXPR);
    await controller.back();
    expect(sel()).toBe(BTN);
    await controller.forward();
    await controller.forward();
    expect(sel()).toBe(INNER);
    // Escape closes the open peek first (it is still open here), never the window.
    view.select(BTN);
    await flush();
    expect(root.querySelector('.ow-peek')).not.toBeNull();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(root.querySelector('.ow-peek')).toBeNull();
  });

  it('records tree selections as history steps', async () => {
    const { root, view, controller } = mount();
    await controller.open(SET);
    view.select(BTN);
    view.select(ACT);
    await controller.back();
    expect(root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid')).toBe(BTN);
    await controller.back();
    expect(root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid')).toBe(SET);
  });
});
