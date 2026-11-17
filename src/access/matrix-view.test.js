// @vitest-environment happy-dom
/* global performance, console */
import { expect, it, vi } from 'vitest';
import { mountMatrix, matrixState } from './matrix-view.js';
import { createMatrixIndex } from './matrix-model';

const c = (Left, Comparison, Right) => ({ Condition: { Left, Comparison, Right } });
const metadata = names => ({ types: Object.fromEntries(names.map(t => [t, { concrete: true, parents: [] }])), references: {} });
const classes = { Scorecard: [], CeRisk: [], CeIssue: [], Note: [] };
const model = {
  roles: [{ rid: '1', id: 'management', name: 'Risk management', parent: '' }, { rid: '2', id: 'owner', name: 'Risk owner', parent: '1' }],
  policies: [{ rid: '9', name: 'Register', enabled: true, content: { Statement: [
    { Subject: ['role:management'], Effect: 'Allow', Action: ['Read'], Resource: c('resource.type', '=', 'CeRisk') },
    { Subject: ['role:owner'], Effect: 'Allow', Action: ['Update'], Resource: { All: [c('resource.type', '=', 'CeRisk'), c('resource.status', '=', 'Open')] } },
    { Subject: '*', Effect: 'Allow', Action: ['Read'], Resource: { HasAccessTo: { Reference: 'resource.owner' } } },
    // Grant-only engine: this matches the owner's Delete on CeRisk but grants and blocks nothing.
    { Subject: ['role:owner'], Effect: 'Deny', Action: ['Delete'], Resource: c('resource.type', '=', 'CeRisk') },
  ] } }],
};
const mount = (state = matrixState(), options = {}) => {
  document.body.innerHTML = '<div id="matrix" style="height:600px"></div>';
  const host = document.querySelector('#matrix');
  const index = createMatrixIndex(model, classes, {}, metadata(Object.keys(classes)));
  const props = { index, state, changed: vi.fn(), canOpen: () => true, openRule: vi.fn(), test: vi.fn(), ...options };
  return { host, state, props, view: mountMatrix(host, props) };
};

it('puts types down in bands and roles across, with marks, counts and an honest legend', () => {
  const retry = vi.fn(), more = vi.fn();
  const { host, view } = mount({ ...matrixState(), hideEmpty: false }, { retryEvidence: retry, moreEvidence: more, hasDraftChanges: true, metadataStatus: '1 reference unavailable' });
  expect([...host.querySelectorAll('.mh [data-matrix-role] b')].map(el => el.textContent)).toEqual(['Risk management', 'Risk owner']);
  expect([...host.querySelectorAll('.mb b')].map(el => el.textContent)).toEqual(['Structure', 'Enterprise objects', 'Other types']);
  expect([...host.querySelectorAll('.mr .nm')].map(el => el.textContent)).toEqual(['Scorecard', 'CeIssue', 'CeRisk', 'Note']);
  const owner = host.querySelector('[data-matrix-cell="2"][data-type="CeRisk"]');
  expect([...owner.querySelectorAll('.m')].map(el => el.className)).toEqual(['m none', 'm inherited', 'm conditional', 'm none']);
  expect(owner.getAttribute('aria-label')).toBe('Risk owner, CeRisk: Create not granted, Read inherited, Update conditional, Delete not granted');
  expect(host.querySelector('[data-matrix-cell="1"][data-type="CeIssue"] .m.unresolved')).not.toBeNull();
  // Counts never turn unresolved evidence into zero.
  expect([...host.querySelectorAll('.mb')][1].querySelectorAll('.mc.cnt')[1].textContent).toBe('1 + 1? of 2');
  expect([...host.querySelectorAll('.mb')][0].querySelectorAll('.mc.cnt')[0].textContent).toBe('? of 1');
  expect(host.querySelector('.legend').textContent).toContain('Saved policies · Unsaved changes are not included. No mark: not granted.');
  expect(host.querySelector('.legend').textContent).not.toMatch(/Deny|⊘/);
  expect(host.querySelector('.m.deny, .lw.deny')).toBeNull();
  host.querySelector('[data-matrix-retry]').click(); expect(retry).toHaveBeenCalledTimes(1);
  host.querySelector('[data-matrix-more]').click(); expect(more).toHaveBeenCalledTimes(1);
  view.destroy();
});

it('uses words for one operation, filters one role with a Granted by column, and folds bands', () => {
  const { host, state } = mount();
  host.querySelector('[data-matrix-lens="Update"]').click();
  expect(state.lens).toBe('Update');
  expect(host.querySelector('[data-matrix-cell="2"][data-type="CeRisk"]').textContent).toBe('Conditional');
  host.querySelector('[data-matrix-role="2"]').click();
  expect(state.role).toBe('2');
  expect(host.querySelectorAll('.mh [data-matrix-role]')).toHaveLength(1);
  expect(host.querySelector('.mh').textContent).toContain('Granted by');
  const row = [...host.querySelectorAll('.mr')].find(r => r.querySelector('.nm').textContent === 'CeRisk');
  expect(row.querySelector('.mc.why').textContent).toBe('Register #2');
  host.querySelector('[data-matrix-role-clear]').click();
  expect(state.role).toBe('');
  host.querySelector('[data-matrix-band="Enterprise objects"]').click();
  expect(state.closed).toEqual(['Enterprise objects']);
  expect(host.querySelector('[data-matrix-band="Enterprise objects"]').getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('[data-type="CeRisk"]')).toBeNull();
});

it('renders a cell matched only by a Deny statement as not granted, with no Deny mark or rule', () => {
  const { host } = mount({ ...matrixState(), hideEmpty: false, lens: 'Delete' });
  const cell = host.querySelector('[data-matrix-cell="2"][data-type="CeRisk"]');
  expect(cell.getAttribute('aria-label')).toBe('Risk owner, CeRisk: Delete not granted');
  expect(cell.querySelector('.lw')).toBeNull();
  expect(cell.textContent).toBe('');
  cell.click();
  const side = host.querySelector('.mside');
  const del = [...side.querySelectorAll('.wy')].find(w => w.querySelector('.wh b').textContent === 'Delete');
  expect(del.querySelector('.st2').textContent).toBe('not granted: no statement grants it');
  expect(del.querySelector('[data-matrix-open]')).toBeNull();
  expect(side.textContent).not.toContain('Deny');
});

it('explains a selected cell by operation, with inherited-via and actions', () => {
  const { host, state, props } = mount();
  host.querySelector('[data-matrix-cell="2"][data-type="CeRisk"]').click();
  expect(state.selected).toEqual({ role: '2', type: 'CeRisk' });
  expect(host.querySelector('.mc.cell.on [data-matrix-cell="2"]')).not.toBeNull();
  const side = host.querySelector('.mside');
  expect(side.textContent).toContain('Risk owner on CeRisk');
  expect(side.textContent).toContain('inherited via Risk management');
  expect(side.textContent).toContain('depends on the object');
  expect(side.textContent).toContain('Why here: depends on access to a related object.');
  host.querySelector('[data-matrix-open="9"][data-statement="1"]').click();
  expect(props.openRule).toHaveBeenCalledWith('9', 1);
  const op = host.querySelector('select[data-matrix-action]'); op.value = 'Update'; op.dispatchEvent(new Event('change', { bubbles: true }));
  host.querySelector('[data-matrix-test]').click();
  expect(props.test).toHaveBeenCalledWith({ role: '2', type: 'CeRisk' }, 'Update');
});

it('keeps keyboard focus in the grid and on filters across rerenders, and restores an older saved state', () => {
  const old = { roleQ: '', typeQ: '', filters: ['Read'], sections: [], hideEmpty: false, unresolved: false, sort: 'name', selected: null, collapsed: false, width: 296,
    scroll: [0, 0], inspectorScroll: 0, closed: ['9:0'], json: [], action: 'Read', focus: '' };
  const { host, state } = mount(old);
  expect(state.lens).toBe('All');
  expect(state.closed).toEqual([]);
  const first = host.querySelector('[data-matrix-cell="1"][data-type="Scorecard"]');
  first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.activeElement.dataset.gridKey).toBe('2|Scorecard');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement.dataset.gridKey).toBe('band|Enterprise objects');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement.dataset.gridKey).toBe('1|CeIssue');
  const search = host.querySelector('[data-matrix-input="typeQ"]');
  search.focus(); search.value = 'Ce'; search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.activeElement).toBe(host.querySelector('[data-matrix-input="typeQ"]'));
  expect([...host.querySelectorAll('.mr .nm')].map(el => el.textContent)).toEqual(['CeIssue', 'CeRisk']);
});

it('renders only the visible rows of a large catalogue', () => {
  const many = Object.fromEntries(Array.from({ length: 620 }, (_, i) => ['CeType' + String(i).padStart(3, '0'), []]));
  const roles = Array.from({ length: 25 }, (_, i) => ({ rid: String(100 + i), id: 'r' + i, name: 'Role ' + i, parent: '' }));
  const big = { roles, policies: [{ rid: 'p', enabled: true, content: { Statement: roles.map((r, i) => ({ Subject: ['role:' + r.id], Effect: 'Allow', Action: ['Read'], Resource: c('resource.type', '=', 'CeType' + String(i * 20).padStart(3, '0')) })) } }] };
  document.body.innerHTML = '<div id="matrix"></div>';
  const host = document.querySelector('#matrix');
  const index = createMatrixIndex(big, many, {}, metadata(Object.keys(many)));
  const started = performance.now();
  mountMatrix(host, { index, state: { ...matrixState(), hideEmpty: false }, changed: vi.fn(), canOpen: () => true, openRule: vi.fn(), test: vi.fn() });
  const elapsed = performance.now() - started;
  expect(host.querySelectorAll('.mr').length).toBeLessThan(80);
  expect(host.querySelector('.mbody').style.height).toBe(34 + 620 * 28 + 'px');
  console.info(`[matrix bench] first render of 620 types x 25 roles in happy-dom: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(2000);
});

it('clears the panel when its cell leaves the grid and explains an empty grid', () => {
  const { host, state } = mount({ ...matrixState(), hideEmpty: false });
  host.querySelector('[data-matrix-cell="2"][data-type="CeRisk"]').click();
  host.querySelector('[data-matrix-role="1"]').click();
  expect(state.selected).toBeNull();
  expect(host.querySelector('.mside').textContent).toContain('Select a cell');
  host.querySelector('[data-matrix-role-clear]').click();
  const check = host.querySelector('[data-matrix-empty]'); check.checked = true; check.dispatchEvent(new Event('change', { bubbles: true }));
  host.querySelector('[data-matrix-lens="Delete"]').click();
  expect(host.querySelector('.mempty').textContent).toContain('No type has a grant under Delete.');
  // Band label and counts agree: no rows shown, and the open question is a "?" count, not a contradiction.
  expect(host.querySelector('[data-matrix-band="Enterprise objects"] .ct').textContent).toBe('0 of 2 types shown');
  host.querySelector('[data-matrix-show-empty]').click();
  expect(state.hideEmpty).toBe(false);
  expect(host.querySelectorAll('.mr').length).toBeGreaterThan(0);
});