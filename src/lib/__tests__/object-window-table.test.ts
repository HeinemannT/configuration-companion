import { afterEach, describe, expect, it } from 'vitest';
import type { FullObject, PropValue } from '../object-read';
import { assembleStructure, attachTree, buildStructureEc } from '../object-structure';
import { blocksFor, codePropsFor, curatedProps, dividerLeads, isCustomKey, isDataObject, setIndexedCodeProps, tableBlocks, typeInfo, typeLabel, propLabel, propLabelIn } from '../object-window-table';
import { openObjectRoot, type ObjectReader } from '../object-window';

const t = (text: string): PropValue => ({ kind: 'text', text });

function obj(rid: string, type: string, props: Record<string, PropValue> = {}, references: Record<string, string[]> = {}): FullObject {
  return { rid, type, name: `${type} ${rid.slice(-3)}`, businessId: rid.slice(-4), props, references, overridden: [] };
}

const kid = (rid: string, type: string, name = '') => ({ rid, type, name });

describe('EditPage dividers', () => {
  it('labels page and column breaks by what they start', () => {
    const leads = dividerLeads([
      kid('1', 'EditPageBreak', 'Identity'), kid('2', 'EditPageInfo'), kid('3', 'EditField'),
      kid('4', 'EditPageColumnBreak', 'Classification'), kid('5', 'EditField'),
      kid('6', 'EditPageBreak', 'Assessment'), kid('7', 'EditField'),
      kid('8', 'EditPageColumnBreak'), kid('9', 'EditPageColumnBreak'),
    ]);
    expect(leads).toEqual({ 1: 'Page 1', 4: 'Column 2', 6: 'Page 2', 8: 'Column 2', 9: 'Column 3' });
  });

  it('a break after leading fields starts page 2', () => {
    expect(dividerLeads([kid('1', 'EditField'), kid('2', 'EditPageBreak'), kid('3', 'EditField')])).toEqual({ 2: 'Page 2' });
  });

  it('an EditPage with no breaks has no dividers', () => {
    expect(dividerLeads([kid('1', 'EditField'), kid('2', 'EditPageInfo'), kid('3', 'EditField')])).toEqual({});
  });

  it('spacer headings show their own name', () => {
    expect(dividerLeads([kid('1', 'Spacer', '§ Overview'), kid('2', 'DescriptionView')])).toEqual({ 1: '§ Overview' });
  });

  it('EditPage lists direct children only, with S / E / R markers', () => {
    const info = typeInfo('EditPage');
    expect(info.structure).toEqual({ depth: 1 });
    expect(info.slots.map(s => s.letter)).toEqual(['S', 'E', 'R']);
    const req = info.slots[2];
    expect(req.test(obj('1', 'EditField', { required: { kind: 'boolean', text: 'true', bool: true } }))).toBe(true);
    expect(req.test(obj('1', 'EditField', { required: { kind: 'boolean', text: 'false', bool: false }, requiredExpression: { kind: 'code', text: '' } }))).toBe(false);
    expect(req.test(obj('1', 'EditPageBreak'))).toBeNull();
  });
});

describe('Scorecard structure', () => {
  it('is widget → sub-item (two levels), with Code and Visible markers', () => {
    const info = typeInfo('Scorecard');
    expect(info.structure).toEqual({ depth: 2 });
    const ec = buildStructureEc('lookup(346621973352726530)', info.structure!);
    expect(ec).toContain('_c1.children().forEach(_c2:');
    expect(ec).not.toContain('_c3');
    expect(info.slots.map(s => s.letter)).toEqual(['C', 'V']);
    const [code, visible] = info.slots;
    const cvo = obj('2', 'CustomVisualization', { javascript: t('window.x = 1'), visibility: { kind: 'enum', text: 'visible' } });
    expect(code.test(cvo)).toBe(true);
    expect(visible.test(cvo)).toBe(true);
    expect(code.test(obj('3', 'TextElement', {}))).toBe(false);
    expect(visible.test(obj('3', 'Check'))).toBeNull();
    expect(info.layout?.title).toBe('Layout and appearance');
  });

  it('a widget without sub-items stays a leaf', () => {
    const sc = obj('1', 'Scorecard');
    const tree = assembleStructure(sc, [{ rid: '2', parent: '1' }, { rid: '3', parent: '1' }, { rid: '4', parent: '2' }], {
      2: obj('2', 'CheckList'), 3: obj('3', 'InputView'), 4: obj('4', 'Check'),
    });
    expect(tree.order).toEqual(['1', '2', '4', '3']);
    expect(tree.nodes['3'].children).toEqual([]);
    expect(tree.nodes['4'].depth).toBe(2);
  });
});

describe('data objects', () => {
  it('a root that is not a page element and has a template or custom keys is a data object', () => {
    expect(isDataObject(obj('1', 'CeRiskAssessment', {}, { template: ['9'] }))).toBe(true);
    // No template (templatePresent=false): still a data object through its custom properties.
    expect(isDataObject(obj('1', 'CeRiskAssessment', { '6706820787741909129': t('') }))).toBe(true);
    expect(isDataObject(obj('1', 'CeIssue', {}, { '2270032381513260657': ['5'] }))).toBe(true);
    // Page elements never are, even with a custom key (Scorecard sample).
    expect(isDataObject(obj('1', 'Scorecard', { '7359355062295100237': t('') }))).toBe(false);
    expect(isDataObject(obj('1', 'NumberInput', {}, { template: ['9'] }))).toBe(false);
    // Unknown type with neither: generic object.
    expect(isDataObject(obj('1', 'BrandNewThing', { colour: t('red') }))).toBe(false);
  });

  it('a custom property never turns a page or a configuration type into a data object', () => {
    // A ModelPage with a custom reference (an icon link to a file resource).
    expect(isDataObject(obj('1', 'ModelPage', {}, { '6872637887740031545': ['7'] }))).toBe(false);
    expect(isDataObject(obj('1', 'ModelPage', { '7359355062295100237': t('x') }))).toBe(false);
    expect(isDataObject(obj('1', 'Organisation', {}, { '6872637887740031545': ['7'] }))).toBe(false);
    expect(isDataObject(obj('1', 'BrandNewThing', { '7359355062295100237': t('x') }))).toBe(false);
    // Real data objects stay data objects: by their enterprise type, or by a template.
    expect(isDataObject(obj('1', 'CeRiskAssessment'))).toBe(true);
    expect(isDataObject(obj('1', 'CustomerProcess', {}, { template: ['9'] }))).toBe(true);
  });

  it('custom keys are numeric definition rids, never built-in names', () => {
    expect(isCustomKey('6706820787741909129')).toBe(true);
    expect(isCustomKey('80031008306346202')).toBe(true);
    expect(isCustomKey('sortIndex')).toBe(false);
    expect(isCustomKey('YTDEnabled')).toBe(false);
  });

  it('attaches the presenting template as a second top-level tree', () => {
    const inst = obj('1', 'CeRiskAssessment', {}, { template: ['10'] });
    const own = assembleStructure(inst, null, {});
    const tpl = assembleStructure(obj('10', 'EnterpriseTemplate'), [
      { rid: '11', parent: '10' }, { rid: '12', parent: '10' }, { rid: '13', parent: '12' },
    ], { 11: obj('11', 'DescriptionView'), 12: obj('12', 'Container'), 13: obj('13', 'ActionButton') });
    const tree = attachTree(own, tpl);
    expect(tree.tops).toEqual(['1', '10']);
    expect(tree.order).toEqual(['1', '10', '11', '12', '13']);
    expect(tree.nodes['10'].parent).toBeNull();
    expect(tree.nodes['13'].depth).toBe(2);
    expect(own.tops).toEqual(['1']);
    // Attaching the root's own tree again changes nothing.
    expect(attachTree(tree, own)).toBe(tree);
  });

  it('an unknown root type opens with one read and no listing', async () => {
    const reader: ObjectReader = {
      readFullObjects: async rids => ({ objects: { [rids[0]]: obj(rids[0], 'NotOnThisServer') }, errors: {} }),
      fetchStructureRows: async () => { throw new Error('should not list'); },
    };
    const p = await openObjectRoot(reader, '123456789012');
    expect(p.rows).toBeNull();
    expect(p.posts).toBe(1);
  });

  it('an EditPage whose listing returns nothing paints the root alone', async () => {
    const reader: ObjectReader = {
      readFullObjects: async rids => ({ objects: Object.fromEntries(rids.map(r => [r, obj(r, 'EditPage')])), errors: {} }),
      fetchStructureRows: async () => [],
    };
    const p = await openObjectRoot(reader, '4081032302720082045', 'EditPage');
    expect(p.rows).toEqual([]);
    expect(p.root.type).toBe('EditPage');
    expect(assembleStructure(p.root, p.rows, p.nodes).order).toEqual(['4081032302720082045']);
  });
});

describe('code properties from the code index', () => {
  const code = (text: string): PropValue => ({ kind: 'code', text });
  const button = () => obj('9007199254740999', 'ButtonInput', {
    expression: code('_a := 1'), defaultExpression: code('_d := today'), destinationExpression: code('t.page_x'),
    showExpression: code(''), html: code('<b>x</b>'), buttonType: t('ButtonInputType.action'),
  });
  afterEach(() => setIndexedCodeProps(null));

  it('without an index, the table alone decides', () => {
    const b = button();
    expect(blocksFor(typeInfo(b.type), b)).toEqual(['showExpression', 'expression']);
    expect(codePropsFor(typeInfo(b.type), b)).toEqual(['showExpression', 'expression']);
  });

  it('adds the index code properties: as blocks when the table draws them nowhere, and to Calls', () => {
    setIndexedCodeProps({ ButtonInput: ['expression', 'defaultExpression', 'destinationExpression', 'html', 'refreshExpression'] });
    const b = button();
    const info = typeInfo(b.type);
    // destinationExpression stays a Configuration field; html is not Extended Code.
    expect(blocksFor(info, b)).toEqual(['showExpression', 'expression', 'defaultExpression']);
    expect(codePropsFor(info, b)).toEqual(['showExpression', 'expression', 'defaultExpression', 'destinationExpression']);
    // Edit routes keep following the table.
    expect(tableBlocks(info, b)).toEqual(['showExpression', 'expression']);
    expect(curatedProps(info, b).has('defaultExpression')).toBe(true);
  });
});

describe('one source for type and property labels', () => {
  it('names a type by the table, else in words without the product prefix', () => {
    expect(typeLabel('')).toBe('Object');
    expect(typeLabel('ExtendedMethodConfig')).toBe('Extended method config');
    expect(typeLabel('CeAssuranceActivity')).toBe('Assurance activity');
    expect(typeLabel('Cesium')).toBe('Cesium');
  });
  it('names a property with loaded captions only where the table has none', () => {
    expect(propLabel('firstColorExpression')).toBe('First color expression');
    expect(propLabelIn('someProp', { someProp: 'Shown caption' })).toBe('Shown caption');
    expect(propLabelIn('name')).toBe('Name');
    expect(propLabelIn('id')).toBe('ID');
    expect(propLabelIn('1521507040334396171', {}, { '1521507040334396171': { name: 'Owner' } })).toBe('Owner');
    expect(propLabelIn('1521507040334396171')).toBe('Custom property');
  });
});
