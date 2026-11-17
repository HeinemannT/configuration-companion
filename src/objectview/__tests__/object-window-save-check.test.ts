// @vitest-environment happy-dom
/**
 * Object window save: changed-since-opened check, lost answers and read-back.
 * A fake BMP (`server`) holds the stored objects; the controller and the
 * save plan are the production ones.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { planSave, runSave, checkAgainstRead, readBackEquals, type SaveOutcome, type SaveStep } from '../window/save-plan';
import { WindowDraft } from '../window/draft';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import type { ConflictChoice, ConflictContent } from '../window/review';
import { storedDiffersLine, unknownOutcomeLine } from '../../lib/save-check';

const VIEW = '1304972940111718401';
const SET = '1521507040334396171';
const BTN = '9007199254740993';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });
const num = (n: number): PropValue => ({ kind: 'number', text: String(n), num: n });

function obj(rid: string, type: string, name: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}): FullObject {
  return { rid, type, name, businessId: `id_${rid.slice(-4)}`, props: { name: t(name), id: t(`id_${rid.slice(-4)}`), ...props }, references, overridden: [] };
}

/** The fake BMP: stored objects, changed by writes and by "someone else". */
function server() {
  const store: Record<string, FullObject> = {
    [VIEW]: obj(VIEW, 'InputView', 'Update date', { shadow: bool(true), columnsLargeScreen: num(6) }, { inputSet: [SET] }),
    [SET]: obj(SET, 'InputSet', 'Inputs', {}, { parent: [VIEW] }),
    [BTN]: obj(BTN, 'ButtonInput', 'Write', { useShowExpression: bool(false), showExpression: code(''), expression: code('a := 1') }, { parent: [SET] }),
  };
  const clone = (o: FullObject): FullObject => JSON.parse(JSON.stringify(o)) as FullObject;
  const set = (rid: string, prop: string, v: PropValue) => {
    store[rid] = { ...store[rid], props: { ...store[rid].props, [prop]: v } };
    if (prop === 'name') store[rid].name = v.text;
    if (prop === 'id') store[rid].businessId = v.text;
  };
  const apply = (step: SaveStep) => {
    if (step.route === 'APPLY_OBJECT_CHANGES') {
      for (const [p, v] of Object.entries(step.changes)) set(step.rid, p, typeof v === 'boolean' ? bool(v) : typeof v === 'number' ? num(v) : t(v));
    } else if (step.route === 'SAVE_PROPERTY') set(step.rid, step.property, code(step.value));
    else if (step.route === 'SAVE_IDENTITY') {
      if (step.name !== undefined) set(step.rid, 'name', t(step.name));
      if (step.businessId !== undefined) set(step.rid, 'id', t(step.businessId));
    }
  };
  return { store, clone, set, apply };
}

function payload(store: Record<string, FullObject>): ObjectRootPayload {
  return {
    rid: VIEW, root: store[VIEW],
    rows: [{ rid: SET, parent: VIEW }, { rid: BTN, parent: SET }],
    nodes: { [SET]: store[SET], [BTN]: store[BTN] }, posts: 1, ms: 1,
  };
}

function mount(opts: {
  run?: (step: SaveStep, srv: ReturnType<typeof server>) => Promise<SaveOutcome>;
  readObjects?: ObjectWindowSource['readObjects'];
  choose?: ConflictChoice;
  confirmSave?: () => Promise<boolean>;
} = {}) {
  const srv = server();
  const runs: SaveStep[] = [];
  const reads: string[][] = [];
  const conflicts: ConflictContent[] = [];
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async () => JSON.parse(JSON.stringify(payload(srv.store))) as ObjectRootPayload),
    readSummaries: vi.fn(async () => []),
    fieldList: vi.fn(async () => []),
    readObjects: opts.readObjects ?? vi.fn(async (rids: string[]) => {
      reads.push(rids);
      return { objects: Object.fromEntries(rids.filter(r => srv.store[r]).map(r => [r, srv.clone(srv.store[r])])), errors: {} };
    }),
    run: vi.fn(async (step: SaveStep) => {
      runs.push(step);
      if (opts.run) return opts.run(step, srv);
      srv.apply(step);
      return { ok: true };
    }),
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); },
    back: () => undefined, forward: () => undefined, retry: () => undefined,
    copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: (rid, prop, base) => controller.toggleReset(rid, prop, base),
    discard: () => undefined,
    save: () => { void controller.save(); },
    setTarget: tg => controller.setTarget(tg),
    compare: vi.fn(), access: vi.fn(),
  };
  const view = new ObjectWindowView(root, handlers, {});
  controller = new ObjectWindowController(view, src, {
    confirmSave: opts.confirmSave ?? (async () => true),
    unknownRereadDelayMs: 0,
    resolveConflict: async c => { conflicts.push(c); return opts.choose ?? 'cancel'; },
  });
  // The bar's one line once the draft is empty; with entries left, the
  // per-object error (shown under "Not saved: …" and in the detail pane).
  const note = () => root.querySelector('.ow-bar-long')?.textContent ?? '';
  const model = () => (view as unknown as { model: { draft: WindowDraft; saveNote?: string } }).model;
  return { root, view, controller, src, srv, runs, reads, conflicts, note, model };
}

describe('changed-since-opened check (object window)', () => {
  it('unchanged: one check read per object, then exactly the writes of today, then one re-read', async () => {
    const m = mount();
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(VIEW, 'shadow', 'false', 'true');
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    // What is written is what planSave produced without any check.
    const expected = planSave(new WindowDraftFrom([[VIEW, 'shadow', 'false', 'true'], [BTN, 'expression', 'a := 2', 'a := 1']]).items(), m.srv.store)
      .flatMap(p => p.steps.map(s => s.step));
    await m.controller.save();
    expect(m.runs).toEqual(expected);
    expect(m.runs).toEqual([
      { route: 'APPLY_OBJECT_CHANGES', rid: VIEW, changes: { shadow: false }, resetProps: [] },
      { route: 'SAVE_PROPERTY', rid: BTN, objectType: 'ButtonInput', property: 'expression', value: 'a := 2', valueKind: 'code' },
    ]);
    expect(m.reads).toEqual([[VIEW], [BTN], [VIEW, BTN]]);
    expect(m.conflicts).toHaveLength(0);
    expect(m.controller.dirtyCount).toBe(0);
    expect(m.note()).toBe('Saved 2 changes');
  });

  it('changed in BMP: nothing is written to it, the dialog shows opened, current and yours; Cancel keeps the draft', async () => {
    const m = mount({ choose: 'cancel' });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    m.srv.set(BTN, 'expression', code('a := 99')); // someone else, after opening
    await m.controller.save();
    expect(m.runs).toEqual([]);
    expect(m.conflicts).toHaveLength(1);
    const dialog = document.createElement('div');
    dialog.append(...m.conflicts[0].body);
    expect(m.conflicts[0].title).toBe('Changed in BMP since you opened it');
    expect(m.conflicts[0].choices.map(c => c.label)).toEqual(['Review', 'Overwrite']);
    expect(dialog.textContent).toContain('Held back 1 object: nothing was written to it.');
    expect(dialog.textContent).toContain('In BMP now: 1 line (+1 −1) · yours: 1 line (+1 −1)');
    expect(dialog.querySelector('.ow-ld-row.add')?.textContent).toContain('a := 99');
    expect(m.controller.dirtyCount).toBe(1);
    expect(m.srv.store[BTN].props.expression.text).toBe('a := 99');
    expect(m.model().draft.errorFor(BTN)).toBe('Not saved: changed in BMP since you opened it.');
    expect(m.model().saveNote).toBe('1 object held back: changed in BMP since you opened it');
    expect(m.root.querySelector('.ow-bar-err')?.textContent).toBe('Not saved: Write');
  });

  it('Review loads the current BMP value as the new base, keeps the edit and opens the review again; confirming it writes', async () => {
    // The review is shown twice by one save: before the check, and again
    // after "Review" in the conflict dialog. The second one is declined here.
    const answers = [true, false, true];
    let reviews = 0;
    const m = mount({ choose: 'review', confirmSave: async () => answers[reviews++] });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(VIEW, 'columnsLargeScreen', '3', '6');
    m.srv.set(VIEW, 'columnsLargeScreen', num(4));
    await m.controller.save();
    expect(reviews).toBe(2);
    expect(m.conflicts).toHaveLength(1);
    expect(m.runs).toEqual([]);
    expect(m.model().draft.get(VIEW, 'columnsLargeScreen')).toEqual({ kind: 'value', value: '3', base: '4' });
    expect(m.model().draft.errorFor(VIEW)).toContain('Changed in BMP since you opened it');
    await m.controller.save();
    expect(m.runs).toEqual([{ route: 'APPLY_OBJECT_CHANGES', rid: VIEW, changes: { columnsLargeScreen: 3 }, resetProps: [] }]);
    expect(m.controller.dirtyCount).toBe(0);
  });

  it('Overwrite writes the user value knowingly, with no second check', async () => {
    const m = mount({ choose: 'overwrite' });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    m.srv.set(BTN, 'expression', code('a := 99'));
    await m.controller.save();
    expect(m.runs).toEqual([{ route: 'SAVE_PROPERTY', rid: BTN, objectType: 'ButtonInput', property: 'expression', value: 'a := 2', valueKind: 'code' }]);
    expect(m.reads).toEqual([[BTN], [BTN]]); // the check, then the re-read
    expect(m.srv.store[BTN].props.expression.text).toBe('a := 2');
    expect(m.note()).toBe('Saved 1 change');
  });

  it('the check cannot read: Save anyway or Cancel, never a silent write', async () => {
    const srvReads: string[][] = [];
    let fail = true;
    const m = mount({
      choose: 'cancel',
      readObjects: vi.fn(async (rids: string[]) => {
        srvReads.push(rids);
        if (fail) return { objects: {}, errors: Object.fromEntries(rids.map(r => [r, 'Object read failed'])) };
        return { objects: {}, errors: {} };
      }),
    });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(VIEW, 'shadow', 'false', 'true');
    await m.controller.save();
    expect(m.runs).toEqual([]);
    expect(m.conflicts[0].title).toBe('Could not check for changes in BMP');
    expect(m.conflicts[0].choices).toEqual([{ id: 'overwrite', label: 'Save anyway', variant: 'danger' }]);
    const body = document.createElement('div');
    body.append(...m.conflicts[0].body);
    expect(body.textContent).toContain('Could not check whether it changed in BMP since you opened it: Object read failed');
    fail = false;
  });

  it('several objects: the unaffected object saves, the changed one is held and listed', async () => {
    const m = mount({ choose: 'cancel' });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(VIEW, 'shadow', 'false', 'true');
    m.controller.edit(BTN, 'useShowExpression', 'true', 'false');
    m.srv.set(BTN, 'useShowExpression', bool(true));
    await m.controller.save();
    expect(m.runs).toEqual([{ route: 'APPLY_OBJECT_CHANGES', rid: VIEW, changes: { shadow: false }, resetProps: [] }]);
    const body = document.createElement('div');
    body.append(...m.conflicts[0].body);
    expect(body.textContent).toContain('Saved 1 object. Held back 1 object');
    expect(body.textContent).toContain('Write');
    expect(body.textContent).toContain('Use show expression · changed in BMP');
    expect(body.textContent).toContain('opened off');
    expect(body.textContent).toContain('in BMP now on · yours on');
    expect(m.controller.dirtyCount).toBe(1);
    expect(m.model().saveNote).toBe('Saved 1; 1 object held back: changed in BMP since you opened it');
  });

  it('identity only: no extra read; SAVE_IDENTITY carries the edited field and its opened value', async () => {
    const m = mount({
      run: async step => (step.route === 'SAVE_IDENTITY'
        ? { ok: false, notSent: true, error: 'ID changed in BMP since you opened it. Nothing was saved.', conflict: [{ prop: 'id', opened: 'id_0993', current: 'other_id' }] }
        : { ok: true }),
    });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'id', 'new_id', 'id_0993');
    await m.controller.save();
    expect(m.reads).toEqual([]);
    expect(m.runs).toEqual([{ route: 'SAVE_IDENTITY', rid: BTN, businessId: 'new_id', expect: { businessId: 'id_0993' } }]);
    expect(m.conflicts).toHaveLength(1);
    expect(m.controller.dirtyCount).toBe(1);
  });
});

describe('a write whose answer did not arrive (object window)', () => {
  const lost = (applied: boolean) => async (step: SaveStep, srv: ReturnType<typeof server>): Promise<SaveOutcome> => {
    if (applied) srv.apply(step);
    return { ok: false, unknown: true, error: 'No response from the extension. BMP may have saved; the object was re-read.' };
  };

  it('re-read shows the value: saved after all', async () => {
    const m = mount({ run: lost(true) });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    await m.controller.save();
    expect(m.runs).toHaveLength(1); // never retried
    expect(m.note()).toBe(unknownOutcomeLine('saved'));
    expect(m.controller.dirtyCount).toBe(0);
  });

  it('re-read shows the old value: not saved, the edit stays', async () => {
    const m = mount({ run: lost(false) });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    await m.controller.save();
    expect(m.runs).toHaveLength(1);
    expect(m.model().saveNote).toBe(unknownOutcomeLine('not-saved'));
    expect(m.model().draft.errorFor(BTN)).toBe(unknownOutcomeLine('not-saved'));
    expect(m.controller.dirtyCount).toBe(1);
  });

  it('re-read fails: could not check', async () => {
    let calls = 0;
    const srvRef: { s?: ReturnType<typeof server> } = {};
    const m = mount({
      run: lost(true),
      readObjects: vi.fn(async (rids: string[]) => {
        calls++;
        if (calls > 1) throw new Error('BMP did not answer');
        const s = srvRef.s!;
        return { objects: Object.fromEntries(rids.map(r => [r, s.clone(s.store[r])])), errors: {} };
      }),
    });
    srvRef.s = m.srv;
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    await m.controller.save();
    expect(m.model().saveNote).toBe(unknownOutcomeLine('unverified'));
    expect(m.model().draft.errorFor(BTN)).toBe(unknownOutcomeLine('unverified'));
    expect(m.controller.dirtyCount).toBe(1);
  });
});

describe('read-back after a save (object window)', () => {
  it('BMP stored something else: shows the stored value and says it differs', async () => {
    const m = mount({
      run: async (step, srv) => {
        srv.apply(step);
        if (step.route === 'SAVE_PROPERTY') srv.set(step.rid, step.property, code('a := 2 // normalised'));
        return { ok: true };
      },
    });
    await m.controller.open(VIEW, { type: 'InputView' });
    m.controller.edit(BTN, 'expression', 'a := 2', 'a := 1');
    await m.controller.save();
    expect(m.note()).toBe(storedDiffersLine('Expression', 'a := 2 // normalised'));
  });
});

describe('save plan check rules', () => {
  it('compares booleans, numbers, RIDs and empty against missing without false alarms', () => {
    const fresh = obj(BTN, 'ButtonInput', 'Write', { useShowExpression: bool(false), sortIndex: num(7), ref: t('9007199254740993') });
    expect(checkAgainstRead({ useShowExpression: 'false', sortIndex: '7', ref: '9007199254740993', showExpression: '' }, fresh))
      .toMatchObject({ state: 'unchanged' });
    expect(checkAgainstRead({ ref: '9007199254740992' }, fresh)).toMatchObject({
      state: 'changed', changes: [{ prop: 'ref', opened: '9007199254740992', current: '9007199254740993' }],
    });
    expect(checkAgainstRead({ x: '' }, undefined, 'gone')).toEqual({ state: 'unreadable', error: 'gone' });
  });

  it('read-back compares numbers as numbers and trims identity values', () => {
    expect(readBackEquals('columnsLargeScreen', '3.0', num(3))).toBe(true);
    expect(readBackEquals('name', ' Write ', t('Write'))).toBe(true);
    expect(readBackEquals('useShowExpression', 'true', bool(false))).toBe(false);
    expect(readBackEquals('expression', 'a', code('a\n'))).toBe(false);
  });

  it('force skips the check and drops the identity expectation (Overwrite)', async () => {
    const d = new WindowDraft();
    const srv = server();
    d.set(BTN, 'name', 'Mine', 'Write');
    d.set(BTN, 'useShowExpression', 'true', 'false');
    const plans = planSave(d.items(), srv.store);
    const runs: SaveStep[] = [];
    const check = vi.fn(async () => ({ state: 'changed' as const, changes: [] }));
    const res = await runSave(plans, { run: async s => { runs.push(s); return { ok: true }; }, check }, { force: true });
    expect(check).not.toHaveBeenCalled();
    expect(runs).toEqual([
      { route: 'APPLY_OBJECT_CHANGES', rid: BTN, changes: { useShowExpression: true }, resetProps: [] },
      { route: 'SAVE_IDENTITY', rid: BTN, name: 'Mine' },
    ]);
    expect(res[0].saved).toHaveLength(2);
  });
});

/** A draft built from [rid, prop, value, base] rows. */
class WindowDraftFrom extends WindowDraft {
  constructor(rows: Array<[string, string, string, string]>) {
    super();
    for (const [rid, prop, value, base] of rows) this.set(rid, prop, value, base);
  }
}
