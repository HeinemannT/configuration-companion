import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  changePatch
} from './history-model.js';
import {
  scopeOwner,
  roleDefinitions,
  historyRecordIds,
  historyStep,
  createViewNavigation
} from './navigation-model.js';
const base = () => ({
  roles: [{
    rid: '9000000000000000001',
    id: 'region',
    name: 'Region',
    parent: ''
  }, {
    rid: 'other',
    id: 'other',
    name: 'Other',
    parent: ''
  }],
  scope: [{
    rid: 'a',
    parent: '9000000000000000001',
    kind: 'RoleAssignment',
    field: 'owner'
  }, {
    rid: 'd',
    parent: 'a',
    kind: 'InwardsReferenceRoleDelegationRule',
    field: 'region'
  }, {
    rid: 'e',
    parent: 'd',
    kind: 'HierarchicalDownwardsRoleDelegationRule',
    field: ''
  }, {
    rid: 'x',
    parent: 'other',
    kind: 'RoleAssignment'
  }],
  globals: [{
    rid: 'g',
    parent: '9000000000000000001',
    mode: 'User',
    subject: '9000000000000000002'
  }],
  policies: [],
  folders: []
});
test('role outline follows assignment and delegation ownership without mixing child roles', () => {
  const model = base(),
    rows = roleDefinitions(model, model.roles[0].rid);
  assert.deepEqual(rows.map(r => [r.rid, r.depth]), [
    ['a', 1],
    ['d', 2],
    ['e', 3]
  ]);
  assert.ok(!rows.some(row => row.rid === 'g'), 'Global user/group memberships do not belong in the configuration tree');
  assert.equal(scopeOwner(model, 'g'), model.roles[0].rid);
  assert.equal(scopeOwner(model, 'e'), model.roles[0].rid);
  model.scope.push({
    rid: 'cycle1',
    parent: 'cycle2'
  }, {
    rid: 'cycle2',
    parent: 'cycle1'
  });
  assert.equal(scopeOwner(model, 'cycle1'), null);
});
test('record history includes nested delegation edits and deleted assignments', () => {
  const before = base(),
    after = structuredClone(before);
  after.scope = after.scope.filter(r => !['a', 'd', 'e'].includes(r.rid));
  const event = {
    before,
    after,
    patch: changePatch(before, after)
  };
  assert.ok(historyRecordIds(event).includes('9000000000000000001'));
  assert.ok(!historyRecordIds(event).includes('other'));
});
test('individual Undo and Restore preserve independent later edits and block overwritten values', () => {
  const before = base(),
    after = structuredClone(before);
  after.roles[0].name = 'Regional reviewer';
  const event = {
      before,
      after,
      patch: changePatch(before, after)
    },
    later = structuredClone(after);
  later.roles[1].name = 'Keep this';
  const undo = historyStep(later, event);
  assert.equal(undo.kind, 'undo');
  assert.equal(undo.model.roles[1].name, 'Keep this');
  const restore = historyStep(undo.model, event);
  assert.equal(restore.kind, 'restore');
  assert.equal(restore.model.roles[0].name, 'Regional reviewer');
  assert.equal(restore.model.roles[1].name, 'Keep this');
  later.roles[0].name = 'Newest name';
  const blocked = historyStep(later, event);
  assert.equal(blocked.status, 'Changed later');
  assert.match(blocked.reason, /later edit/);
  assert.equal(blocked.model, undefined);
});
test('history Restore cannot recreate a broken hierarchy or duplicate role ID', () => {
  const before = base(),
    after = structuredClone(before);
  after.roles.push({
    rid: 'new',
    id: 'new',
    name: 'Child',
    parent: before.roles[0].rid
  });
  const event = {
      before,
      after,
      patch: changePatch(before, after)
    },
    changed = structuredClone(before);
  changed.roles.push({
    rid: 'collision',
    id: 'new',
    name: 'Another',
    parent: ''
  });
  assert.match(historyStep(changed, event).reason, /depends/);
});

test('browser Back/Forward restores views and branching drops the old forward route', () => {
  const entries = [], restored = [];
  const browser = { state: null, replaceState(e) { entries[entries.length - 1 < 0 ? 0 : entries.length - 1] = e; }, pushState(e) { entries.push(e); } };
  const nav = createViewNavigation(browser, 'environment', route => restored.push(route));
  const first = { surface: 'record', kind: 'policy', rid: '9000000000000000001', statement: 2 };
  nav.sync(first); nav.sync({ ...first, statement: 3 });
  assert.equal(entries.length, 1);
  nav.sync({ surface: 'history', kind: 'policy', rid: first.rid, statement: 3 });
  const second = entries[1];
  assert.equal(nav.back, true); assert.equal(nav.forward, false);
  nav.pop(entries[0]); assert.equal(restored[0].statement, 3); assert.equal(nav.forward, true);
  nav.pop(second); assert.equal(restored[1].surface, 'history');
  nav.pop(entries[0]); nav.sync({ ...first, rid: 'other' });
  assert.equal(nav.forward, false);
  assert.equal(nav.pop({ ...second, companionAccess: 'another environment' }), false);
});

test('reloading after Back retains the forward destination', () => {
  const entries = [], values = new Map();
  const browser = { state: null, replaceState(e) { this.state = e; entries[entries.length ? entries.length - 1 : 0] = e; }, pushState(e) { this.state = e; entries.push(e); } };
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const nav = createViewNavigation(browser, 'environment', () => {}, storage);
  nav.sync({ surface: 'record', kind: 'role', rid: '1' });
  nav.sync({ surface: 'record', kind: 'role', rid: '2' });
  nav.pop(entries[0]); browser.state = entries[0];
  const restored = createViewNavigation(browser, 'environment', () => {}, storage);
  assert.equal(restored.forward, true); assert.equal(restored.back, false);
});

test('explicit definition selections navigate while scroll and edits replace the same route', () => {
  const entries = [], restored = [];
  const browser = { state: null, replaceState(e) { this.state = e; entries[entries.length ? entries.length - 1 : 0] = e; },
    pushState(e) { this.state = e; entries.push(e); } };
  const nav = createViewNavigation(browser, 'environment', route => restored.push(route));
  const role = { surface: 'record', kind: 'role', rid: '9000000000000000001', scopeSelection: null };
  nav.sync(role);
  nav.sync({ ...role, scopeSelection: 'assignment' });
  nav.sync({ ...role, scopeSelection: 'delegation' });
  nav.sync({ ...role, scopeSelection: 'delegation', scroll: 120 });
  nav.sync({ ...role, scopeSelection: 'delegation', scroll: 180, edited: true });
  assert.equal(entries.length, 3);
  nav.pop(entries[1]);
  assert.equal(restored[0].scopeSelection, 'assignment');
  assert.equal(nav.forward, true);
  nav.pop(entries[2]);
  assert.equal(restored[1].scopeSelection, 'delegation');
  nav.sync(role, true); // The selected definition was removed by an edit.
  assert.equal(entries.length, 3);
  assert.equal(browser.state.route.scopeSelection, null);
});
