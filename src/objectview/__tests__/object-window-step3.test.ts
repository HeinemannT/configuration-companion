// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FullObject, ObjectSummary, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });

function obj(rid: string, type: string, name: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}): FullObject {
  return { rid, type, name, businessId: `b${rid.slice(-4)}`, props: { name: t(name), ...props }, references, overridden: [] };
}

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };

type Src = ObjectWindowSource & {
  openRoot: Mock<ObjectWindowSource['openRoot']>;
  readSummaries: Mock<ObjectWindowSource['readSummaries']>;
  fieldList: Mock<ObjectWindowSource['fieldList']>;
};

function answerOf(all: readonly ObjectSummary[], rids: readonly string[]) {
  const found = all.filter(s => rids.includes(s.rid));
  return { summaries: found, missing: rids.filter(r => !found.some(s => s.rid === r)) };
}

function source(payloads: Record<string, ObjectRootPayload | Error>, summaries: ObjectSummary[] | Error = []): Src {
  return {
    openRoot: vi.fn<ObjectWindowSource['openRoot']>(async rid => {
      const p = payloads[rid];
      if (!p || p instanceof Error) throw p ?? new Error('Object not found');
      return p;
    }),
    // As the service worker answers: a definition it does not find is reported missing.
    readSummaries: vi.fn<ObjectWindowSource['readSummaries']>(async rids => {
      if (summaries instanceof Error) throw summaries;
      return answerOf(summaries, rids);
    }),
    fieldList: vi.fn<ObjectWindowSource['fieldList']>(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })),
    run: vi.fn(async () => ({ ok: true })),
  };
}

function mount(src: ObjectWindowSource) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: rid => { void controller.open(rid); },
    back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(),
    openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    requestFields: o => controller.requestFields(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    revert: vi.fn(), toggleReset: vi.fn(), discard: vi.fn(), save: vi.fn(),
    setTarget: tg => controller.setTarget(tg), compare: vi.fn(), access: vi.fn(),
  };
  const view = new ObjectWindowView(root, handlers);
  controller = new ObjectWindowController(view, src);
  return { root, view, controller };
}

const rowsText = (root: HTMLElement) => [...root.querySelectorAll('.ow-row')].map(r => r.textContent);

// ── EditPage ─────────────────────────────────────────────────────

const EP = '4081032302720082045';
const BRK1 = '4510009498191424441', INFO = '2007587857978999303', F_CODE = '1514111995589546739';
const COL = '2084834729258977281', F_TYPE = '2424747442035116132', BRK2 = '4777559518996667698', F_SCEN = '204390460650251450';
const MAP_CODE = '102976060087241760', MAP_SUBTYPE = '2270032381513260657', MAP_SCEN = '8287190057851970116';

function editField(rid: string, name: string, mapping: string, extra: Record<string, PropValue> = {}): FullObject {
  return obj(rid, 'EditField', name, {
    showExpression: code(''), enableExpression: code(''), requiredExpression: code('true'),
    required: bool(false), propertyMapping: t(mapping), ...extra,
  }, { parent: [EP] });
}

function editPage(withBreaks = true): ObjectRootPayload {
  const nodes: Record<string, FullObject> = {
    [INFO]: obj(INFO, 'EditPageInfo', 'About this step', { showExpression: code('x = 1') }, { parent: [EP] }),
    [F_CODE]: editField(F_CODE, 'Risk code', MAP_CODE, { required: bool(true) }),
    [F_TYPE]: editField(F_TYPE, 'Risk type', MAP_SUBTYPE),
    [F_SCEN]: editField(F_SCEN, 'Scenario', MAP_SCEN),
  };
  const order = withBreaks ? [BRK1, INFO, F_CODE, COL, F_TYPE, BRK2, F_SCEN] : [INFO, F_CODE, F_TYPE, F_SCEN];
  if (withBreaks) {
    nodes[BRK1] = obj(BRK1, 'EditPageBreak', 'Identity and classification', {}, { parent: [EP] });
    nodes[COL] = obj(COL, 'EditPageColumnBreak', 'Classification column', {}, { parent: [EP] });
    nodes[BRK2] = obj(BRK2, 'EditPageBreak', 'Assessment', {}, { parent: [EP] });
  }
  return {
    rid: EP,
    root: obj(EP, 'EditPage', 'Risk Workshop', { types: { kind: 'list', text: 'CeRiskAssessment', items: ['CeRiskAssessment'] }, afterExpression: code('') },
      { parent: ['6893736783721349704'] }),
    rows: order.map(rid => ({ rid, parent: EP })), nodes, posts: 2, ms: 40,
  };
}

const DEFS: ObjectSummary[] = [
  { rid: MAP_CODE, type: 'TextMethodConfig', name: 'Code', businessId: 'code' },
  { rid: MAP_SUBTYPE, type: 'ListMethodConfig', name: 'Subtype', businessId: 'subtype' },
];

describe('EditPage', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('keeps the tree flat with breaks as quiet divider rows labelled by what they start', async () => {
    const { root, controller } = mount(source({ [EP]: editPage() }, DEFS));
    await controller.open(EP, { type: 'EditPage' });
    const rows = [...root.querySelectorAll<HTMLElement>('.ow-row')];
    expect(rows.map(r => r.dataset.rid)).toEqual([EP, BRK1, INFO, F_CODE, COL, F_TYPE, BRK2, F_SCEN]);
    // Flat: every child at the same level, fields under a break at the break's indent.
    expect(new Set(rows.slice(1).map(r => r.getAttribute('aria-level')))).toEqual(new Set(['2']));
    const dividers = rows.filter(r => r.classList.contains('ow-div'));
    expect(dividers.map(r => r.querySelector('.ow-dv-lead')?.textContent)).toEqual(['Page 1', 'Column 2', 'Page 2']);
    expect(dividers[0].querySelector('.ow-dv-name')?.textContent).toBe('Identity and classification');
    expect([...root.querySelectorAll('.ow-tree-head .m')].map(m => m.textContent)).toEqual(['S', 'E', 'R']);
    // Risk code is required: R is on.
    const codeRow = rows.find(r => r.dataset.rid === F_CODE)!;
    expect([...codeRow.querySelectorAll('.m.on')].map(m => m.textContent)).toContain('R');
  });

  it('a divider row is selectable and names its page in the pane', async () => {
    const { root, view, controller } = mount(source({ [EP]: editPage() }, DEFS));
    await controller.open(EP, { type: 'EditPage' });
    view.select(BRK2);
    expect(root.querySelector('.ow-sub-kind code')?.textContent).toBe('Page 2');
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Assessment');
  });

  it('an EditPage with no breaks shows its fields without dividers', async () => {
    const { root, controller } = mount(source({ [EP]: editPage(false) }, DEFS));
    await controller.open(EP, { type: 'EditPage' });
    expect(root.querySelectorAll('.ow-row')).toHaveLength(5);
    expect(root.querySelector('.ow-div')).toBeNull();
  });

  it('resolves every field mapping in ONE summary read and leads the field pane with it', async () => {
    const src = source({ [EP]: editPage() }, DEFS);
    const { root, view, controller } = mount(src);
    await controller.open(EP, { type: 'EditPage' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
    expect(src.readSummaries.mock.calls[0][0]).toEqual(expect.arrayContaining([MAP_CODE, MAP_SUBTYPE, MAP_SCEN]));
    view.select(F_TYPE);
    const mapped = root.querySelector('.ow-mapped')!;
    expect(mapped.querySelector('.ow-mp-name')?.textContent).toBe('Subtype');
    expect(mapped.querySelector('.ow-mp-meta')?.textContent).toBe('CeRiskAssessment');
    expect([...mapped.querySelectorAll('.ow-chip .v')].map(v => v.textContent)).toEqual(['subtype', MAP_SUBTYPE]);
    // The mapped property section comes before Behaviour.
    const titles = [...root.querySelectorAll('.ow-sec-h .t')].map(e => e.textContent);
    expect(titles[0]).toBe('Mapped property');
    // A definition the server does not return: quiet, never an error.
    view.select(F_SCEN);
    expect(root.querySelector('.ow-mp-name')?.textContent).toBe('Property not found');
  });

  it('a failed summary read leaves the numeric mapping and a quiet note', async () => {
    const { root, view, controller } = mount(source({ [EP]: editPage() }, new Error('read failed')));
    await controller.open(EP, { type: 'EditPage' });
    await flush();
    view.select(F_CODE);
    expect(root.querySelector('.ow-mp-name')?.textContent).toBe('Property name could not be loaded');
    expect([...root.querySelectorAll('.ow-mapped .ow-chip .v')].map(v => v.textContent)).toEqual([MAP_CODE]);
  });
});

// ── Scorecard ────────────────────────────────────────────────────

const SC = '346621973352726530', CVO = '451751554592948440', CVE = '2994555426979251232', TXT = '3536174442069905447';

function scorecard(): ObjectRootPayload {
  const big = 'x'.repeat(325_000);
  return {
    rid: SC,
    root: obj(SC, 'Scorecard', 'Enterprise Risk Quantification', {
      visibility: { kind: 'enum', text: 'visible' }, showTabs: bool(true), showTopBar: bool(true), '7359355062295100237': t(''),
    }, { parent: ['2418327708967117553'] }),
    rows: [{ rid: CVO, parent: SC }, { rid: CVE, parent: CVO }, { rid: TXT, parent: SC }],
    nodes: {
      [CVO]: obj(CVO, 'CustomVisualization', 'ERM Monte Carlo', { javascript: t(big), visibility: { kind: 'enum', text: 'visible' } }, { parent: [SC] }),
      [CVE]: obj(CVE, 'CustomVisualizationExpression', 'CVO Reporter tags', { expression: code('${t.expr.expression}'), key: t('config') }, { parent: [CVO] }),
      [TXT]: obj(TXT, 'TextElement', 'Text element', { visibility: { kind: 'enum', text: 'hidden' } }, { parent: [SC] }),
    },
    posts: 2, ms: 35,
  };
}

describe('Scorecard', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('draws Scorecard → widget → sub-item with Code and Visible markers', async () => {
    const { root, controller } = mount(source({ [SC]: scorecard() }));
    await controller.open(SC, { type: 'Scorecard' });
    const rows = [...root.querySelectorAll<HTMLElement>('.ow-row')];
    expect(rows.map(r => [r.dataset.rid, r.getAttribute('aria-level')])).toEqual([[SC, '1'], [CVO, '2'], [CVE, '3'], [TXT, '2']]);
    expect([...root.querySelectorAll('.ow-tree-head .m')].map(m => m.textContent)).toEqual(['C', 'V']);
    const cvo = rows[1];
    expect([...cvo.querySelectorAll('.m.on')].map(m => m.textContent)).toEqual(['C', 'V']);
    // A widget without sub-items has no expander.
    expect(rows[3].querySelector('.chev')?.childElementCount).toBe(0);
    expect(rows[3].querySelector('.m.on')).toBeNull();
  });

  it('keeps layout in the collapsed Blueprint group and caps very large widget code', async () => {
    const { root, view, controller } = mount(source({ [SC]: scorecard() }));
    await controller.open(SC, { type: 'Scorecard' });
    const grp = root.querySelector<HTMLDetailsElement>('details.ow-grp')!;
    expect(grp.open).toBe(false);
    expect(grp.textContent).toContain('Edit in Blueprint');
    expect(grp.textContent).toContain('Show tabs');
    view.select(CVO);
    const blk = root.querySelector('.ow-blk')!;
    expect(blk.textContent).toContain('325,000 chars');
    expect(blk.querySelector('.ow-code')!.textContent!.length).toBeLessThan(6000);
  });
});

// ── Data objects ─────────────────────────────────────────────────

const RA = '3108836420228768338', TPL = '182547291889612346', DV = '4838752272279162696', CONT = '8548516281848610027', AB = '18927615257524154';
const K_ACTIVE = '7671409296399145647', K_CODE = '102976060087241760', K_SUB = '2270032381513260657', K_GONE = '1111111111111111111';

function risk(withTemplate = true): ObjectRootPayload {
  return {
    rid: RA,
    root: obj(RA, 'CeRiskAssessment', 'Ransomware disruption - Hamburg', {
      description: t(''), sortIndex: { kind: 'number', text: '2', num: 2 },
      [K_ACTIVE]: bool(false), [K_CODE]: t('RISK-ERM-001-HH'), [K_GONE]: t('orphan'),
    }, {
      ...(withTemplate ? { template: [TPL] } : {}), parent: ['7862795079527071941'], [K_SUB]: ['3876104163064477881'],
      createdBy: ['4586545229215709814'], readAccessors: [],
    }),
    rows: null, nodes: {}, posts: 1, ms: 25,
  };
}

function template(): ObjectRootPayload {
  return {
    rid: TPL,
    root: obj(TPL, 'EnterpriseTemplate', 'Risk (Instance) [Simple]', {}, { parent: ['5012488755384970968'] }),
    rows: [{ rid: DV, parent: TPL }, { rid: CONT, parent: TPL }, { rid: AB, parent: CONT }],
    nodes: {
      [DV]: obj(DV, 'DescriptionView', 'Identity', {}, { parent: [TPL] }),
      [CONT]: obj(CONT, 'Container', 'Qual: Inherent Impact -> Local', {}, { parent: [TPL] }),
      [AB]: obj(AB, 'ActionButton', '1', { expression: code('this.object.change(x := 1)') }, { parent: [CONT] }),
    },
    posts: 2, ms: 35,
  };
}

const RA_DEFS: ObjectSummary[] = [
  { rid: K_ACTIVE, type: 'BooleanMethodConfig', name: 'Active', businessId: 'tax_active' },
  { rid: K_CODE, type: 'TextMethodConfig', name: 'Code', businessId: 'code' },
  { rid: K_SUB, type: 'ListMethodConfig', name: 'Subtype', businessId: 'subtype' },
  { rid: '3876104163064477881', type: 'ListPropertySetItem', name: 'Instance', businessId: 'instance' },
];

describe('data objects', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('paints the object first, then adds the template under "Presented by"', async () => {
    let release!: (p: ObjectRootPayload) => void;
    const src = source({ [RA]: risk() }, RA_DEFS);
    src.openRoot.mockImplementation(async rid => (rid === RA ? risk() : new Promise(r => { release = r; })));
    const { root, controller } = mount(src);
    await controller.open(RA);
    // First paint: the object alone, selected, and the template still loading.
    expect([...root.querySelectorAll('.ow-tree-grp')].map(g => g.textContent)).toEqual(['Object', 'Presented by']);
    expect(rowsText(root)).toHaveLength(1);
    expect(root.querySelector('.ow-row')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.ow-head .ow-seg')).toBeNull();
    await flush();
    expect(root.querySelector('.ow-tree-msg')?.textContent).toBe('Loading template…');
    expect(src.openRoot).toHaveBeenLastCalledWith(TPL, 'EnterpriseTemplate');
    release(template());
    await flush();
    const rows = [...root.querySelectorAll<HTMLElement>('.ow-row')];
    expect(rows.map(r => r.dataset.rid)).toEqual([RA, TPL, DV, CONT]);
    // Containers start folded; their ActionButtons are one click away.
    expect(rows[3].getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.ow-row[aria-selected="true"]')?.getAttribute('data-rid')).toBe(RA);
    // Still no Template | Instance switch.
    expect(root.querySelector('.ow-head .ow-seg')).toBeNull();
  });

  it('a data object without a template shows a quiet line and makes no template call', async () => {
    const src = source({ [RA]: risk(false) }, RA_DEFS);
    const { root, controller } = mount(src);
    await controller.open(RA);
    await flush();
    expect(root.querySelector('.ow-tree-msg')?.textContent).toBe('No template presents this object.');
    expect(src.openRoot).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.ow-ps')).not.toBeNull();
  });

  it('a template that fails to load degrades only its group', async () => {
    const src = source({ [RA]: risk(), [TPL]: new Error('listing failed') }, RA_DEFS);
    const { root, controller } = mount(src);
    await controller.open(RA);
    await flush();
    expect(root.querySelector('.ow-tree-msg')?.textContent).toBe('The template could not be loaded.');
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Ransomware disruption - Hamburg');
  });

  it('labels custom keys from ONE batched definition read; unreadable keys stay numeric', async () => {
    const src = source({ [RA]: risk(false) }, RA_DEFS);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    src.readSummaries.mockImplementation(async rids => { await gate; return answerOf(RA_DEFS, rids); });
    const { root, controller } = mount(src);
    await controller.open(RA);
    // Before the names arrive the numeric key is the label (painting never waits).
    const before = [...root.querySelectorAll('.ow-pr2')].map(r => r.querySelector('.nm')?.textContent);
    expect(before).toContain(K_ACTIVE);
    release();
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
    expect(src.readSummaries.mock.calls[0][0]).toEqual(expect.arrayContaining([K_ACTIVE, K_CODE, K_SUB, K_GONE]));
    const rows = [...root.querySelectorAll<HTMLElement>('.ow-pr2')];
    const byKey = (k: string) => rows.find(r => r.dataset.key === k)!;
    expect(byKey(K_ACTIVE).querySelector('.nm')?.textContent).toBe('Active');
    expect(byKey(K_ACTIVE).querySelector('.ky')?.textContent).toBe('tax_active');
    // Reference-typed custom property: numeric role labelled the same way.
    expect(byKey(K_SUB).querySelector('.nm')?.textContent).toBe('Subtype');
    expect(byKey(K_SUB).querySelector('.ow-pr-v')?.textContent).toContain('Instance');
    expect(byKey(K_GONE).querySelector('.nm')?.textContent).toBe(K_GONE);
    // Without a schema: one Custom section; Advanced, Relations, Audit folded.
    const secs = [...root.querySelectorAll<HTMLElement>('.ow-ps-sec')];
    expect(secs.map(s => s.querySelector('.ow-ps-h .t')?.textContent)).toEqual(['General', 'Custom', 'Advanced', 'Relations', 'Audit']);
    expect(secs.map(s => s.dataset.open)).toEqual(['true', 'true', 'false', 'false', 'false']);
    expect(rows.some(r => r.dataset.key === 'readAccessors')).toBe(false);
    // Custom references are not repeated under Relations.
    expect(secs[3].textContent).not.toContain('Subtype');
    // Read-only without a schema: no editor in the list.
    expect(root.querySelector('.ow-ps input.ow-ped-in, .ow-ps button.ui-sw, .ow-ps .ow-pbox')).toBeNull();
    // Opening the same type again reuses the cached names.
    await controller.open(TPL);
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
  });

  it('a failed definition read still paints every key', async () => {
    const { root, controller } = mount(source({ [RA]: risk(false) }, new Error('read failed')));
    await controller.open(RA);
    await flush();
    const labels = [...root.querySelectorAll('.ow-pr2 .nm')].map(e => e.textContent);
    expect(labels).toEqual(expect.arrayContaining([K_ACTIVE, K_CODE, K_SUB]));
  });

  it('a section folds on its header, keeps the choice, and the filter searches every section', async () => {
    const { root, controller } = mount(source({ [RA]: risk(false) }, RA_DEFS));
    await controller.open(RA);
    await flush();
    const sec = (k: string) => root.querySelector<HTMLElement>(`.ow-ps-sec[data-sec="${k}"]`)!;
    sec('advanced').querySelector<HTMLElement>('.ow-ps-h')!.click();
    expect(sec('advanced').dataset.open).toBe('true');
    sec('c:Custom').querySelector<HTMLElement>('.ow-ps-h')!.click();
    expect(sec('c:Custom').dataset.open).toBe('false');
    const q = root.querySelector<HTMLInputElement>('.ow-ps-q')!;
    q.value = 'tax_act';
    q.dispatchEvent(new Event('input'));
    // The match opens its folded section; sections without a match hide.
    expect(sec('c:Custom').hidden).toBe(false);
    expect(sec('c:Custom').querySelector<HTMLElement>('.ow-ps-body')!.hidden).toBe(false);
    expect(sec('advanced').hidden).toBe(true);
    expect([...root.querySelectorAll<HTMLElement>('.ow-pr2')].filter(r => !r.hidden).map(r => r.dataset.key)).toEqual([K_ACTIVE]);
    q.value = 'RISK-ERM';
    q.dispatchEvent(new Event('input'));
    expect([...root.querySelectorAll<HTMLElement>('.ow-pr2')].filter(r => !r.hidden).map(r => r.dataset.key)).toEqual([K_CODE]);
    // Clearing restores the fold state.
    q.value = '';
    q.dispatchEvent(new Event('input'));
    expect(sec('c:Custom').querySelector<HTMLElement>('.ow-ps-body')!.hidden).toBe(true);
    expect(sec('advanced').querySelector<HTMLElement>('.ow-ps-body')!.hidden).toBe(false);
  });
});
