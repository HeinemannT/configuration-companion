// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, ObjectSummary, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, formatMs, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import { buildStructureEc } from '../../lib/object-structure';
import { typeInfo } from '../../lib/object-window-table';
import { parseInbound } from '../../lib/connections';
import type { PropertyApplication } from '../../lib/types';
import { framedText } from '../../lib/ec-parser';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });

function obj(rid: string, type: string, name: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}, businessId = `b${rid.slice(-4)}`): FullObject {
  return { rid, type, name, businessId, props: { name: t(name), id: t(businessId), ...props }, references, overridden: [] };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

const VIEW = '1304972940111718401', SET = '1521507040334396171', FIELD = '5228949194259858465';
const OTHER_VIEW = '2081208944661642130', TPL = '7000000000000000001', DEF = '8147890623498142305';

function inputView(): ObjectRootPayload {
  return {
    rid: VIEW, root: obj(VIEW, 'InputView', 'Main view', {}, { inputSet: [SET] }),
    rows: [{ rid: SET, parent: VIEW }, { rid: FIELD, parent: SET }],
    nodes: { [SET]: obj(SET, 'InputSet', 'Shared set'), [FIELD]: obj(FIELD, 'TextInput', 'Field') },
    posts: 2, ms: 10,
  };
}

function src(payloads: Record<string, ObjectRootPayload>, summaries: ObjectSummary[] = [], extra: Partial<ObjectWindowSource> = {}): ObjectWindowSource {
  return {
    openRoot: vi.fn(async (rid: string) => { const p = payloads[rid]; if (!p) throw new Error('nope'); return p; }),
    readSummaries: vi.fn(async (rids: string[]) => summaries.filter(s => rids.includes(s.rid))),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })),
    run: vi.fn(async () => ({ ok: true })),
    ...extra,
  };
}

function mount(source: ObjectWindowSource, more: Partial<ViewHandlers> = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); },
    back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(),
    openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    revert: vi.fn(), toggleReset: vi.fn(), discard: vi.fn(), save: () => { void controller.save(); },
    setTarget: tg => controller.setTarget(tg), compare: vi.fn(), access: vi.fn(),
    scanInbound: o => controller.scanInbound(o),
    cancelInbound: rid => controller.cancelInbound(rid),
    loadApplications: rid => controller.loadApplications(rid),
    togglePin: () => controller.togglePin(),
    ...more,
  };
  const view = new ObjectWindowView(root, handlers);
  controller = new ObjectWindowController(view, source);
  return { root, view, controller };
}

const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find(b => b.textContent?.includes(text));

describe('Used by', () => {
  it('is not loaded on open; the scan shows progress, then grouped rows that navigate in the window', async () => {
    let resolve!: (v: { targets: Array<ObjectSummary & { field?: string }>; total?: number }) => void;
    const inbound = vi.fn(() => new Promise<{ targets: Array<ObjectSummary & { field?: string }>; total?: number }>(r => { resolve = r; }));
    const { root, view, controller } = mount(src({ [VIEW]: inputView(), [OTHER_VIEW]: { ...inputView(), rid: OTHER_VIEW, root: obj(OTHER_VIEW, 'InputView', 'Other view', {}, { inputSet: [SET] }) } }, [], { inbound }));
    await controller.open(VIEW);
    await flush();
    view.select(SET);
    expect(inbound).not.toHaveBeenCalled();
    button(root, 'Scan for other references')!.click();
    expect(inbound).toHaveBeenCalledWith(SET, 'InputSet');
    expect(root.querySelector('.ow-scan')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('.ow-scan-t')?.textContent).toMatch(/^Scanning references · \d+ s$/);
    resolve({
      targets: [
        { rid: VIEW, name: 'Main view', type: 'InputView', businessId: 'mv' },
        { rid: OTHER_VIEW, name: 'Other view', type: 'InputView', businessId: 'ov' },
        { rid: '42', name: 'Risk', type: 'CeRisk', businessId: 'r', field: 'Risks' },
      ],
      total: 3,
    });
    await flush();
    const head = root.querySelector('.ow-use-h.sub')!;
    expect(head.querySelector('.n')?.textContent).toBe('3');
    const all = [...head.parentElement!.children];
    const subs = all.slice(all.indexOf(head)).filter(e => e.classList.contains('ow-rel-h')).map(h => h.textContent);
    expect(subs).toEqual(['Input view 2', 'Risks 1']);
    // The InputSet's tree row says it is shared.
    const row = root.querySelector(`[data-rid="${SET}"] .ow-use`);
    expect(row?.textContent).toBe('shared · used by 2 views');
    // A row of another view opens it as the window root.
    const other = [...root.querySelectorAll('.ow-rel button')].find(b => b.textContent === 'Other view') as HTMLButtonElement;
    other.click();
    await flush();
    expect(controller.current).toBe(OTHER_VIEW);
  });

  it('lists "In code" at once from the code index, before the scan for other references', async () => {
    const usedInCode = vi.fn(async () => ({ targets: [{ rid: '42', name: 'Calls the set', type: 'ExtendedExpression', businessId: 'calls_set', places: 3 }], coverage: { kind: 'index' as const, objects: 3025, at: null, noun: ['object with code', 'objects with code'] as [string, string] } }));
    const { root, view, controller } = mount(src({ [VIEW]: inputView() }, [], { usedInCode }), { usedInCode: o => controller.loadInCode(o) });
    await controller.open(VIEW);
    view.select(SET);
    await flush();
    expect(usedInCode).toHaveBeenCalledWith(expect.objectContaining({ rid: SET }));
    const subs = [...root.querySelectorAll('.ow-use-h.sub .t')].map(e => e.textContent);
    expect(subs).toEqual(['In code', 'By reference']);
    expect(root.querySelector('.ow-use-h.sub .n')?.textContent).toBe('1');
    expect([...root.querySelectorAll('.ow-rel button')].some(b => b.textContent?.includes('Calls the set'))).toBe(true);
    expect(button(root, 'Scan for other references')).toBeTruthy();
    expect(root.textContent).not.toContain('Scan workspace');
    // The answer says what it covers.
    expect(root.querySelector('.ow-coverage')?.textContent).toBe('Searched 3,025 objects with code in the copy.');
    // An index that is not ready says so.
    const notReady = mount(src({ [VIEW]: inputView() }, [], { usedInCode: async () => ({ targets: null, coverage: { kind: 'not-searched' as const, reason: 'no code copy on this computer' } }) }), { usedInCode: o => notReady.controller.loadInCode(o) });
    await notReady.controller.open(VIEW);
    await flush();
    expect(notReady.root.textContent).toContain('Not searched: no code copy on this computer.');
    expect([...notReady.root.querySelectorAll('button')].some(b => b.textContent?.includes('Search now'))).toBe(true);
  });

  it('answers in one line after the scan and lists the instances on their own', async () => {
    const inbound = vi.fn(async () => ({
      targets: [
        { rid: '42', name: 'Risk', type: 'CeRisk', businessId: 'r' },
        { rid: '43', name: 'Copy of the set', type: 'InputSet', businessId: 'c' },
      ],
      total: 2,
      instances: { total: 30, targets: [{ rid: '43', name: 'Copy of the set', type: 'InputSet', businessId: 'c' }] },
    }));
    const usedInCode = vi.fn(async () => ({ targets: [{ rid: '44', name: 'Calls the set', type: 'ExtendedExpression', businessId: 'calls_set', places: 1 }], coverage: { kind: 'index' as const, objects: 10, at: null } }));
    const { root, view, controller } = mount(src({ [VIEW]: inputView() }, [], { inbound, usedInCode }), { usedInCode: o => controller.loadInCode(o) });
    await controller.open(VIEW);
    view.select(SET);
    await flush();
    expect(root.querySelector('.ow-use-sum')).toBeNull();
    button(root, 'Scan for other references')!.click();
    await flush();
    const sum = root.querySelector('.ow-use-sum')!;
    expect(sum.getAttribute('data-found')).toBe('true');
    expect(sum.querySelector('.h')?.textContent).toBe('32 objects refer to this object.');
    expect(sum.textContent).toContain('It is the template of 30 objects.');
    const heads = [...root.querySelectorAll('.ow-rel-h')].map(h => h.textContent);
    expect(heads).toContain('Instances 30');
    // The instance is not listed a second time under its type.
    expect(heads.some(h => h?.startsWith('Input set'))).toBe(false);
    expect(root.textContent).toContain('Showing the first 1 of 30.');
  });

  it('a template that only its instances refer to is not reported as free', async () => {
    const inbound = async () => ({ targets: [], total: 0, instances: { total: 1, targets: [{ rid: '43', name: 'Landing Page', type: 'Scorecard', businessId: 'lp' }] } });
    const { root, view, controller } = mount(src({ [VIEW]: inputView() }, [], { inbound }));
    await controller.open(VIEW);
    view.select(SET);
    button(root, 'Scan for other references')!.click();
    await flush();
    expect(root.querySelector('.ow-use-sum .h')?.textContent).toBe('1 object refers to this object.');
    expect(root.textContent).toContain('It is the template of 1 object.');
    expect([...root.querySelectorAll('.ow-rel-h')].map(h => h.textContent)).toContain('Instances 1');
    expect(root.textContent).not.toContain('Nothing refers to this object.');
  });

  it('says "nothing found", not "unused", when the scan finds nothing', async () => {
    const { root, view, controller } = mount(src({ [VIEW]: inputView() }, [], { inbound: async () => ({ targets: [], total: 0 }) }));
    await controller.open(VIEW);
    view.select(SET);
    button(root, 'Scan for other references')!.click();
    await flush();
    const sum = root.querySelector('.ow-use-sum')!;
    expect(sum.getAttribute('data-found')).toBe('false');
    expect(sum.textContent).toContain('Nothing found that refers to this object.');
    expect(sum.textContent).toContain('Code was not checked.');
    expect(root.textContent).not.toMatch(/unused/i);
  });

  it('cancel drops the scan and tells the service worker', async () => {
    const cancelInbound = vi.fn();
    const { root, view, controller } = mount(src({ [VIEW]: inputView() }, [], { inbound: () => new Promise(() => undefined), cancelInbound }));
    await controller.open(VIEW);
    view.select(SET);
    button(root, 'Scan for other references')!.click();
    button(root, 'Cancel')!.click();
    expect(cancelInbound).toHaveBeenCalledWith(SET);
    expect(root.querySelector('.ow-scan')).toBeNull();
    expect(button(root, 'Scan for other references')).toBeTruthy();
  });

  it('a capped scan says how many it shows; a failed scan offers to scan again', async () => {
    const targets = [{ rid: '42', name: 'A', type: 'Kpi', businessId: 'a' }];
    let fail = false;
    const { root, controller } = mount(src({ [VIEW]: inputView() }, [], {
      inbound: vi.fn(async () => { if (fail) throw new Error('timeout'); return { targets, total: 10519, capped: true }; }),
    }));
    await controller.open(VIEW);
    button(root, 'Scan for other references')!.click();
    await flush();
    expect(root.querySelector('.ow-use-h .n')?.textContent).toBe('10519');
    expect([...root.querySelectorAll('.ow-note')].map(n => n.textContent)).toContain('Showing the first 1 of 10519.');
    fail = true;
    (root.querySelector('.ow-use-h button[aria-label="Scan again"]') as HTMLButtonElement).click();
    await flush();
    const failed = root.querySelector('.ow-use-h + .ui-failed');
    expect(failed?.querySelector('.ui-failed-t')?.textContent).toBe('The scan failed.');
    // The reason is reachable without hovering, and Retry runs it again.
    expect(failed?.querySelector('.ui-failed-detail')?.textContent).toBe('timeout');
    expect(failed?.querySelector('.ui-failed-retry')?.textContent).toBe('Retry');
  });

  it('formats the scan time', () => {
    expect(formatMs(470)).toBe('470 ms');
    expect(formatMs(4200)).toBe('4.2 s');
    expect(formatMs(65_000)).toBe('1 min 5 s');
  });
});

describe('property applications', () => {
  const def = (): ObjectRootPayload => ({
    rid: DEF, root: obj(DEF, 'HistoricalTextMethodConfig', 'Causes', { expression: code('') }, { parent: ['9'] }, 'causes'),
    rows: null, nodes: {}, posts: 1, ms: 5,
  });

  it('a property definition offers "Applied to", loads on request and folds out overrides', async () => {
    const applications = vi.fn(async () => ({
      applications: <PropertyApplication[]>[
        { classId: 'CeRisk', application: { rid: '501', businessId: 'risk.causes', name: 'Causes', type: 'HistoricalTextMethodConfig' }, overrides: { name: "'Root causes'" } },
        { classId: 'CeIssue', application: { rid: '502', businessId: 'issue.causes', name: 'Causes', type: 'HistoricalTextMethodConfig' }, overrides: {} },
      ],
      total: 2, truncated: false,
    }));
    const { root, controller } = mount(src({ [DEF]: def() }, [], { applications }));
    await controller.open(DEF);
    expect(applications).not.toHaveBeenCalled();
    button(root, 'Find applications')!.click();
    await flush();
    expect(applications).toHaveBeenCalledWith(DEF);
    const sec = [...root.querySelectorAll('.ow-sec')].find(s => s.querySelector('.ow-sec-h .t')?.textContent === 'Applied to')!;
    expect(sec.querySelector('.ow-sec-h .n')?.textContent).toBe('2');
    expect([...sec.querySelectorAll('.ow-rel .rt')].map(e => e.textContent)).toEqual(['inherited', '1 override']);
    expect(sec.querySelector('details.ow-app .gv')?.textContent).toBe('Root causes');
  });

  it('a per-type application (linkedTo a master) is not a definition', async () => {
    const p = def();
    p.root.references.linkedTo = ['77'];
    const { root, controller } = mount(src({ [DEF]: p }, [], { applications: vi.fn() }));
    await controller.open(DEF);
    expect(button(root, 'Find applications')).toBeUndefined();
  });
});

describe('header pin and identity chips', () => {
  it('pins the root through the source and reflects the state', async () => {
    const togglePin = vi.fn(async () => [VIEW]);
    const { root, controller } = mount(src({ [VIEW]: inputView() }, [], { pins: async () => [], togglePin }));
    controller.loadPins();
    await controller.open(VIEW);
    const pin = root.querySelector<HTMLButtonElement>('.ow-pin')!;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pin.click();
    expect(togglePin).toHaveBeenCalledWith(expect.objectContaining({ rid: VIEW, name: 'Main view', type: 'InputView' }));
    await flush();
    expect(root.querySelector('.ow-pin')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a linked instance shows Template ID and Instance ID when they differ; one ID otherwise', async () => {
    const linked: ObjectRootPayload = { rid: VIEW, root: obj(VIEW, 'CreateObjectView', 'Create process', {}, { linkedTo: [TPL] }, '454'), rows: null, nodes: {}, posts: 1, ms: 1 };
    const { root, controller } = mount(src({ [VIEW]: linked }, [{ rid: TPL, name: 'Create process', type: 'CreateObjectView', businessId: 'process_create' }]));
    await controller.open(VIEW);
    await flush();
    const chips = () => [...root.querySelectorAll('.ow-sub-ids .ow-chip')].map(c => `${c.querySelector('.k')?.textContent}=${c.querySelector('.v')?.textContent}`);
    expect(chips()).toEqual(['Template ID=process_create', 'Instance ID=454', `RID=${VIEW}`]);

    const same = mount(src({ [VIEW]: linked }, [{ rid: TPL, name: 'Create process', type: 'CreateObjectView', businessId: '454' }]));
    await same.controller.open(VIEW);
    await flush();
    expect([...same.root.querySelectorAll('.ow-sub-ids .ow-chip .k')].map(k => k.textContent)).toEqual(['ID', 'RID']);
  });

  it('offers a page reload after a save', async () => {
    const reloadPage = vi.fn();
    const p = inputView();
    p.root.props.description = t('');
    const { root, controller } = mount(src({ [VIEW]: p }), { reloadPage });
    await controller.open(VIEW);
    controller.edit(VIEW, 'name', 'Renamed', 'Main view');
    await controller.save();
    button(root, 'Reload page')!.click();
    expect(reloadPage).toHaveBeenCalled();
  });
});

describe('flow structure rules', () => {
  it('ActionButton → action object → its children, with the Code marker', () => {
    const info = typeInfo('ActionButton');
    expect(info.structure).toEqual({ via: 'actionObject', depth: 1 });
    expect(info.slots.map(s => s.letter)).toEqual(['C']);
    const ec = buildStructureEc('lookup(1)', info.structure!);
    // An unset action object lists the root alone instead of failing.
    expect(ec).toContain('IF _s != MISSING THEN');
    expect(ec).toContain('_s.children().forEach(_c1:');
    expect(ec).not.toContain('_c2');
  });

  it('CreateObjectView → editPage → fields with the EditPage markers; transport groups list transports', () => {
    expect(typeInfo('CreateObjectView').structure).toEqual({ via: 'editPage', depth: 1 });
    expect(typeInfo('CreateObjectView').slots).toBe(typeInfo('EditPage').slots);
    expect(typeInfo('NotificationTransportGroup').structure).toEqual({ depth: 1 });
    const transport = obj('3', 'ExtendedTransport', 'Mail', { expression: code('send()') });
    expect(typeInfo('NotificationTransportGroup').slots[0].test(transport)).toBe(true);
    expect(typeInfo('Label').blocks).toContain('expression');
  });

  it('the inbound scan reports its own total past the cap', () => {
    const log = framedText([...[['1', 'a', 'A', 'Kpi'], ['2', 'b', 'B', 'Kpi'], ['3', 'c', 'C', 'Kpi']].map(row => ['i', '', ...row]), ['n', '10519']]);
    expect(parseInbound(log, 2)).toEqual({ targets: [expect.objectContaining({ rid: '1' }), expect.objectContaining({ rid: '2' })], capped: true, total: 10519 });
  });
});
