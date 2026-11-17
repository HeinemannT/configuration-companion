// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { OBJECT_CHANGE_PROPS_SET } from '../../lib/bmp-client';
import { PROP_GROUPS } from '../../lib/pane-schema';
import { GATE_PROPS, WindowDraft, editability } from '../window/draft';
import { NOT_IN_READ, planSave, runSave, type SaveStep } from '../window/save-plan';
import { buildReview } from '../window/review';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import type { CodeEditorFactory, CodeEditorOptions } from '../window/code-edit';

const VIEW = '1304972940111718401';
const TPL = '2083195720221442289';
const SET = '1521507040334396171';
const BTN = '2081208944661642130';
const LBL = '7635189582946656799';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });
const num = (n: number): PropValue => ({ kind: 'number', text: String(n), num: n });
const en = (text: string): PropValue => ({ kind: 'enum', text });

function obj(rid: string, type: string, name: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}, overridden: string[] = []): FullObject {
  return { rid, type, name, businessId: `id_${rid.slice(-4)}`, props: { name: t(name), id: t(`id_${rid.slice(-4)}`), ...props }, references, overridden };
}

function reads(): Record<string, FullObject> {
  return {
    [VIEW]: obj(VIEW, 'InputView', 'Update date', { shadow: bool(true), columnsLargeScreen: num(6), persistence: en('session'), sortIndex: num(7) },
      { inputSet: [SET], linkedTo: [TPL] }, ['shadow', 'sortIndex']),
    [SET]: obj(SET, 'InputSet', 'Inputs', {}, { parent: [VIEW] }),
    [BTN]: obj(BTN, 'ButtonInput', 'Write', {
      showExpression: code(''), useShowExpression: bool(false), expression: code('a := 1'), description: t(''),
    }, { parent: [SET] }),
    [LBL]: obj(LBL, 'Label', 'Guidance', { enableExpression: code('x = 1'), textInputType: en('SINGLELINE'), advancedDefault: bool(false) }, { parent: [SET] }),
    [TPL]: obj(TPL, 'InputView', 'Update date (template)', { shadow: bool(false) }),
  };
}

function payload(r = reads()): ObjectRootPayload {
  return {
    rid: VIEW, root: r[VIEW],
    rows: [{ rid: SET, parent: VIEW }, { rid: BTN, parent: SET }, { rid: LBL, parent: SET }],
    nodes: { [SET]: r[SET], [BTN]: r[BTN], [LBL]: r[LBL] }, posts: 2, ms: 50,
  };
}

/** Textarea stand-in for CodeMirror. */
function fakeEditor(): { factory: CodeEditorFactory; last: () => CodeEditorOptions & { area: HTMLTextAreaElement } } {
  let last!: CodeEditorOptions & { area: HTMLTextAreaElement };
  const factory: CodeEditorFactory = opts => {
    const area = document.createElement('textarea');
    area.value = opts.code;
    area.addEventListener('input', () => opts.onChange(area.value));
    last = { ...opts, area };
    return { el: area, getDoc: () => area.value, focus: () => area.focus(), destroy: () => undefined };
  };
  return { factory, last: () => last };
}

function mount(over: Partial<ObjectWindowSource> = {}, opts: { confirmDiscard?: (n: number) => Promise<boolean> } = {}) {
  const store = reads();
  const runs: SaveStep[] = [];
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async (rid: string) => (rid === VIEW ? payload(store) : { rid, root: obj(rid, 'Scorecard', 'Other'), rows: null, nodes: {}, posts: 1, ms: 1 })),
    readSummaries: vi.fn(async () => []),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async (rids: string[]) => ({ objects: Object.fromEntries(rids.filter(r => store[r]).map(r => [r, store[r]])), errors: {} })),
    run: vi.fn(async (step: SaveStep) => { runs.push(step); return { ok: true }; }),
    ...over,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const editor = fakeEditor();
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); },
    back: () => { void controller.back(); },
    forward: () => { void controller.forward(); },
    retry: () => { void controller.retry(); },
    copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: (rid, prop, base) => controller.toggleReset(rid, prop, base),
    discard: () => { void controller.discard(); },
    save: () => { void controller.save(); },
    setTarget: tg => controller.setTarget(tg),
    compare: vi.fn(), access: vi.fn(),
  };
  const view = new ObjectWindowView(root, handlers, { codeEditor: editor.factory });
  controller = new ObjectWindowController(view, src, { confirmSave: async () => true, ...(opts.confirmDiscard ? { confirmDiscard: opts.confirmDiscard } : {}) });
  return { root, view, controller, src, runs, store, editor };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

describe('window draft', () => {
  it('holds edits for several objects, counts them and reverts one at a time', () => {
    const d = new WindowDraft();
    d.set(VIEW, 'shadow', 'false', 'true');
    d.set(BTN, 'expression', 'a := 2', 'a := 1');
    d.set(BTN, 'useShowExpression', 'true', 'false');
    expect(d.count()).toBe(3);
    expect(d.countFor(BTN)).toBe(2);
    d.revert(BTN, 'expression');
    expect(d.countFor(BTN)).toBe(1);
    expect(d.get(VIEW, 'shadow')).toEqual({ kind: 'value', value: 'false', base: 'true' });
  });

  it('drops an entry set back to its stored value (enums compare by member)', () => {
    const d = new WindowDraft();
    d.set(VIEW, 'shadow', 'false', 'true');
    d.set(VIEW, 'shadow', 'true', 'true');
    d.set(LBL, 'textInputType', 'SINGLELINE', 'TextInputType.singleline');
    expect(d.count()).toBe(0);
  });

  it('commit keeps a value changed while the save was in flight', () => {
    const d = new WindowDraft();
    d.set(BTN, 'expression', 'a := 2', 'a := 1');
    const submitted = d.items().map(({ prop, entry }) => ({ prop, entry }));
    d.set(BTN, 'expression', 'a := 3', 'a := 1');
    d.commit(BTN, submitted);
    expect(d.get(BTN, 'expression')).toMatchObject({ value: 'a := 3' });
  });
});

describe('edit policy', () => {
  const r = reads();
  it('allows identity, drawn expressions, their gates and the pane-schema properties only', () => {
    expect(editability(r[BTN], 'name')?.route).toBe('identity');
    expect(editability(r[BTN], 'expression')?.route).toBe('code');
    expect(editability(r[BTN], 'useShowExpression')).toMatchObject({ route: 'props', gate: true });
    expect(editability(r[VIEW], 'shadow')?.route).toBe('props');
    expect(editability(r[LBL], 'textInputType')?.def?.kind).toBe('enum');
    // Read-only in this step: arbitrary properties.
    expect(editability(r[VIEW], 'sortIndex')).toBeNull();
    expect(editability(r[VIEW], 'persistence')).toBeNull();
    expect(editability(r[BTN], 'description')).toBeNull();
  });

  it('never allows a property the read did not return', () => {
    expect(editability(r[LBL], 'useEnableExpression')).toBeNull();
    expect(editability(r[VIEW], 'headerStyle')).toBeNull();
  });

  it('every editable pane property and gate is on the write allowlist', () => {
    for (const p of GATE_PROPS) expect(OBJECT_CHANGE_PROPS_SET.has(p)).toBe(true);
    for (const g of PROP_GROUPS) for (const d of g.props) if (d.kind !== 'text') expect(OBJECT_CHANGE_PROPS_SET.has(d.prop)).toBe(true);
  });
});

describe('save plan', () => {
  it('routes each kind of edit to its existing write route', () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(VIEW, 'shadow', 'false', 'true');
    d.set(VIEW, 'columnsLargeScreen', '3', '6');
    d.stageReset(VIEW, 'shadow', 'true');
    d.set(BTN, 'useShowExpression', 'true', 'false');
    d.set(BTN, 'expression', 'a := 2', 'a := 1');
    d.set(BTN, 'id', 'new_id', r[BTN].businessId);
    const plans = planSave(d.items(), r);
    const view = plans.find(p => p.rid === VIEW)!;
    expect(view.steps.map(s => s.step)).toEqual([{ route: 'APPLY_OBJECT_CHANGES', rid: VIEW, changes: { columnsLargeScreen: 3 }, resetProps: ['shadow'] }]);
    const btn = plans.find(p => p.rid === BTN)!;
    expect(btn.steps.map(s => s.step)).toEqual([
      { route: 'APPLY_OBJECT_CHANGES', rid: BTN, changes: { useShowExpression: true }, resetProps: [] },
      { route: 'SAVE_PROPERTY', rid: BTN, objectType: 'ButtonInput', property: 'expression', value: 'a := 2', valueKind: 'code' },
      // Only the edited ID, with the value it was opened with: the name is
      // not sent, so a rename made elsewhere is kept.
      { route: 'SAVE_IDENTITY', rid: BTN, businessId: 'new_id', expect: { businessId: r[BTN].businessId } },
    ]);
    expect(btn.opened).toEqual({ useShowExpression: 'false', expression: 'a := 1', id: r[BTN].businessId });
  });

  it('passes the read kind with every expression save', () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(BTN, 'showExpression', '// on', '');
    d.set(LBL, 'enableExpression', 'x = 2', 'x = 1');
    const steps = planSave(d.items(), r).flatMap(p => p.steps.map(s => s.step));
    expect(steps).toEqual([
      { route: 'SAVE_PROPERTY', rid: BTN, objectType: 'ButtonInput', property: 'showExpression', value: '// on', valueKind: 'code' },
      { route: 'SAVE_PROPERTY', rid: LBL, objectType: 'Label', property: 'enableExpression', value: 'x = 2', valueKind: 'code' },
    ]);
  });

  it('tells a local refusal (nothing sent) from a sent write that failed', async () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(BTN, 'name', '', 'Write');
    d.set(LBL, 'enableExpression', 'x = 2', 'x = 1');
    const results = await runSave(planSave(d.items(), r), {
      run: async s => (s.route === 'SAVE_IDENTITY'
        ? { ok: false, error: 'Name is required.', notSent: true }
        : { ok: false, error: 'argument type mismatch' }),
    });
    expect(results.find(x => x.rid === BTN)).toEqual({ rid: BTN, saved: [], attempted: false, refused: true, error: 'Name is required.' });
    expect(results.find(x => x.rid === LBL)).toEqual({ rid: LBL, saved: [], attempted: true, error: 'argument type mismatch' });
  });

  it('a refused later step keeps the earlier sent write attempted', async () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(BTN, 'expression', 'a := 2', 'a := 1');
    d.set(BTN, 'name', '', 'Write');
    const [res] = await runSave(planSave(d.items(), r), {
      run: async s => (s.route === 'SAVE_IDENTITY' ? { ok: false, error: 'Name is required.', notSent: true } : { ok: true }),
    });
    expect(res).toMatchObject({ attempted: true, refused: true, saved: [{ prop: 'expression' }], error: 'Name is required.' });
  });

  it('a thrown step counts as sent (its outcome is unknown)', async () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(BTN, 'expression', 'a := 2', 'a := 1');
    const [res] = await runSave(planSave(d.items(), r), { run: async () => { throw new Error('lost'); } });
    expect(res).toEqual({ rid: BTN, saved: [], attempted: true, error: 'lost' });
  });

  it('an entry the plan rejected is reported as refused', async () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(BTN, 'useShowExpression', 'true', 'false');
    delete r[BTN].props.useShowExpression;
    const [res] = await runSave(planSave(d.items(), r), { run: async () => ({ ok: true }) });
    expect(res).toEqual({ rid: BTN, saved: [], attempted: false, refused: true, error: NOT_IN_READ });
  });

  it('does not send a property that is missing from the object read', () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(BTN, 'useShowExpression', 'true', 'false');
    delete r[BTN].props.useShowExpression;
    const [plan] = planSave(d.items(), r);
    expect(plan.steps).toEqual([]);
    expect(plan.rejected).toEqual([{ prop: 'useShowExpression', reason: NOT_IN_READ }]);
  });

  it('stops an object at its first failed step; other objects still save', async () => {
    const r = reads();
    const d = new WindowDraft();
    d.set(VIEW, 'shadow', 'false', 'true');
    d.set(BTN, 'useShowExpression', 'true', 'false');
    d.set(BTN, 'expression', 'a := 2', 'a := 1');
    const steps: string[] = [];
    const results = await runSave(planSave(d.items(), r), {
      run: async s => { steps.push(`${s.rid}:${s.route}`); return s.rid === BTN ? { ok: false, error: 'Property not allowed' } : { ok: true }; },
    });
    expect(steps).toEqual([`${VIEW}:APPLY_OBJECT_CHANGES`, `${BTN}:APPLY_OBJECT_CHANGES`]);
    expect(results.find(x => x.rid === VIEW)).toMatchObject({ attempted: true, saved: [{ prop: 'shadow' }] });
    expect(results.find(x => x.rid === BTN)).toMatchObject({ attempted: true, saved: [], error: 'Property not allowed' });
  });

  it('the review groups rows per object and asks harder for an ID change', () => {
    const d = new WindowDraft();
    d.set(VIEW, 'shadow', 'false', 'true');
    d.set(BTN, 'id', 'new_id', 'old');
    const review = buildReview(d.items(), rid => ({ rid, name: rid === VIEW ? 'View' : 'Write', kind: '' }), (_r, p) => p, () => false);
    expect(review.changesId).toBe(true);
    expect(review.confirmLabel).toBe('Change ID');
    expect(review.confirmVariant).toBe('danger');
    const box = document.createElement('div');
    box.append(...review.body);
    expect([...box.querySelectorAll('.ow-review-name')].map(e => e.textContent)).toEqual(['View', 'Write']);
    expect(box.querySelectorAll('.crev-modal-diff-row')).toHaveLength(2);
  });
});

describe('object window editing', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('name and business ID are edited only from the pencil', async () => {
    const { root, view, controller } = mount();
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    const h2 = root.querySelector<HTMLElement>('.ow-sub-name h2')!;
    h2.click();
    h2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.querySelector<HTMLElement>('.ow-chip .v')!.click();
    expect(root.querySelector('.ow-name-input, .ow-id-input')).toBeNull();

    root.querySelector<HTMLButtonElement>('[aria-label="Edit ID"]')!.click();
    const input = root.querySelector<HTMLInputElement>('.ow-id-input')!;
    input.value = 'bad id!';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(root.querySelector('.ow-field-err')?.textContent).toContain('letters, numbers');
    expect(controller.dirtyCount).toBe(0);

    const again = root.querySelector<HTMLInputElement>('.ow-id-input')!;
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    again.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(root.querySelector('.ow-id-input')).toBeNull();

    root.querySelector<HTMLButtonElement>('[aria-label="Rename"]')!.click();
    const name = root.querySelector<HTMLInputElement>('.ow-name-input')!;
    name.value = 'Write now';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(controller.dirtyCount).toBe(1);
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Write now');
    expect(root.querySelector('.ow-sub-name .ow-tag-edit')?.textContent).toContain('Unsaved');
  });

  it('shows an edit on the control, on its tree row and in the save bar; revert removes it', async () => {
    const { root, view, controller, editor } = mount();
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    root.querySelector<HTMLButtonElement>('[aria-label="Edit Expression"]')!.click();
    const area = editor.last().area;
    area.value = 'a := 2';
    editor.last().onDone();
    expect(controller.dirtyCount).toBe(1);
    const blk = root.querySelector('.ow-blk.edited')!;
    expect(blk.textContent).toContain('Unsaved');
    expect(root.querySelector(`.ow-row[data-rid="${BTN}"] .ow-dia`)).not.toBeNull();
    expect(root.querySelector(`.ow-row[data-rid="${BTN}"] .ow-sr`)?.textContent).toBe('1 unsaved change');
    expect(root.querySelector('.ow-bar-long')?.textContent).toBe('1 unsaved change');
    // Gate switch is editable and counts separately.
    root.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Use show expression"]')!.click();
    expect(root.querySelector('.ow-bar-long')?.textContent).toBe('2 unsaved changes');
    root.querySelector<HTMLButtonElement>('[aria-label="Revert Expression"]')!.click();
    expect(controller.dirtyCount).toBe(1);
  });

  it('Escape in the code editor cancels that edit', async () => {
    const { root, view, controller, editor } = mount();
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    root.querySelector<HTMLButtonElement>('[aria-label="Edit Expression"]')!.click();
    editor.last().onChange('a := 99');
    editor.last().onCancel();
    await flush();
    expect(controller.dirtyCount).toBe(0);
    expect(view.editing).toBe(false);
  });

  it('Discard closes an open code editor: the stored value shows again, as after Escape', async () => {
    const confirmDiscard = vi.fn(async () => true);
    const { root, view, controller, editor, store } = mount({}, { confirmDiscard });
    await controller.open(VIEW, { type: 'InputView' });
    view.select(BTN);
    root.querySelector<HTMLButtonElement>('[aria-label="Edit Expression"]')!.click();
    const area = editor.last().area;
    area.value = 'typed := 1\ntyped := 2';
    area.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 250));
    expect(controller.dirtyCount).toBe(1);
    [...root.querySelectorAll<HTMLButtonElement>('.ui-btn.ghost')].find(b => b.textContent === 'Discard')!.click();
    await flush();
    expect(confirmDiscard).toHaveBeenCalledWith(1, 'discard');
    expect(controller.dirtyCount).toBe(0);
    expect(view.editing).toBe(false);
    expect(root.contains(area)).toBe(false);
    const stored = store[BTN].props.expression?.text ?? '';
    expect(root.querySelector('.ow-blk')?.textContent ?? '').not.toContain('typed := 2');
    if (stored) expect(root.textContent).toContain(stored.split('\n')[0]);
    // A later edit starts from the stored value, not from the discarded text.
    root.querySelector<HTMLButtonElement>('[aria-label="Edit Expression"]')!.click();
    expect(editor.last().area.value).toBe(stored);
  });

  it('partial save: saved objects leave the draft, failed ones stay with the error, then re-read', async () => {
    const run = vi.fn(async (s: SaveStep) => (s.rid === BTN ? { ok: false, error: 'BMP refused the write' } : { ok: true }));
    const { root, view, controller, src } = mount({ run });
    await controller.open(VIEW, { type: 'InputView' });
    root.querySelector<HTMLButtonElement>('details.ow-grp summary')?.click();
    controller.edit(VIEW, 'shadow', 'false', 'true');
    controller.edit(BTN, 'useShowExpression', 'true', 'false');
    await controller.save();
    expect(controller.dirtyCount).toBe(1);
    expect(src.readObjects).toHaveBeenCalledWith([VIEW, BTN]);
    expect(root.querySelector(`.ow-row[data-rid="${BTN}"] .ow-err-mark`)).not.toBeNull();
    expect(root.querySelector('.ow-bar-err')?.textContent).toContain('Write');
    view.select(BTN);
    expect(root.querySelector('.ow-save-err')?.textContent).toContain('BMP refused the write');
  });

  it('template mode edits the template object and saves it to its own rid', async () => {
    const { root, controller, runs } = mount();
    await controller.open(VIEW, { type: 'InputView' });
    const seg = [...root.querySelectorAll<HTMLButtonElement>('.ow-seg button')];
    expect(seg.map(b => b.textContent)).toEqual(['Template', 'Instance']);
    seg[0].click();
    await flush();
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Update date (template)');
    controller.edit(TPL, 'shadow', 'true', 'false');
    expect(root.querySelector(`.ow-row[data-rid="${VIEW}"] .ow-dia`)).not.toBeNull();
    await controller.save();
    expect(runs).toEqual([{ route: 'APPLY_OBJECT_CHANGES', rid: TPL, changes: { shadow: true }, resetProps: [] }]);
  });

  it('dirty guard: navigating away with pending edits asks first', async () => {
    const confirmDiscard = vi.fn(async () => false);
    const { controller, src } = mount({}, { confirmDiscard });
    await controller.open(VIEW, { type: 'InputView' });
    controller.edit(VIEW, 'shadow', 'false', 'true');
    await controller.open('999999999999');
    expect(confirmDiscard).toHaveBeenCalledWith(1, 'navigate');
    expect(controller.current).toBe(VIEW);
    expect(src.openRoot).toHaveBeenCalledTimes(1);
    confirmDiscard.mockResolvedValueOnce(true);
    await controller.open('999999999999');
    expect(controller.current).toBe('999999999999');
    expect(controller.dirtyCount).toBe(0);
  });

  it('an unknown value with no text shows its class name', async () => {
    const odd = obj('424242424242', 'BrandNewWidget', 'Odd', { filter: { kind: 'unknown', text: '', cls: 'ConditionGroupList' } });
    const { root, controller } = mount({ openRoot: vi.fn(async () => ({ rid: odd.rid, root: odd, rows: null, nodes: {}, posts: 1, ms: 1 })) });
    await controller.open(odd.rid);
    const row = [...root.querySelectorAll('.ow-pr')].find(r => r.textContent?.includes('Filter'))!;
    expect(row.querySelector('.pv')?.textContent).toBe('ConditionGroupList');
  });
});
