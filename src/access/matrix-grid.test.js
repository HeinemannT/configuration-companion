/* global performance, console */
import { describe, expect, it } from 'vitest';
import { createMatrixIndex } from './matrix-model';
import { transposeMatrix, matrixGridState, orderRoles, roleBandCounts, nothingGranted, unresolvedWords, selectionVisible, cellMark, cellMarks, lensMark, countText, countWords, cellWhy, rowOffsets, visibleRange, KINDS, kindWords, cellKinds, cellInherited, MARKS } from './matrix-grid.js';

const classes = { Organisation: [], Scorecard: [], CeRisk: [], CeRiskAssessment: [], CeIssue: [], TableView: [], Note: [] };
const type = (...types) => ({ Condition: { Left: 'resource.type', Comparison: types.length === 1 ? '=' : 'ContainsAny', Right: types.length === 1 ? types[0] : types } });
const model = {
  roles: [
    { rid: '1', id: 'management', name: 'Risk management', parent: '' },
    { rid: '2', id: 'owner', name: 'Risk owner', parent: '1' },
    { rid: '3', id: 'auditor', name: 'Auditor', parent: '' },
  ],
  policies: [{ rid: 'p', name: 'Register', enabled: true, content: { Version: '1.0', Statement: [
    { Effect: 'Allow', Subject: ['role:management'], Action: ['Read'], Resource: type('CeRisk') },
    { Effect: 'Allow', Subject: ['role:owner'], Action: ['Update'], Resource: { All: [type('CeRisk'), { Condition: { Left: 'resource.status', Comparison: '=', Right: 'Open' } }] } },
    { Effect: 'Deny', Subject: '*', Action: ['Delete'], Resource: type('CeRiskAssessment') },
    { Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: type('Organisation', 'Scorecard') },
    { Effect: 'Allow', Subject: ['role:auditor'], Action: ['Read'], Resource: { HasAccessTo: { Reference: 'resource.parent' } } },
  ] } }],
  scope: [], globals: [], folders: [],
};
const metadata = names => ({ types: Object.fromEntries(names.map(t => [t, { concrete: true, parents: [] }])), references: {} });
const index = createMatrixIndex(model, classes, {}, metadata(Object.keys(classes)));

describe('transposed matrix', () => {
  it('marks granted, inherited, conditional, unresolved and none per operation; a Deny-only match is not granted', () => {
    expect(cellMark(index, '1', 'CeRisk', 'Read')).toBe('granted');
    expect(cellMark(index, '2', 'CeRisk', 'Read')).toBe('inherited');
    expect(cellMark(index, '2', 'CeRisk', 'Update')).toBe('conditional');
    // The engine is grant-only: a cell matched only by a Deny statement is not granted.
    expect(cellMark(index, '2', 'CeRiskAssessment', 'Delete')).toBe('none');
    expect(lensMark(index, '2', 'CeRiskAssessment', 'All')).toBe('none');
    expect(cellWhy(index, '2', 'CeRiskAssessment').find(w => w.action === 'Delete')).toMatchObject({ mark: 'none', rules: [] });
    expect(cellMark(index, '2', 'CeRiskAssessment', 'Read')).toBe('none');
    expect(cellMark(index, '3', 'Organisation', 'Read')).toBe('inherited');
    expect(lensMark(index, '2', 'CeRisk', 'All')).toBe('granted' === cellMark(index, '2', 'CeRisk', 'Read') ? 'granted' : 'inherited');
  });

  it('keeps the letter for a known condition, with its kind, and leaves "?" for what could not be read', () => {
    // HasAccessTo is a known kind of condition: the letter is kept, under a condition of kind "related".
    expect(cellMarks(index, '3', 'CeIssue').Read).toBe('conditional');
    expect(cellKinds(index, '3', 'CeIssue', 'Read')).toEqual(['related']);
    expect(cellKinds(index, '2', 'CeRisk', 'Update')).toEqual(['some']);
    expect(cellKinds(index, '2', 'CeRisk', 'Read')).toEqual([]);
    expect(cellInherited(index, '2', 'CeRisk', 'Read')).toBe(true);
    expect(cellInherited(index, '1', 'CeRisk', 'Read')).toBe(false);
    // "?" is for what could not be read: a statement about a reference that is not loaded.
    const gap = createMatrixIndex({ ...model, policies: [{ rid: 'g', name: 'Gap', enabled: true, content: { Statement: [
      { Effect: 'Allow', Subject: ['role:auditor'], Action: ['Read'], Resource: { Condition: { Left: 'resource.linkedTo', Comparison: '=', Right: 'Scorecard:missing' } } },
    ] } }] }, classes, {}, metadata(Object.keys(classes)));
    expect(cellMarks(gap, '3', 'CeIssue').Read).toBe('unresolved');
    expect(cellKinds(gap, '3', 'CeIssue', 'Read')).toEqual([]);
  });

  it('puts types in bands with per-role counts that keep unresolved evidence as "?"', () => {
    const grid = transposeMatrix(index, { ...matrixGridState(), hideEmpty: false });
    expect(grid.roles.map(r => r.id)).toEqual(['management', 'owner', 'auditor']);
    expect(grid.bands.map(b => b.group)).toEqual(['Structure', 'Enterprise objects', 'Interface objects', 'Other types']);
    expect(grid.rows.filter(r => r.kind === 'type').map(r => r.id)).toEqual(['*', 'Organisation', 'Scorecard', 'CeIssue', 'CeRisk', 'CeRiskAssessment', 'TableView', 'Note']);
    // The first row holds the statements that name no type; it belongs to no band.
    expect(grid.rows[0]).toMatchObject({ kind: 'type', id: '*', any: true });
    const enterprise = grid.bands[1];
    expect(enterprise.counts.get('2').text).toBe('1 of 3');
    // Auditor's HasAccessTo grant is conditional, so it counts; only an unreadable statement counts as "?".
    expect(enterprise.counts.get('3').text).toBe('3 of 3');
    const gap = createMatrixIndex({ ...model, policies: [{ rid: 'g', name: 'Gap', enabled: true, content: { Statement: [
      { Effect: 'Allow', Subject: ['role:auditor'], Action: ['Read'], Resource: { Condition: { Left: 'resource.linkedTo', Comparison: '=', Right: 'Scorecard:missing' } } },
    ] } }] }, classes, {}, metadata(Object.keys(classes)));
    expect(transposeMatrix(gap, { ...matrixGridState(), hideEmpty: false }).bands[1].counts.get('3').text).toBe('? of 3');
    expect(grid.bands[0].counts.get('3').text).toBe('2 of 2');
    expect(countText({ granted: 2, unresolved: 1, total: 24 })).toBe('2 + 1? of 24');
    expect(countText({ granted: 0, unresolved: 0, total: 31, pending: true })).toBe('? of 31');
    // The Can do panel writes the same count in words.
    expect(countWords({ granted: 1, unresolved: 94, total: 95 })).toBe('1 of 95 · 94 undecided');
    expect(countWords({ granted: 0, unresolved: 3, total: 27 })).toBe('undecided · 27');
    expect(countWords({ granted: 54, unresolved: 0, total: 54 })).toBe('54 of 54');
  });

  it('follows the lens, the role filter, collapsed bands and hide empty', () => {
    const update = transposeMatrix(index, { ...matrixGridState(), lens: 'Update' });
    expect(update.rows.filter(r => r.kind === 'type').map(r => r.id)).toEqual(['CeRisk']);
    expect(update.bands[1].counts.get('1').text).toBe('0 of 3');
    expect(update.bands[1].counts.get('2').text).toBe('1 of 3');
    const one = transposeMatrix(index, { ...matrixGridState(), role: '2', unresolved: false });
    expect(one.roles.map(r => r.rid)).toEqual(['2']);
    expect(one.rows.filter(r => r.kind === 'type').map(r => r.id)).toEqual(['Organisation', 'Scorecard', 'CeRisk']);
    const closed = transposeMatrix(index, { ...matrixGridState(), closed: ['Structure'] });
    expect(closed.rows[0]).toMatchObject({ kind: 'type', id: '*' });
    expect(closed.rows[1]).toMatchObject({ kind: 'band', group: 'Structure', open: false });
    expect(closed.rows[2].kind).toBe('band');
  });

  it('explains a cell by operation, naming where each statement comes from', () => {
    const why = cellWhy(index, '2', 'CeRisk');
    expect(why.map(w => w.mark)).toEqual(['none', 'inherited', 'conditional', 'none']);
    expect(why[1].rules.map(r => [r.rule.index, r.label])).toEqual([[0, 'inherited via Risk management']]);
    expect(why[2].rules.map(r => [r.rule.index, r.label, r.conditional])).toEqual([[1, 'names this role', true]]);
    expect(cellWhy(index, '2', 'Organisation')[1].rules[0].label).toBe('inherited via Everyone (*)');
  });

  it('computes virtual rows', () => {
    const offsets = rowOffsets([{ kind: 'band' }, { kind: 'type' }, { kind: 'type' }, { kind: 'band' }]);
    expect([...offsets]).toEqual([0, 34, 62, 90, 124]);
    expect(visibleRange(offsets, 40, 30, 0)).toEqual([1, 3]);
  });
});

describe('matrix scale', () => {
  it('builds and transposes about 620 types and 25 roles quickly', () => {
    const many = {};
    for (let i = 0; i < 520; i++) many['CeType' + String(i).padStart(3, '0')] = [];
    for (let i = 0; i < 70; i++) many['Widget' + i + 'View'] = [];
    for (let i = 0; i < 28; i++) many['Misc' + i] = [];
    many.Organisation = []; many.Scorecard = [];
    const types = Object.keys(many);
    const roles = Array.from({ length: 25 }, (_, i) => ({ rid: String(100 + i), id: 'role_' + i, name: 'Role ' + i, parent: i % 5 ? String(100 + i - 1) : '' }));
    const statements = Array.from({ length: 90 }, (_, i) => ({ Effect: i % 11 ? 'Allow' : 'Deny', Subject: i % 13 ? ['role:role_' + (i % 25)] : '*',
      Action: [['Read'], ['Read', 'Update'], ['Create', 'Read', 'Update', 'Delete']][i % 3],
      Resource: i % 7 ? { All: [type(...types.slice((i * 7) % 600, (i * 7) % 600 + 1 + (i % 9))), ...(i % 4 ? [] : [{ Condition: { Left: 'resource.owner', Comparison: '=', Right: 'user' } }])] }
        : { HasAccessTo: { Reference: 'resource.parent' } } }));
    const big = { roles, policies: [{ rid: 'p', enabled: true, content: { Statement: statements } }], scope: [], globals: [], folders: [] };
    const started = performance.now();
    const bigIndex = createMatrixIndex(big, many, {}, metadata(types));
    const grid = transposeMatrix(bigIndex, { ...matrixGridState(), hideEmpty: false });
    const lens = transposeMatrix(bigIndex, { ...matrixGridState(), lens: 'Update' });
    const elapsed = performance.now() - started;
    expect(grid.rows.filter(r => r.kind === 'type' && !r.any)).toHaveLength(620);
    expect(lens.bands.length).toBeGreaterThan(0);
    console.info(`[matrix bench] 620 types x 25 roles, 90 statements: index + 2 transpositions in ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('kinds of condition', () => {
  it('names each kind and words a list of them', () => {
    expect(Object.keys(KINDS)).toEqual(['own', 'related', 'model', 'some']);
    expect(Object.values(KINDS).map(k => k.word)).toEqual(['own objects', 'through a related object', 'in certain models', 'certain objects']);
    expect(kindWords(['own', 'related'])).toBe('own objects, through a related object');
    expect(kindWords([])).toBe('');
    expect(kindWords(undefined)).toBe('');
    expect(MARKS.conditional.word).toBe('Under a condition');
    expect(MARKS.unresolved.word).toBe('Unknown');
  });
});

describe('ordering and words', () => {
  it('puts Everyone first and each role after its parent', () => {
    const roles = [{ rid: 'b', id: 'b', name: 'Basic', parent: '' }, { rid: 'c', id: 'c', name: 'Child', parent: 'e' }, { rid: 'e', id: 'everyone', name: 'Everyone', parent: '' }, { rid: 'a', id: 'a', name: 'Alpha', parent: 'e' }];
    expect(orderRoles(roles).map(r => r.rid)).toEqual(['e', 'a', 'c', 'b']);
  });
  it('fills every operation for a role and says when nothing is granted', () => {
    const update = roleBandCounts(index, '1', 'Update');
    expect(update.map(r => r.text)).toEqual(['0 of 2', '0 of 3', '0 of 1', '0 of 1']);
    expect(nothingGranted(update)).toBe(true);
    expect(nothingGranted(roleBandCounts(index, '1', 'Read'))).toBe(false);
  });
  it('words reasons once and checks whether a selection is on the grid', () => {
    // Only gaps are worded; conditions are marks on the letter, not words here.
    expect(unresolvedWords(['Object reference unavailable or missing', 'Type inheritance unavailable', 'Object reference unavailable or missing', 'Unsupported comparison', 'Operand requires engine evaluation']))
      .toEqual(['a referenced object is not loaded', 'the type hierarchy is not loaded', 'the statement uses something the matrix cannot read']);
    expect(unresolvedWords(undefined)).toEqual([]);
    const grid = transposeMatrix(index, { ...matrixGridState(), hideEmpty: false, role: '2' });
    expect(selectionVisible(grid, { role: '2', type: 'CeRisk' })).toBe(true);
    expect(selectionVisible(grid, { role: '1', type: 'CeRisk' })).toBe(false);
  });
});
describe('statements that name no type', () => {
  const policy = (rid, statements) => ({ rid, id: 'p' + rid, name: 'P' + rid, enabled: true, content: { Version: '1', Statement: statements } });
  const model = {
    roles: [{ rid: '1', id: 'everyone', name: 'Everyone', parent: '' }, { rid: '2', id: 'editor', name: 'Editor', parent: '1' }],
    policies: [
      policy('10', [{ Effect: 'Allow', Subject: 'role:editor', Action: ['Update'], Resource: { Condition: { Left: 'resource.owner', Comparison: '=', Right: 'user' } } }]),
      policy('11', [{ Effect: 'Allow', Subject: 'role:editor', Action: ['Read'], Resource: { Condition: { Left: 'resource.type', Comparison: '=', Right: 'CeRisk' } } }]),
    ],
  };
  const index = createMatrixIndex(model, { CeRisk: {}, CeIssue: {} });

  it('get one row of their own and still count in every type cell', () => {
    expect(cellMark(index, '2', '*', 'Update')).toBe('conditional');
    expect(cellKinds(index, '2', '*', 'Update')).toEqual(['own']);
    expect(cellMark(index, '2', '*', 'Read')).toBe('none');
    // The type cell shows the full effective access.
    expect(cellMark(index, '2', 'CeIssue', 'Update')).toBe('conditional');
    expect(cellMark(index, '2', 'CeRisk', 'Read')).toBe('granted');
  });

  it('do not keep a type row that nothing else grants when empty rows are hidden', () => {
    const grid = transposeMatrix(index, matrixGridState());
    expect(grid.rows.filter(r => r.kind === 'type').map(r => r.id)).toEqual(['*', 'CeRisk']);
    const all = transposeMatrix(index, { ...matrixGridState(), hideEmpty: false });
    expect(all.rows.filter(r => r.kind === 'type').map(r => r.id)).toEqual(['*', 'CeIssue', 'CeRisk']);
  });

  it('list only those statements in the row\'s detail', () => {
    expect(index.cell('2', '*').rules.map(r => r.key)).toEqual(['10:0']);
    expect(index.cell('2', 'CeRisk').rules.map(r => r.key).sort()).toEqual(['10:0', '11:0']);
  });
});

describe('a statement that only excludes a type', () => {
  const policy = (rid, statements) => ({ rid, id: 'p' + rid, name: 'P' + rid, enabled: true, content: { Version: '1', Statement: statements } });
  const model = {
    roles: [{ rid: '2', id: 'editor', name: 'Editor', parent: '' }],
    policies: [policy('10', [{ Effect: 'Allow', Subject: 'role:editor', Action: ['Read'], Resource: { All: [
      { Condition: { Left: 'resource.type', Comparison: '!=', Right: 'CeRisk' } },
      { Condition: { Left: 'resource.owner', Comparison: '=', Right: 'user' } },
    ] } }])],
  };
  const index = createMatrixIndex(model, { CeRisk: {}, CeIssue: {} }, {}, { types: { CeRisk: { concrete: true, parents: [] }, CeIssue: { concrete: true, parents: [] } } });

  it('is in the Any type row, so the grant is on screen while empty rows are hidden', () => {
    expect(cellMark(index, '2', '*', 'Read')).toBe('conditional');
    expect(cellKinds(index, '2', '*', 'Read')).toEqual(['own']);
    expect(transposeMatrix(index, matrixGridState()).rows.filter(r => r.kind === 'type').map(r => r.id)).toEqual(['*']);
  });

  it('still decides each type in its own row', () => {
    expect(cellMark(index, '2', 'CeIssue', 'Read')).toBe('conditional');
    expect(cellMark(index, '2', 'CeRisk', 'Read')).toBe('none');
  });
});
