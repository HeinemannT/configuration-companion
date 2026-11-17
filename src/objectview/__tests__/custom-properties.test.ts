// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ABSENT, type TypePropertySchema } from '../../lib/property-schema';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import { checkAgainstRead, customStored, planSave, splitCustom, type SaveStep } from '../window/save-plan';
import type { CustomEntry } from '../window/draft';
import { buildSections } from '../window/prop-sections';
import { DEF, ITEMS, schema as fixtureSchema } from '../../lib/__tests__/fixtures/property-fields';

const RID = '4000000000000000001';
const t = (text: string): PropValue => ({ kind: 'text', text });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

function object(over: Partial<FullObject> = {}): FullObject {
  return {
    rid: RID, type: 'CeProcess', name: 'Sample process', businessId: '110',
    props: { name: t('Sample process'), description: t(''), [DEF.note]: t('Old note'), [DEF.enabled]: { kind: 'boolean', text: 'true', bool: true } },
    references: { [DEF.kind]: [ITEMS[0].rid], parent: ['4000000000000000009'] },
    overridden: [], ...over,
  };
}

async function testSchema(edit?: (s: TypePropertySchema) => void): Promise<TypePropertySchema> {
  const s = await fixtureSchema();
  edit?.(s);
  return s;
}

function mount(obj: FullObject, schema: TypePropertySchema, opts: { reads?: FullObject[]; confirm?: (body: string) => boolean } = {}) {
  const reads = [...(opts.reads ?? [])];
  const run = vi.fn<ObjectWindowSource['run']>(async () => ({ ok: true }));
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async (): Promise<ObjectRootPayload> => ({ rid: RID, root: obj, rows: null, nodes: {}, posts: 1, ms: 1 })),
    readSummaries: vi.fn(async () => ({ summaries: [] })),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => {
      const o = reads.length > 1 ? reads.shift()! : reads[0] ?? obj;
      return { objects: { [RID]: o }, errors: {} };
    }),
    propertySchema: vi.fn(async () => schema),
    run,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    editCustom: (rid, prop, value) => controller.editCustom(rid, prop, value),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: vi.fn(), discard: vi.fn(), save: () => { void controller.save(); }, setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
  };
  const view = new ObjectWindowView(root, handlers);
  let reviewText = '';
  let conflictText = '';
  controller = new ObjectWindowController(view, src, {
    confirmSave: async r => { reviewText = r.body.map(n => n.textContent).join('\n'); return opts.confirm ? opts.confirm(reviewText) : true; },
    resolveConflict: async c => { conflictText = c.body.map(n => n.textContent).join('\n'); return 'cancel'; },
    unknownRereadDelayMs: 0,
  });
  return { root, controller, run, src, review: () => reviewText, conflict: () => conflictText };
}

const row = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`.ow-pr2[data-key="${key}"]`)!;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

beforeEach(() => { document.body.textContent = ''; });

describe('sections from the schema', () => {
  it('lists unset custom properties as "Not set", one section per category, Audit and Advanced folded', async () => {
    const s = await testSchema();
    const { before } = buildSections(object(), { summaries: {}, schema: s });
    expect(before.map(x => x.title)).toEqual(['General', 'Identity', 'Other', 'Scoring']);
    const weight = before[3].rows.find(r => r.key === DEF.weight)!;
    expect(weight).toMatchObject({ stored: ABSENT, has: false });
    expect(weight.reason).toBeUndefined();
    // A historical boolean is editable: no reason line.
    const enabled = before[2].rows.find(r => r.key === DEF.enabled)!;
    expect(enabled).toMatchObject({ stored: 'true' });
    expect(enabled.reason).toBeUndefined();
    const score = before[3].rows.find(r => r.key === DEF.score)!;
    expect(score.reason).toBe('Calculated by Extended Code');
  });

  it('draws the rows with a reason line only where the row cannot be edited', async () => {
    const { root, controller } = mount(object(), await testSchema());
    await controller.open(RID);
    await flush();
    expect([...root.querySelectorAll('.ow-ps-sec .ow-ps-h .t')].map(e => e.textContent)).toEqual(['General', 'Identity', 'Other', 'Scoring', 'Relations']);
    expect(row(root, DEF.weight).querySelector('.ow-pbox')?.textContent).toContain('Not set');
    expect(row(root, DEF.score).querySelector('.ow-preason')?.textContent).toBe('Calculated by Extended Code');
    // A historical boolean is editable: a live switch, no reason line.
    expect(row(root, DEF.enabled).querySelector('.ow-preason')).toBeNull();
    expect(row(root, DEF.enabled).querySelector('button.ui-sw')?.getAttribute('aria-checked')).toBe('true');
    expect(row(root, DEF.note).querySelector('.ow-preason')).toBeNull();
    // Relations: read-only note once in the header.
    expect(root.querySelector('[data-sec="relations"] .ow-ps-note')?.textContent).toContain('Structure changes');
  });
});

describe('editors in the row', () => {
  it('text: Enter commits to the draft with the unsaved marker; Esc cancels', async () => {
    const { root, controller } = mount(object(), await testSchema());
    await controller.open(RID);
    await flush();
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    let input = row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in')!;
    expect(input.value).toBe('Old note');
    input.value = 'Dropped';
    key(input, 'Escape');
    expect(row(root, DEF.note).querySelector('input')).toBeNull();
    expect(controller.dirtyCount).toBe(0);
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    input = row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in')!;
    input.value = 'New note';
    key(input, 'Enter');
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.note).classList.contains('chg')).toBe(true);
    expect(row(root, DEF.note).querySelector('.ow-pbox .pt')?.textContent).toBe('New note');
    // The section says it holds an unsaved edit and cannot be folded.
    const sec = root.querySelector<HTMLElement>('[data-sec="c:Identity"]')!;
    expect(sec.querySelector('.ow-ps-dirty')?.textContent).toBe('1 unsaved');
    sec.querySelector<HTMLElement>('.ow-ps-h')!.click();
    expect(root.querySelector<HTMLElement>('[data-sec="c:Identity"]')!.dataset.open).toBe('true');
    // Revert.
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pr-a button')!.click();
    expect(controller.dirtyCount).toBe(0);
  });

  it('number: a non-number shows an error in words and stages nothing', async () => {
    const { root, controller } = mount(object(), await testSchema());
    await controller.open(RID);
    await flush();
    row(root, DEF.weight).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    let input = row(root, DEF.weight).querySelector<HTMLInputElement>('input')!;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    key(input, 'Enter');
    expect(row(root, DEF.weight).querySelector('.ow-perr:not([hidden])')?.textContent).toBe('Not a number');
    expect(controller.dirtyCount).toBe(0);
    input = row(root, DEF.weight).querySelector<HTMLInputElement>('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = '1,234';
    key(input, 'Enter');
    expect(row(root, DEF.weight).querySelector('.ow-perr:not([hidden])')?.textContent).toBe('Use a point as the decimal separator, without grouping');
    expect(controller.dirtyCount).toBe(0);
    input = row(root, DEF.weight).querySelector<HTMLInputElement>('input')!;
    input.value = '2.50';
    key(input, 'Enter');
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.weight).querySelector('.ow-pbox .pt')?.textContent).toBe('2.5');
  });

  it('boolean: the switch is live (a non-historical one)', async () => {
    const s = await testSchema(x => { x.definitions[DEF.enabled] = { configClass: 'BooleanMethodConfig' }; });
    const { root, controller } = mount(object(), s);
    await controller.open(RID);
    await flush();
    const sw = row(root, DEF.enabled).querySelector<HTMLButtonElement>('button.ui-sw')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.enabled).querySelector('button.ui-sw')?.getAttribute('aria-checked')).toBe('false');
    row(root, DEF.enabled).querySelector<HTMLButtonElement>('button.ui-sw')!.click();
    expect(controller.dirtyCount).toBe(0);
  });

  it('list item, more than four items: a searchable menu, chosen by RID, shown by name', async () => {
    const { root, controller } = mount(object(), await testSchema());
    await controller.open(RID);
    await flush();
    expect(row(root, DEF.kind).querySelector('.ow-pbox .pt')?.textContent).toBe('First');
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const q = row(root, DEF.kind).querySelector<HTMLInputElement>('.ow-menu-q')!;
    expect(row(root, DEF.kind).querySelectorAll('.ow-menu-opt')).toHaveLength(6);
    q.value = 'thi';
    q.dispatchEvent(new Event('input'));
    expect([...row(root, DEF.kind).querySelectorAll('.ow-menu-opt .nm')].map(e => e.textContent)).toEqual(['Third']);
    key(q, 'Enter');
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.kind).querySelector('.ow-pbox .pt')?.textContent).toBe('Third');
    // Esc closes the menu without a change.
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const q2 = row(root, DEF.kind).querySelector<HTMLInputElement>('.ow-menu-q')!;
    key(q2, 'ArrowDown');
    key(q2, 'Escape');
    expect(row(root, DEF.kind).querySelector('.ow-menu-q')).toBeNull();
    expect(row(root, DEF.kind).querySelector('.ow-pbox .pt')?.textContent).toBe('Third');
  });

  it('list item, up to four items: a segmented control; arrows move, Enter stages, Esc restores', async () => {
    const s = await testSchema(x => { x.listItems[DEF.kind] = ITEMS.slice(0, 3); });
    const { root, controller } = mount(object(), s);
    await controller.open(RID);
    await flush();
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const group = row(root, DEF.kind).querySelector<HTMLElement>('[role="radiogroup"]')!;
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map(r => r.textContent)).toEqual(['First', 'Second', 'Third']);
    radios[0].focus();
    key(group, 'ArrowRight');
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    key(group, 'Escape');
    expect(controller.dirtyCount).toBe(0);
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const g2 = row(root, DEF.kind).querySelector<HTMLElement>('[role="radiogroup"]')!;
    g2.querySelector<HTMLButtonElement>('[role="radio"]')!.focus();
    key(g2, 'ArrowRight');
    key(g2, 'Enter');
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.kind).querySelector('.ow-pbox .pt')?.textContent).toBe('Second');
  });

  it('multi-line text: an editor anchored to the row; Ctrl+Enter applies, Esc cancels', async () => {
    const { root, controller } = mount(object(), await testSchema());
    await controller.open(RID);
    await flush();
    row(root, DEF.summary).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    let ta = row(root, DEF.summary).querySelector<HTMLTextAreaElement>('.ow-pop textarea')!;
    ta.value = 'x';
    key(ta, 'Escape');
    expect(row(root, DEF.summary).querySelector('.ow-pop')).toBeNull();
    expect(controller.dirtyCount).toBe(0);
    row(root, DEF.summary).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    ta = row(root, DEF.summary).querySelector<HTMLTextAreaElement>('.ow-pop textarea')!;
    ta.value = 'line one\nline two';
    ta.dispatchEvent(new Event('input'));
    key(ta, 'Enter', { ctrlKey: true });
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.summary).querySelector('.ow-pbox')?.textContent).toContain('+1 line');
  });
});

describe('save', () => {
  it('reviews in words, sends the typed change, and says Saved only after the read-back matches', async () => {
    const obj = object();
    const saved = object({ references: { ...obj.references, [DEF.kind]: [ITEMS[2].rid] } });
    // One read: after the write (the changed-since-opened check rides in it).
    const { root, controller, run, review, src } = mount(obj, await testSchema(), { reads: [saved] });
    await controller.open(RID);
    await flush();
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const q = row(root, DEF.kind).querySelector<HTMLInputElement>('.ow-menu-q')!;
    q.value = 'Third';
    q.dispatchEvent(new Event('input'));
    key(q, 'Enter');
    await controller.save();
    expect(review()).toContain('Kind (kind)');
    expect(review()).toContain('First');
    expect(review()).toContain('Third');
    expect(review()).not.toContain(ITEMS[2].rid);
    const steps = run.mock.calls.map(c => c[0] as SaveStep);
    expect(steps).toEqual([{
      route: 'APPLY_CUSTOM_CHANGES', rid: RID, changes: [{ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ITEMS[2].rid }],
      expect: { [DEF.kind]: ITEMS[0].rid },
    }]);
    expect(src.readObjects).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.ow-bar')?.textContent).toContain('Saved 1 change');
    expect(controller.dirtyCount).toBe(0);
  });

  it('a read-back that still holds the old item is not reported as saved', async () => {
    const obj = object();
    const { root, controller } = mount(obj, await testSchema(), { reads: [obj, obj] });
    await controller.open(RID);
    await flush();
    controller.editCustom(RID, DEF.kind, ITEMS[3].rid);
    await controller.save();
    expect(root.querySelector('.ow-bar')?.textContent).not.toContain('Saved');
    // The edit stays, marked, now against what BMP holds.
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.kind).querySelector('.ow-perr')?.textContent).toBe('Not saved: Stored value differs: First');
  });

  it('a value changed in BMP since opened (list item RID, or set where it was absent) holds the save', async () => {
    const obj = object();
    const changed = object({ references: { ...obj.references, [DEF.kind]: [ITEMS[4].rid] }, props: { ...obj.props, [DEF.weight]: { kind: 'number', text: '3', num: 3 } } });
    const { controller, run, conflict, src } = mount(obj, await testSchema(), { reads: [changed] });
    // The worker compares the opened values with its own read and writes nothing.
    run.mockResolvedValueOnce({
      ok: false, notSent: true, error: 'Not saved: changed in BMP since you opened it.', object: changed,
      conflict: [{ prop: DEF.kind, opened: ITEMS[0].rid, current: ITEMS[4].rid }, { prop: DEF.weight, opened: ABSENT, current: '3' }],
    });
    await controller.open(RID);
    await flush();
    controller.editCustom(RID, DEF.kind, ITEMS[1].rid);
    controller.editCustom(RID, DEF.weight, '1');
    await controller.save();
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][0] as Extract<SaveStep, { route: 'APPLY_CUSTOM_CHANGES' }>).expect).toEqual({ [DEF.kind]: ITEMS[0].rid, [DEF.weight]: ABSENT });
    // Nothing was written: no read after it either.
    expect(src.readObjects).not.toHaveBeenCalled();
    expect(conflict()).toContain('Kind (kind) · changed in BMP');
    expect(conflict()).toContain('opened First');
    expect(conflict()).toContain('in BMP now Fifth');
    expect(conflict()).toContain('opened Not set');
    expect(controller.dirtyCount).toBe(2);
  });

  it('the worker refusal shows on the row and nothing is reported saved', async () => {
    const obj = object();
    const { root, controller, run } = mount(obj, await testSchema(), { reads: [obj] });
    run.mockResolvedValueOnce({ ok: false, notSent: true, error: 'Read-only for this type', propErrors: { [DEF.note]: 'Read-only for this type' } });
    await controller.open(RID);
    await flush();
    controller.editCustom(RID, DEF.note, 'X');
    await controller.save();
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.note).querySelector('.ow-perr')?.textContent).toBe('Not saved: Read-only for this type');
    expect(root.querySelector('.ow-bar')?.textContent).not.toContain('Saved');
  });
});

describe('verified or not saved', () => {
  it('a re-read that fails: "Sent, but could not be checked", the rows stay marked', async () => {
    const obj = object();
    const { root, controller, src } = mount(obj, await testSchema(), { reads: [obj] });
    await controller.open(RID);
    await flush();
    controller.editCustom(RID, DEF.kind, ITEMS[2].rid);
    controller.editCustom(RID, DEF.note, 'New');
    // The only window read is the one after the write.
    vi.mocked(src.readObjects).mockImplementation(async () => { throw new Error('connection lost'); });
    await controller.save();
    expect(controller.dirtyCount).toBe(2);
    expect(row(root, DEF.kind).querySelector('.ow-perr')?.textContent).toBe('Not saved: Sent, but could not be checked. Reload to see the stored value.');
    expect(root.querySelector('.ow-bar')?.textContent).not.toContain('Saved 2');
  });

  it('every mismatching entry is named and stays; a matching one leaves the draft', async () => {
    const obj = object();
    const stored = object({ props: { ...obj.props, [DEF.note]: t('Changed by a rule'), [DEF.weight]: { kind: 'number', text: '5', num: 5 } } });
    const { root, controller } = mount(obj, await testSchema(), { reads: [{ ...stored, references: { ...stored.references } }] });
    await controller.open(RID);
    await flush();
    controller.editCustom(RID, DEF.note, 'Mine');
    controller.editCustom(RID, DEF.weight, '7');
    controller.editCustom(RID, DEF.summary, 'x');
    await controller.save();
    expect(controller.dirtyCount).toBe(3);
    expect(row(root, DEF.note).querySelector('.ow-perr')?.textContent).toBe('Not saved: Stored value differs: Changed by a rule');
    expect(row(root, DEF.weight).querySelector('.ow-perr')?.textContent).toBe('Not saved: Stored value differs: 5');
    expect(row(root, DEF.summary).querySelector('.ow-perr')?.textContent).toBe('Not saved: Stored value differs: Not set');
  });
});

describe('filter and unsaved rows', () => {
  it('never hides an unsaved row or its section; marks it as not matching', async () => {
    const { root, controller } = mount(object(), await testSchema());
    await controller.open(RID);
    await flush();
    controller.editCustom(RID, DEF.weight, '3');
    const q = root.querySelector<HTMLInputElement>('.ow-ps-q')!;
    q.value = 'kind';
    q.dispatchEvent(new Event('input'));
    const weight = row(root, DEF.weight);
    expect(weight.hidden).toBe(false);
    expect(weight.classList.contains('ow-nomatch')).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-sec="c:Scoring"]')!.hidden).toBe(false);
    expect(row(root, DEF.score).hidden).toBe(true);
    q.value = '';
    q.dispatchEvent(new Event('input'));
    expect(weight.classList.contains('ow-nomatch')).toBe(false);
  });
});

describe('plan, check and read-back', () => {
  const entry = (definition: string, valueKind: CustomEntry['valueKind'], value: string, base: string, accessor = 'note'): CustomEntry =>
    ({ kind: 'custom', definition, accessor, valueKind, value, base });

  it('plans one APPLY_CUSTOM_CHANGES step and splits large values across posts', () => {
    const obj = object();
    const plans = planSave([
      { rid: RID, prop: DEF.note, entry: entry(DEF.note, 'text', 'a', 'Old note') },
      { rid: RID, prop: DEF.kind, entry: entry(DEF.kind, 'listItem', ITEMS[1].rid, ITEMS[0].rid, 'kind') },
    ], { [RID]: obj });
    expect(plans[0].steps).toHaveLength(1);
    expect(plans[0].opened).toEqual({ [DEF.note]: 'Old note', [DEF.kind]: ITEMS[0].rid });
    expect(plans[0].kinds).toEqual({ [DEF.note]: 'text', [DEF.kind]: 'listItem' });
    const big = (n: number) => ({ prop: DEF.summary + n, entry: entry(DEF.summary, 'multiline', 'x'.repeat(4000), '') });
    // Sized by the generated line: `_o.change(note := "<4000 x>")` is 4,021 characters.
    const { posts, oversized } = splitCustom([big(1), big(2), big(3)], 9_000);
    expect(posts.map(p => p.length)).toEqual([2, 1]);
    expect(oversized).toEqual([]);
    expect(splitCustom([big(1)], 1000).oversized).toHaveLength(1);
    // A custom entry under a key that is not a definition RID is never sent.
    expect(planSave([{ rid: RID, prop: 'showToolMenu', entry: entry('showToolMenu', 'boolean', 'true', 'false') }], { [RID]: obj })[0].rejected).toHaveLength(1);
  });

  it('checks list items in references and "absent" by kind', () => {
    const obj = object();
    expect(checkAgainstRead({ [DEF.kind]: ITEMS[0].rid, [DEF.weight]: ABSENT }, obj, undefined, { [DEF.kind]: 'listItem', [DEF.weight]: 'number' }).state).toBe('unchanged');
    const moved = object({ references: { [DEF.kind]: [ITEMS[1].rid] } });
    const c = checkAgainstRead({ [DEF.kind]: ITEMS[0].rid }, moved, undefined, { [DEF.kind]: 'listItem' });
    expect(c).toMatchObject({ state: 'changed', changes: [{ prop: DEF.kind, opened: ITEMS[0].rid, current: ITEMS[1].rid }] });
    const set = object({ props: { [DEF.weight]: { kind: 'number', text: '0', num: 0 } } });
    expect(checkAgainstRead({ [DEF.weight]: ABSENT }, set, undefined, { [DEF.weight]: 'number' }).state).toBe('changed');
  });

  it('the read-back compares every kind for real', () => {
    const o = object({ props: { [DEF.weight]: { kind: 'number', text: '2.5', num: 2.5 }, [DEF.note]: t('A') }, references: { [DEF.kind]: [ITEMS[1].rid] } });
    expect(customStored(entry(DEF.weight, 'number', '2.50', ABSENT), DEF.weight, o)).toBe(true);
    expect(customStored(entry(DEF.weight, 'number', '3', ABSENT), DEF.weight, o)).toBe(false);
    expect(customStored(entry(DEF.kind, 'listItem', ITEMS[1].rid, ITEMS[0].rid), DEF.kind, o)).toBe(true);
    expect(customStored(entry(DEF.kind, 'listItem', ITEMS[2].rid, ITEMS[0].rid), DEF.kind, o)).toBe(false);
    expect(customStored(entry(DEF.note, 'text', 'A', ''), DEF.note, o)).toBe(true);
    // Absent after a write never counts as stored.
    expect(customStored(entry(DEF.summary, 'multiline', 'x', ABSENT), DEF.summary, o)).toBe(false);
    expect(customStored(entry(DEF.enabled, 'boolean', 'false', 'true'), DEF.enabled, o)).toBe(false);
  });
});
