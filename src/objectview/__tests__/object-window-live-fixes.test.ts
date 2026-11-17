// Fixes found by the live read-only test of the object window:
//  D1 EditField propertyMapping is a PropertyMapping object;
//  D2 one unreadable rid (ObjectProfileMapping) fails a whole summary batch;
//  D3 field-list rows are Custom only on positive evidence;
//  plus the gated S / E markers and the Required marker on an EditPage.
// Shapes are copied from live object reads and the live schema
// enumeration of CeRiskAssessment.
import { describe, expect, it, vi } from 'vitest';
import { parseFullObject, toPropValue, type FullObject, type ObjectSummary, type PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { HIDDEN_ROLES, typeInfo } from '../../lib/object-window-table';
import { readIsolating, isObjectLevelError } from '../../lib/batch-isolate';
import { parseSchema, schemaEc } from '../../lib/bmp-type-knowledge';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import type { WindowModel } from '../window/view';
import { buildSections } from '../window/prop-sections';

const t = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });

function obj(rid: string, type: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}): FullObject {
  return { rid, type, name: `n${rid.slice(-3)}`, businessId: `b${rid.slice(-4)}`, props, references, overridden: [] };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

// ── D1 ───────────────────────────────────────────────────────────

describe('D1: EditField propertyMapping', () => {
  const EXPR = 'com.corporater.bmp.value.type.expression.CorpoExtendedExpression';
  const read = (mapping: string) => parseFullObject({
    props: {
      _rid: '1514111995589546739', _type: 'EditField', name: 'Risk code', id: 'crev_ep_risk_code',
      required: { $class: 'java.lang.Boolean', value: true },
      requiredExpression: { $class: EXPR, value: 'true' },
      propertyMapping: { $class: 'com.corporater.bmp.value.type.PropertyMapping', propertyName: mapping },
    },
    references: {},
  })!;

  it('reads a numeric property rid as text, kept as an exact string', () => {
    const v = read('102976060087241760').props.propertyMapping;
    expect(v).toMatchObject({ kind: 'text', text: '102976060087241760' });
  });

  it('reads an accessor-name mapping as it is', () => {
    expect(read('name').props.propertyMapping.text).toBe('name');
  });

  it('an empty mapping is empty text', () => {
    expect(toPropValue('propertyMapping', { $class: 'com.corporater.bmp.value.type.PropertyMapping', propertyName: null }).text).toBe('');
  });
});

// ── controller harness ──────────────────────────────────────────

function controllerWith(payload: ObjectRootPayload, readSummaries: ObjectWindowSource['readSummaries']) {
  let last: WindowModel | undefined;
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async () => payload),
    readSummaries: vi.fn(readSummaries),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })),
    run: vi.fn(async () => { throw new Error('no writes in this test'); }),
  };
  const ctl = new ObjectWindowController({ update: m => { last = m; } }, src);
  return { ctl, src, model: () => last! };
}

describe('D1: mapped properties are resolved in the batched summary read', () => {
  const EP = '4081032302720082045';
  const F1 = '1514111995589546739', F2 = '7758379700061256693', F3 = '1119672493517167851';
  const M1 = '102976060087241760', M2 = '2270032381513260657';
  const field = (rid: string, mapping: string) => obj(rid, 'EditField', { propertyMapping: t(mapping) }, { parent: [EP] });

  it('asks for numeric mappings only and names them', async () => {
    const payload: ObjectRootPayload = {
      rid: EP, root: obj(EP, 'EditPage'), rows: [F1, F2, F3].map(rid => ({ rid, parent: EP })),
      nodes: { [F1]: field(F1, M1), [F2]: field(F2, M2), [F3]: field(F3, 'name') }, posts: 2, ms: 1,
    };
    const defs: ObjectSummary[] = [
      { rid: M1, type: 'TextMethodConfig', name: 'Code', businessId: 'code' },
      { rid: M2, type: 'ListMethodConfig', name: 'Subtype', businessId: 'subtype' },
    ];
    const { ctl, src, model } = controllerWith(payload, async rids => defs.filter(d => rids.includes(d.rid)));
    await ctl.open(EP, { type: 'EditPage' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
    const asked = vi.mocked(src.readSummaries).mock.calls[0][0];
    expect(asked).toEqual(expect.arrayContaining([M1, M2]));
    expect(asked).not.toContain('name');
    expect(model().summaries[M1].businessId).toBe('code');
    expect(model().summaries[M2].name).toBe('Subtype');
  });
});

// ── D2 ───────────────────────────────────────────────────────────

describe('D2: one unreadable rid does not kill the summary batch', () => {
  const SC = '346621973352726530';
  const PROFILE = '2228390522429901929';
  const CAST = 'ObjectProfileMappingImpl cannot be cast to BusinessTreeObject';

  it('hides profileMappings like the other plumbing roles', () => {
    expect(HIDDEN_ROLES.test('profileMappings')).toBe(true);
    const sc = obj(SC, 'Scorecard', {}, { profileMappings: [PROFILE], parent: ['2418327708967117553'] });
    const { before, after } = buildSections(sc, { summaries: {} });
    expect([...before, ...after].flatMap(x => x.rows).map(r => r.key)).not.toContain('profileMappings');
  });

  it('halves a failing batch, remembers the bad rid as unreadable and names the rest', async () => {
    const BAD = '140430008561122655';
    const others = ['2418327708967117553', '965927641110545997', '8573444088909962487', '6944037134870188922', '4149288795398052094', '4848366147883886796', '3663406580886322153'];
    // The bad rid sits on a role that is not hidden, so the guard is the split.
    const sc = obj(SC, 'Scorecard', {}, {
      parent: [others[0]], statusType: [others[1]], periodStorage: [others[2]], view: [others[3]],
      card: [others[4]], yearDef: [others[5]], createdBy: [others[6]], someLink: [BAD],
    });
    const payload: ObjectRootPayload = { rid: SC, root: sc, rows: [], nodes: {}, posts: 2, ms: 1 };
    const { ctl, src, model } = controllerWith(payload, async rids => {
      if (rids.includes(BAD)) throw new Error(CAST);
      return rids.map(rid => ({ rid, type: 'X', name: `name ${rid}`, businessId: `id${rid.slice(-3)}` }));
    });
    await ctl.open(SC, { type: 'Scorecard' });
    await flush();
    const m = model();
    expect(m.summariesError).toBeUndefined();
    for (const r of others) expect(m.summaries[r]?.name).toBe(`name ${r}`);
    expect(m.unreadable?.[BAD]).toBe(CAST);
    expect(m.missing?.[BAD]).toBe(true);
    // 8 rids, one bad: 1 + 2·log2(8) = 7 requests, not one per rid.
    expect(vi.mocked(src.readSummaries).mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('a read that fails for every rid is reported, not remembered', async () => {
    const sc = obj(SC, 'Scorecard', {}, { parent: ['2418327708967117553'], view: ['6944037134870188922'] });
    const payload: ObjectRootPayload = { rid: SC, root: sc, rows: [], nodes: {}, posts: 2, ms: 1 };
    const { ctl, model } = controllerWith(payload, async () => { throw new Error('NullPointerException'); });
    await ctl.open(SC, { type: 'Scorecard' });
    await flush();
    expect(model().summariesError).toBe('NullPointerException');
    expect(model().missing).toEqual({});
  });

  it('a connection error is not split', async () => {
    const sc = obj(SC, 'Scorecard', {}, { parent: ['2418327708967117553'], view: ['6944037134870188922'] });
    const payload: ObjectRootPayload = { rid: SC, root: sc, rows: [], nodes: {}, posts: 2, ms: 1 };
    const { ctl, src, model } = controllerWith(payload, async () => { throw new Error('Not connected to BMP'); });
    await ctl.open(SC, { type: 'Scorecard' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
    expect(model().summariesError).toBe('Not connected to BMP');
  });
});

describe('readIsolating', () => {
  const ids = Array.from({ length: 40 }, (_, i) => String(1_000_000 + i));

  it('isolates two bad ids with halving, far below one request per id', async () => {
    const bad = new Set([ids[3], ids[30]]);
    const res = await readIsolating(ids, async batch => {
      if (batch.some(b => bad.has(b))) throw new Error('ClassCastException');
      return batch;
    });
    expect(Object.keys(res.failed).sort()).toEqual([...bad].sort());
    expect(res.results.flat().sort()).toEqual(ids.filter(i => !bad.has(i)).sort());
    expect(res.unresolved).toEqual([]);
    expect(res.requests).toBeLessThan(25);
  });

  it('stops at the request budget and reports what is left', async () => {
    const res = await readIsolating(ids, async () => { throw new Error('boom'); }, { maxRequests: 5 });
    expect(res.requests).toBe(5);
    expect(res.unresolved.length + Object.keys(res.failed).length).toBe(ids.length);
    expect(res.error).toBe('boom');
  });

  it('rethrows connection errors and aborts', async () => {
    await expect(readIsolating(ids, async () => { throw new Error('Request timed out'); })).rejects.toThrow('timed out');
    expect(isObjectLevelError(new Error(ENV))).toBe(false);
    // Full live message (it mentions "loader", which must not read as login).
    expect(isObjectLevelError(new Error("class com.corporater.bmp.model.model.access.ObjectProfileMappingImpl cannot be cast to class com.corporater.bmp.model.model.BusinessTreeObject (com.corporater.bmp.model.model.access.ObjectProfileMappingImpl and com.corporater.bmp.model.model.BusinessTreeObject are in unnamed module of loader 'app')"))).toBe(true);
  });
});
const ENV = 'The active BMP environment changed after this view was opened. Reload this view before saving.';

// ── D3 ───────────────────────────────────────────────────────────

describe('D3: Built-in unless there is positive evidence of a custom property', () => {
  // Live schema enumeration rows (CeRiskAssessment): built-ins are
  // SystemMethodConfig with systemobject true AND a master-property rid.
  const LOG = [
    '__canon__|||com.corporater.bmp.model.model.enterprise.CeRiskAssessment',
    'id|||id|||SystemMethodConfig|||true|||7633222441740989937|||id|||SystemMethodConfig',
    'start|||start|||SystemMethodConfig|||true|||1111111111111111111|||start|||SystemMethodConfig',
    'cerasRiskTitle|||Risk title|||TextMethodConfig|||false|||8123456789012345678|||cerasRiskTitle|||TextMethodConfig',
    '|||Rule|||ConditionRule|||false||||||',
  ].join('\n');

  it('schemaEc guards every optional read with whenMissing (ConditionRule has no linkedTo)', () => {
    const ec = schemaEc('CeRiskAssessment');
    expect(ec).toContain('_k.linkedTo.id.whenMissing("")');
    expect(ec).toContain('_k.linkedTo.rid.whenMissing("")');
    expect(ec).toContain('_k.linkedTo.className.whenMissing("")');
    expect(ec).toContain('_k.systemobject.whenMissing("")');
    expect(ec).not.toMatch(/_k\.linkedTo\.(id|rid|className) \+/);
  });

  it('parseSchema keeps its shape and skips a child without linkedTo', () => {
    const { props, canonical } = parseSchema(LOG);
    expect(canonical).toBe('CeRiskAssessment');
    expect(props.map(p => p.accessor)).toEqual(['id', 'start', 'cerasRiskTitle']);
    expect(props[2]).toEqual({
      accessor: 'cerasRiskTitle', label: 'Risk title', configClass: 'TextMethodConfig', systemobject: false,
      propertyRid: '8123456789012345678', propertyId: 'cerasRiskTitle', propertyConfigClass: 'TextMethodConfig',
    });
  });
});

// ── markers ──────────────────────────────────────────────────────

describe('tree markers', () => {
  const [S, E, R] = typeInfo('EditPage').slots;
  const field = (props: Record<string, PropValue>) => obj('1514111995589546739', 'EditField', props);

  it('S / E are on only when the expression is set and its gate is on', () => {
    expect(S.test(field({ showExpression: code('x'), useShowExpression: bool(false) }))).toBe(false);
    expect(S.test(field({ showExpression: code('x'), useShowExpression: bool(true) }))).toBe(true);
    expect(S.test(field({ showExpression: code(''), useShowExpression: bool(true) }))).toBe(false);
    expect(S.test(field({ showExpression: code('x') }))).toBe(true); // no gate returned
    expect(E.test(field({ enableExpression: code('x'), useEnableExpression: bool(false) }))).toBe(false);
    expect(E.test(field({ enableExpression: code('x'), useEnableExpression: bool(true) }))).toBe(true);
    expect(S.test(field({}))).toBeNull();
  });

  it('InputView markers follow the same gates', () => {
    const [s] = typeInfo('InputView').slots;
    expect(s.test(obj('1', 'ButtonInput', { showExpression: code('x'), useShowExpression: bool(false) }))).toBe(false);
  });

  it('R follows `required`; the default requiredExpression "true" alone is not required', () => {
    // Live EditField shape: requiredExpression "true" on every field.
    expect(R.test(field({ required: bool(false), requiredExpression: code('true') }))).toBe(false);
    expect(R.test(field({ required: bool(true), requiredExpression: code('true') }))).toBe(true);
    expect(R.test(field({ required: bool(false), requiredExpression: code('x'), useRequiredExpression: bool(true) }))).toBe(true);
    expect(R.test(field({ required: bool(false), requiredExpression: code('x'), useRequiredExpression: bool(false) }))).toBe(false);
    expect(R.test(obj('1', 'EditPageBreak'))).toBeNull();
  });
});
