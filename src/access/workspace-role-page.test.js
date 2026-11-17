// @vitest-environment happy-dom
// The redesigned Access workspace: statement rows, conditions, context panel,
// review, role page, blocked Rules and the saved-policies test banner.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';
import { DENY_IGNORED } from './pbac-syntax';
import { shortcutLabel } from '../lib/shortcuts';

function setup(adjust = () => {}, respond = () => undefined) {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  adjust(fixture);
  let saved;
  const api = vi.fn(async request => {
    const answer = respond(request, fixture);
    if (answer !== undefined) return answer;
    if (request.operation === 'schema') return fixture.classes[request.type] || [];
    if (request.operation === 'trace') return { element: 'TraceRequest', result: false, timedOut: false, details: {}, children: [] };
    if (request.operation === 'search') return [fixture.object];
    return [];
  });
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice: vi.fn(), busy: () => {}, persist: async read => { saved = read(); } });
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { await vi.waitFor(() => expect($(selector), selector).not.toBeNull()); $(selector).click(); await tick(); };
  const key = async (el, init) => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); await tick(); };
  return { ...fixture, api, workspace, $, $$, tick, click, key, stored: () => saved.model, persisted: () => saved };
}

// Sequential focus order as a browser computes it (no positive tabindex is used
// here): focusable elements in document order, minus tabindex="-1", disabled
// controls and anything hidden.
const tabStops = () => [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(el =>
  el.getAttribute('tabindex') !== '-1' && !el.disabled && !el.closest('[hidden]') && !el.closest('dialog:not([open])'));
const tabFrom = el => { const stops = tabStops(); return stops[stops.indexOf(el) + 1]; };
const ROLE = '9000000000000000001';
const grant = (subject, actions, extra = {}) => ({ Effect: 'Allow', Subject: subject, Action: actions, Resource: { All: [] }, ...extra });

it('shows one role page without inner tabs: who has it, then what it grants and where each statement comes from', async () => {
  const { snapshot, workspace, $, $$, tick, click } = setup(({ snapshot }) => {
    snapshot.model.roles.push({ rid: '9000000000000000010', id: 'junior', name: 'Junior reviewer', parent: '9000000000000000001' });
    snapshot.model.policies[0].content.Statement.push({ Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [] } });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000010' }); await tick();
  expect($('.center-tabs')).toBeNull();
  expect($$('[data-role-section]').map(s => s.dataset.roleSection)).toEqual(['who', 'what']);
  expect($$('.rp-sh h2').map(h => h.textContent)).toEqual(['Who has this role', 'What it grants']);
  expect($('[data-role-section="what"]').textContent).toContain('Risk review access');
  // A link that used to open the Policies tab scrolls to the section instead.
  const what = $('[data-role-section="what"]');
  const link = Object.assign(document.createElement('button'), { type: 'button' });
  link.dataset.command = 'role-tab'; link.dataset.tab = 'policies';
  document.body.append(link);
  link.click(); await tick();
  expect(what.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  expect(document.activeElement).toBe(what);
  // Nothing here names the junior role: no 'Naming this role' group.
  expect($$('.gt-group .gt-title').map(h => h.textContent)).toEqual(['Inherited from Risk review', 'Granted to everyone (*)']);
  // The stored Deny is a row of its own: a Deny tag, its operation shown as named
  // but not granted, and the rules view's wording under it.
  const deny = $('.gt-st.ignored');
  expect(deny.dataset.grantRow).toBe('9000000000000000004:1');
  expect(deny.querySelector('.gt-tag').textContent).toBe('Deny');
  expect(deny.querySelectorAll('.gt-op.on')).toHaveLength(0);
  expect(deny.querySelector('.gt-op.named .sr-only').textContent).toBe('Read: named, not granted to this role');
  expect(deny.nextElementSibling.textContent).toBe(DENY_IGNORED);
  await click('.gt-st[data-grant-row="9000000000000000004:2"] [data-command="open-statement"]');
  expect($('.st.sel .n').textContent).toBe('3');
  expect(snapshot && $('#policy-tab-rules')).not.toBeNull();
});

it('says what the role counts count: distinct policies, not statements', async () => {
  const { workspace, $, tick } = setup(({ snapshot }) => {
    // Two more statements in the one policy: one policy, three statements in all.
    snapshot.model.policies[0].content.Statement.push({ Effect: 'Allow', Subject: ['role:risk_review'], Action: ['Update'], Resource: { All: [] } });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  // A group counts what grants, like the header, and says the rest apart.
  expect($('.gt-group .gt-c-app .n').textContent).toBe('2 statements in 1 policy · +1 that grants nothing');
  expect($('[data-role-section="who"] .rp-cnt').textContent).toBe('1 field assignment · 0 users or groups');
  // The header counts what grants to the role; the stored Deny is listed but counted apart.
  expect($('[data-role-section="what"] .rp-cnt').textContent).toBe('2 statements in 1 policy grant to this role · +1 that grants nothing');
});

it('names each reach direction the same way in the Flow and Fields views', async () => {
  const { workspace, $, $$, tick, click } = setup();
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  expect($('[data-command="reach-direction"]').textContent).toContain('Objects pointing here');
  await click('[data-command="reach-view"][data-value="fields"]');
  expect($$('select[data-scope="kind"] option').map(o => o.textContent)).toEqual(['Descendant objects', 'Objects pointing here', 'Objects linked from here', 'Ancestor objects']);
});

it('rolls a group up as "any of" its statements and leaves a stored Deny out of the roll-up', async () => {
  const { workspace, $, $$, tick } = setup(({ snapshot }) => {
    snapshot.model.policies[0].content.Statement[1].Action = ['Delete', 'Create'];
    snapshot.model.policies[0].content.Statement.push({ Effect: 'Allow', Subject: ['role:risk_review'], Action: ['Update'], Resource: { All: [] } });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  const group = $('.gt-group');
  expect(group.querySelector('.gt-any').textContent).toBe('any of');
  const on = cells => [...cells.querySelectorAll('.gt-op.on')].map(c => c.textContent.slice(1));
  expect(on(group.querySelector('.gt-cells'))).toEqual(['Read', 'Update']);
  expect(group.querySelector('.gt-c-ops .sr-only').textContent).toBe('Any of these statements grants: Read, Update. Not granted by any: Create, Delete.');
  // Each statement keeps its own cells; "Not granted" is text for screen readers.
  const rows = $$('.gt-st');
  expect(on(rows[0])).toEqual(['Read']);
  expect(rows[0].querySelectorAll('.gt-op.off .sr-only')[0].textContent).toBe('Create: Not granted');
  expect(rows[1].classList.contains('ignored')).toBe(true);
  expect(on(rows[1])).toEqual([]);
  expect(on(rows[2])).toEqual(['Update']);
});

it('opens and closes groups and statements with the keyboard', async () => {
  const { workspace, $, $$, tick, key } = setup(({ snapshot }) => {
    snapshot.model.policies[0].content.Statement.push({ Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [] } });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  const [own, everyone] = $$('.gt-group');
  // Tab from the control before the table lands on the first group row, and the
  // next Tab leaves the table: one tab stop.
  const before = $('[data-role-section="what"] [data-command="add-statement-for-role"]');
  before.focus();
  expect(tabFrom(before)).toBe(own);
  own.focus();
  expect($$('.gt [tabindex="0"]')).toEqual([own]);
  expect(tabFrom(own)?.closest('.gt-row')).toBeFalsy();
  await key(own, { key: 'ArrowLeft' });
  expect(own.getAttribute('aria-expanded')).toBe('false');
  expect($$('.gt-st[data-grant-of="own"]').every(r => r.hidden)).toBe(true);
  // The roll-up still reads while the group is closed.
  expect(own.querySelectorAll('.gt-cells .gt-op.on')).toHaveLength(1);
  await key(own, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(everyone);
  await key(everyone, { key: 'ArrowUp' });
  await key(own, { key: 'Enter' });
  expect(own.getAttribute('aria-expanded')).toBe('true');
  await key(own, { key: 'ArrowDown' });
  const first = document.activeElement;
  expect(first.dataset.grantRow).toBe('9000000000000000004:0');
  await key(first, { key: 'ArrowRight' });
  const detail = $('.gt-detail[data-grant-detail="9000000000000000004:0"]');
  expect(detail.hidden).toBe(false);
  expect(detail.querySelector('[data-command="open-statement"]').tabIndex).toBe(0);
  await key(first, { key: ' ' });
  expect(detail.hidden).toBe(true);
  await key(first, { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(own);
  expect($$('.gt-row[tabindex="0"]')).toEqual([own]);
  // After a re-render the last focused row is still the way in.
  await key(own, { key: 'ArrowDown' });
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const back = $('.gt-row[tabindex="0"]');
  expect(back.dataset.grantRow).toBe('9000000000000000004:0');
  expect(back.getAttribute('aria-describedby')).toBe('grant-keys');
  expect($('#grant-keys').textContent).toBe('Enter opens the details. O opens the policy.');
  // The open key opens the row's policy.
  back.focus();
  await key(back, { key: 'o', code: 'KeyO' });
  expect($('.record-name').value).toBe('Risk review access');
  // Focus goes into the opened policy, on that statement, not to the page body.
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).toBe($('.st-main[data-index="0"]'));
});

it('opens the parent role from an inherited group with the open key', async () => {
  const { workspace, $, tick, key } = setup(({ snapshot }) => {
    snapshot.model.roles.push({ rid: '9000000000000000010', id: 'junior', name: 'Junior reviewer', parent: ROLE });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000010' }); await tick();
  const group = $('.gt-group[data-origin="parent"]');
  expect(group.getAttribute('aria-describedby')).toBe('grant-keys-role');
  expect(group.tabIndex).toBe(0);
  group.focus();
  await key(group, { key: 'o', code: 'KeyO' });
  expect($('.record-name').value).toBe('Risk review');
  expect(document.activeElement).toBe($('#editor .gt-row[tabindex="0"]'));
});

it('lists a grandparent role as its own read-only group', async () => {
  const { workspace, $$, tick } = setup(({ snapshot }) => {
    snapshot.model.roles.push({ rid: '9000000000000000011', id: 'senior', name: 'Senior reviewer', parent: '' });
    snapshot.model.roles[0].parent = '9000000000000000011';
    snapshot.model.roles.push({ rid: '9000000000000000010', id: 'junior', name: 'Junior reviewer', parent: ROLE });
    snapshot.model.policies[0].content.Statement.push(grant(['role:senior'], ['Update']));
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000010' }); await tick();
  expect($$('.gt-group .gt-title').map(t => t.textContent)).toEqual(['Inherited from Risk review', 'Inherited from Senior reviewer']);
  expect($$('.gt-group .gt-c-app').map(c => c.textContent)).toEqual(['1 statement in 1 policy · +1 that grants nothing · Read-only', '1 statement in 1 policy · Read-only']);
  expect($$('.gt-group')[1].querySelector('.gt-c-ops .sr-only').textContent).toBe('Any of these statements grants: Update. Not granted by any: Create, Read, Delete.');
});

it('counts nothing from a disabled or invalid policy and says so in words', async () => {
  const { workspace, $, $$, tick } = setup(({ snapshot }) => {
    snapshot.model.policies[0].enabled = false;
    snapshot.model.policies.push({ rid: '9000000000000000005', id: 'broken', name: 'Broken', parent: '', enabled: true, valid: false, content: { Statement: [grant(['role:risk_review'], ['Update'])] } });
  });
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const rows = $$('.gt-st');
  expect(rows.map(r => r.querySelector('.gt-tag')?.textContent)).toEqual(['Disabled', 'Disabled', 'Invalid']);
  expect(rows.every(r => r.classList.contains('inactive') || r.classList.contains('ignored'))).toBe(true);
  expect(rows.flatMap(r => [...r.querySelectorAll('.gt-op.on')])).toEqual([]);
  expect(rows[2].querySelector('.gt-op.named .sr-only').textContent).toBe('Update: named, not granted to this role');
  expect($('.gt-group .gt-cells .gt-op.on')).toBeNull();
  expect($('[data-role-section="what"] .rp-cnt').textContent).toBe('0 statements in 0 policies grant to this role · +3 that grant nothing');
  // The group labels add up to the header: granting rows, then the rest.
  expect($$('.gt-group .gt-c-app .n').map(n => n.textContent)).toEqual(['0 statements in 0 policies · +3 that grant nothing']);
  expect($('.rp-summary').textContent).toBe('Held through 1 field assignment. Nothing grants it anything.');
});

it('shows a condition check as naming operations it does not grant to this role', async () => {
  const { workspace, $, tick } = setup(({ snapshot }) => {
    snapshot.model.roles.push({ rid: '9000000000000000012', id: 'other', name: 'Other', parent: '' });
    snapshot.model.policies[0].content.Statement.push(grant(['role:other'], ['Delete'], { Resource: { HasRole: { Reference: 'resource.parent', Roles: ['risk_review'] } } }));
  });
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const group = $('.gt-group[data-origin="condition"]');
  expect(group.querySelector('.gt-c-ops').textContent).toBe('Grants nothing to this role.');
  const row = $('.gt-st[data-grant-of="condition"]');
  expect(row.querySelectorAll('.gt-op.on')).toHaveLength(0);
  expect(row.querySelector('.gt-op.named').title).toBe('Delete: named, not granted to this role');
  expect($('.rp-summary').textContent).toBe('Held through 1 field assignment. May Read on some objects; Create, Update and Delete: Not granted.');
});

it('says "on some objects" only while every grant of an operation has a condition', async () => {
  const { workspace, $, tick } = setup(({ snapshot }) => {
    snapshot.model.policies[0].content.Statement.push(grant(['role:risk_review'], ['Read', 'Update']));
  });
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  expect($('.rp-summary').textContent).toBe('Held through 1 field assignment. May Read and Update; Create and Delete: Not granted.');
});

it('shows a long group in place: eight rows, then "Show N more"', async () => {
  const { workspace, $, $$, tick, click } = setup(({ snapshot }) => {
    for (let i = 0; i < 30; i++) snapshot.model.policies[0].content.Statement.push({ Effect: 'Allow', Subject: ['role:risk_review'], Action: ['Read'], Resource: { All: [] } });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  expect($$('.gt-st').filter(r => !r.hidden)).toHaveLength(8);
  expect($('.gt-more').textContent).toBe('Show 24 more');
  await click('[data-command="grant-more"]');
  expect($$('.gt-st').filter(r => !r.hidden)).toHaveLength(32);
  expect($('.gt-more')).toBeNull();
  expect(document.activeElement.dataset.grantRow).toBe('9000000000000000004:8');
  expect($$('.gt [role="row"]').filter(r => r.classList.contains('gt-row') && !r.classList.contains('gt-head')).every(r => r.getAttribute('aria-level'))).toBe(true);
});

it('keeps Show more working on a group that was closed', async () => {
  const { workspace, $, $$, tick, key, click } = setup(({ snapshot }) => {
    for (let i = 0; i < 12; i++) snapshot.model.policies[0].content.Statement.push(grant(['role:risk_review'], ['Read']));
  });
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const group = $('.gt-group');
  group.focus();
  await key(group, { key: 'ArrowLeft' });
  expect($('.gt-more').hidden).toBe(true);
  expect($('.gt-more').getAttribute('aria-level')).toBe('2');
  await key(group, { key: 'ArrowRight' });
  expect($$('.gt-st').filter(r => !r.hidden)).toHaveLength(8);
  await click('[data-command="grant-more"]');
  expect($$('.gt-st').filter(r => !r.hidden)).toHaveLength(14);
  await key(group, { key: 'ArrowLeft' });
  await key(group, { key: 'ArrowRight' });
  // Shown in full stays shown in full.
  expect($$('.gt-st').filter(r => !r.hidden)).toHaveLength(14);
});

it('writes a field assignment as a sentence whose labelled adds and removes make the same draft rows as before', async () => {
  const { workspace, $, $$, tick, click, stored } = setup();
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  const line = $('.rp-as-line');
  // Read as rendered: the pickers are words in the sentence.
  const read = line.querySelector('.rp-sentence').cloneNode(true);
  read.querySelectorAll('select').forEach(s => s.remove());
  expect(read.textContent).toBe('Users named in the owners field of each CeRiskAssessment get this role on:');
  expect([...line.querySelectorAll('select')].map(s => s.dataset.scope)).toEqual(['field', 'source']);
  expect([...line.querySelectorAll('.rp-tok')].map(t => [t.tagName, t.getAttribute('aria-label'), t.getAttribute('aria-haspopup')])).toEqual([
    ['BUTTON', 'Field: owners', 'dialog'], ['BUTTON', 'Type: CeRiskAssessment', 'dialog']]);
  // Remove sits with the sentence's first line, not on a line of its own.
  expect(line.lastElementChild.className).toBe('rp-acts');
  expect($$('.rp-step-line').map(l => l.querySelector('.rp-lead').textContent)).toEqual(['On', 'Also on']);
  expect($$('.rp-step-line')[0].textContent).toContain('that CeRiskAssessment (the object itself)');
  const choose = async label => { await tick(); [...document.querySelectorAll('#picker-results button')].find(b => b.querySelector('strong')?.textContent === label).click(); await tick(); };
  // "Also on…" branches from the object itself: a delegation whose parent is the assignment.
  await click('.rp-add[data-parent="9000000000000000002"]');
  await choose('Descendant objects');
  let added = stored().scope.at(-1);
  expect(added).toMatchObject({ kind: 'HierarchicalDownwardsRoleDelegationRule', parent: '9000000000000000002', name: 'New delegation', field: '', source: '' });
  expect(added.rid.startsWith('draft:')).toBe(true);
  // "Then on…" continues from a step: its parent is that step.
  await click('[data-command="reach-add"][data-parent="9000000000000000003"]');
  await choose('Ancestor objects');
  added = stored().scope.at(-1);
  expect(added).toMatchObject({ kind: 'HierarchicalUpwardsRoleDelegationRule', parent: '9000000000000000003' });
  expect($$('.rp-step-line').map(l => l.querySelector('.rp-lead').textContent)).toEqual(['On', 'Also on', 'Then on', 'Also on']);
  expect($$('.rp-step-line.dirty')).toHaveLength(2);
  expect($('.rp-as').classList.contains('dirty')).toBe(true);
  // Remove names what it removes and takes the step out of the draft.
  const remove = $(`[data-command="delete-scope"][data-rid="${added.rid}"]`);
  expect(remove.textContent).toBe('Remove');
  expect(remove.getAttribute('aria-label')).toBe('Remove Ancestor objects');
  remove.click(); await tick();
  expect(stored().scope.some(row => row.rid === added.rid)).toBe(false);
  // The Fields view is still there and shows the same rows as form rows.
  await click('[data-command="reach-view"][data-value="fields"]');
  expect($$('.rp-path select[data-scope="kind"]').map(s => s.value)).toEqual(['InwardsReferenceRoleDelegationRule', 'HierarchicalDownwardsRoleDelegationRule']);
  await click('.rp-frow [data-command="add-path"]');
  expect(stored().scope.at(-1)).toMatchObject({ kind: 'InwardsReferenceRoleDelegationRule', parent: '9000000000000000002' });
  // Unsaved edits on this role: a bar with the count and the way to review them.
  expect($('.rp-pending').textContent).toBe('2 unsaved changes on this roleReview changes');
  expect($('.rp-pending [data-command="review"]')).not.toBeNull();
});

it('says an empty section in one line and keeps both add actions in the header', async () => {
  const { workspace, $, $$, tick } = setup(({ snapshot }) => {
    snapshot.model.roles.push({ rid: '9000000000000000010', id: 'nobody', name: 'Nobody', parent: '' });
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000010' }); await tick();
  expect($$('[data-role-section="who"] .rp-empty').map(p => p.textContent)).toEqual([
    'No field assignment. Users named in an object’s field get the role on that object.', 'No users or groups hold this role directly.']);
  expect($('[data-role-section="who"] .rp-cnt').textContent).toBe('0 field assignments · 0 users or groups');
  expect($$('[data-role-section="who"] .rp-sh button').map(b => b.dataset.command)).toEqual(['add-assignment', 'add-global']);
  expect($('[data-role-section="what"] .rp-empty').textContent).toBe('No policy names this role, none come from its parent roles, and none apply to everyone.');
  expect($('.rp-summary').textContent).toBe('No one holds this role yet. Nothing grants it anything.');
});

it('keeps Performance and help one keyboard step away behind More in the top bar', async () => {
  const { workspace, $, $$, tick, click } = setup();
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  await click('.topbar-tools [data-command="topbar-more"]');
  expect($('#menu').hidden).toBe(false);
  expect($$('#menu [role^="menuitem"]').map(b => [b.dataset.command, b.getAttribute('role'), b.getAttribute('aria-checked')])).toEqual([['performance', 'menuitemcheckbox', 'false'], ['help', 'menuitem', null]]);
  expect(document.activeElement).toBe($('#menu [data-command="performance"]'));
  await click('#menu [data-command="performance"]');
  expect($('#menu').hidden).toBe(true);
  expect($('.doc-tab [data-command="performance"]').getAttribute('aria-selected')).toBe('true');
  await click('.topbar-tools [data-command="topbar-more"]');
  expect($('#menu [data-command="performance"]').getAttribute('aria-checked')).toBe('true');
  await click('#menu [data-command="help"]');
  expect($('#menu').hidden).toBe(true);
  expect(document.body.textContent).toContain('Companion · Access');
  // Escape closes the sheet again.
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  expect(document.body.textContent).not.toContain('Companion · Access');
});

it('cuts long explorer names in the middle and shows the full name on keyboard focus', async () => {
  const { workspace, $, tick } = setup(({ snapshot }) => {
    snapshot.model.policies[0].name = 'All Organisational Content - Maintain (by Organization Manager)';
  });
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  const row = $('#tree [data-open="9000000000000000004"]');
  expect(row.querySelector('.tree-name-start').textContent).toBe('All Organisational Content - ');
  expect(row.querySelector('.tree-name-end').textContent).toBe('Maintain (by Organization Manager)');
  expect($('#tree [data-open="9000000000000000001"] .tree-name').children).toHaveLength(1);
  row.focus(); await tick();
  const tip = $('#name-tip');
  expect(tip.hidden).toBe(false);
  expect(tip.textContent).toBe('All Organisational Content - Maintain (by Organization Manager)\nrisk_review_policy');
  expect(row.getAttribute('aria-describedby')).toBe('name-tip');
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(tip.hidden).toBe(true);
});

it('places the explorer tooltip beside its row, closes it as its own Escape layer and drops it with its row', async () => {
  const { workspace, $, tick, click } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  await click('.history-actions [data-command="history"]');
  expect($('#history-title')).not.toBeNull();
  const row = $('#tree [data-open="9000000000000000004"]');
  row.getBoundingClientRect = () => ({ left: 10, right: 240, top: 100, bottom: 128, width: 230, height: 28 });
  row.focus(); await tick();
  const tip = $('#name-tip');
  // Beside the row, level with it: the rows above and below stay visible.
  expect([tip.style.left, tip.style.top]).toEqual(['248px', '100px']);
  // One Escape closes the tooltip only; the history view behind it stays.
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(tip.hidden).toBe(true);
  expect($('#history-title')).not.toBeNull();
  row.blur(); row.focus(); await tick();
  expect(tip.hidden).toBe(false);
  row.remove();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  expect(tip.hidden).toBe(true);
});

it('keeps focus on a neighbour after Remove, and puts a removed row back in place with Undo', async () => {
  const { workspace, $, tick, stored } = setup(({ snapshot }) => {
    snapshot.model.scope.push({ rid: '9000000000000000006', id: 'down', name: 'Down', parent: '9000000000000000002', kind: 'HierarchicalDownwardsRoleDelegationRule', source: '', field: '' });
    snapshot.model.globals.push(
      { rid: '9000000000000000030', parent: ROLE, mode: 'User', subject: '9000000000000000040', subjectId: 'jdoe', subjectName: 'Jane Doe' },
      { rid: '9000000000000000031', parent: ROLE, mode: 'Group', subject: '9000000000000000041', subjectId: 'auditors', subjectName: 'Auditors' });
  });
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  // Remove a step: focus moves to the next step, the removed one stays in place.
  const remove = $('[data-command="delete-scope"][data-rid="9000000000000000003"]');
  remove.focus(); remove.click(); await tick();
  expect(document.activeElement).toBe($('[data-command="reach-direction"][data-rid="9000000000000000006"]'));
  const gone = $('[data-removed="9000000000000000003"]');
  expect(gone.textContent).toContain('Objects pointing here');
  expect(gone.textContent).toContain('Removed · unsaved');
  expect(gone.querySelector('s')).not.toBeNull();
  expect($('.rp-pending').textContent).toContain('1 unsaved change on this role');
  // Undo on that row puts it back, and focus goes to the row it put back.
  const putBack = gone.querySelector('[data-command="discard-one"]'); putBack.focus(); putBack.click(); await tick();
  expect(stored().scope.some(r => r.rid === '9000000000000000003')).toBe(true);
  expect($('[data-removed]')).toBeNull();
  expect(document.activeElement).toBe($('[data-command="delete-scope"][data-rid="9000000000000000003"]'));
  // Remove a user: focus moves to the next user's Remove.
  const user = $('[data-command="delete-global"][data-rid="9000000000000000030"]');
  user.focus(); user.click(); await tick();
  expect(document.activeElement).toBe($('[data-command="delete-global"][data-rid="9000000000000000031"]'));
  expect($('[data-removed="9000000000000000030"]').textContent).toContain('jdoe');
  // The last user: focus goes to that user's Undo.
  document.activeElement.click(); await tick();
  expect(document.activeElement).toBe($('[data-command="discard-one"][data-rid="9000000000000000031"]'));
});

it('asks before removing an assignment with steps, then keeps focus on its Undo', async () => {
  const { workspace, $, $$, tick, stored } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const remove = $('[data-command="delete-scope"][data-rid="9000000000000000002"]');
  expect(remove.textContent).toBe('Remove');
  remove.focus(); remove.click(); await tick();
  expect($('#dialog').open).toBe(true);
  expect($('#dialog').textContent).toContain('1 child entry will be removed');
  $('#dialog-form').dispatchEvent(new Event('submit', { cancelable: true })); await tick(); await tick();
  expect(stored().scope.filter(r => r.parent === ROLE || r.parent === '9000000000000000002')).toEqual([]);
  expect($$('.rp-as.removed')).toHaveLength(1);
  expect(document.activeElement).toBe($('[data-command="discard-one"][data-rid="9000000000000000002"]'));
  // Putting the assignment back shows its removed step under it, with its own Undo.
  document.activeElement.click(); await tick();
  expect($('[data-removed="9000000000000000003"]')).not.toBeNull();
});

it('keeps focus through undo and redo after each sentence action', async () => {
  const { workspace, $, tick, click, key, stored } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const choose = async label => { await tick(); [...document.querySelectorAll('#picker-results button')].find(b => b.querySelector('strong')?.textContent === label).click(); await tick(); };
  // Also on…, then Ctrl+Z from the same button: the step goes, focus stays on Also on….
  await click('.rp-add[data-parent="9000000000000000002"]');
  await choose('Descendant objects');
  const also = $('.rp-add[data-parent="9000000000000000002"]');
  also.focus();
  await key(also, { key: 'z', code: 'KeyZ', ...(/Ctrl/.test(shortcutLabel('access.undo')) ? { ctrlKey: true } : { metaKey: true }) });
  expect(stored().scope).toHaveLength(2);
  expect(document.activeElement).toBe($('.rp-add[data-parent="9000000000000000002"]'));
  // Redo from the toolbar: focus stays on a toolbar button, never the page body.
  const redo = $('[data-command="redo"]');
  redo.focus(); redo.click(); await tick();
  expect(stored().scope).toHaveLength(3);
  expect(document.activeElement).toBe($('[data-command="undo"]'));
  // Remove, then Undo from the toolbar: the step is back and focus is on Undo or Redo.
  const remove = $('[data-command="delete-scope"][data-rid="9000000000000000003"]');
  remove.focus(); remove.click(); await tick();
  expect(document.activeElement).not.toBe(document.body);
  const undo = $('[data-command="undo"]');
  undo.focus(); undo.click(); await tick();
  expect(stored().scope.some(r => r.rid === '9000000000000000003')).toBe(true);
  expect(['undo', 'redo']).toContain(document.activeElement.dataset.command);
});

it('closes Pending edits by itself when an undo on the role page leaves nothing pending', async () => {
  const { workspace, $, tick, click } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const remove = $('[data-command="delete-scope"][data-rid="9000000000000000003"]');
  remove.click(); await tick();
  await click('.rp-pending [data-command="review"]');
  expect($('.review-tab')).not.toBeNull();
  $('[data-command="undo"]').click(); await tick();
  expect($('.review-tab')).toBeNull();
  expect($('#tabs [role="tab"][aria-selected="true"]').dataset.tabKey).toBe('role:' + ROLE);
});

it('shows the matrix\'s own counts in the Can do panel, and no numbers before the matrix has counted', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const metadata = classes => ({ types: { Identifiable: { parents: [], concrete: false }, CeIssue: { parents: ['Identifiable'], concrete: true },
    ...Object.fromEntries(Object.keys(classes).map(type => [type, { parents: ['Identifiable'], concrete: true }])) }, models: {}, references: {}, unsupported: [], unavailable: [] });
  const t = setup(() => {}, async (request, fixture) => request.operation === 'matrixMetadata' ? (await gate, { ...metadata(fixture.classes), unsupported: request.references }) : undefined);
  // Wide enough for the details pane to show beside the page.
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  try {
  t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
  const panel = () => t.$('#context-panel');
  expect(panel().hidden).toBe(false);
  expect(panel().querySelector('[data-counts]').textContent).toBe('Open the matrix to count.');
  expect(panel().textContent).not.toMatch(/\d+ of \d+/);
  // While the matrix loads its evidence the panel waits too.
  await t.click('[data-command="matrix"]');
  t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
  expect(panel().querySelector('[data-counts]').textContent).toBe('Counting in the matrix…');
  release(); await t.tick(); await t.tick();
  // Then the panel shows the matrix's numbers: same index, same denominators.
  const { createMatrixIndex } = await import('./matrix-model');
  const { roleBandCounts, countWords } = await import('./matrix-grid.js');
  const index = createMatrixIndex(t.snapshot.model, t.snapshot.classes, t.snapshot.typeChildren, metadata(t.classes));
  const read = [...panel().querySelectorAll('.ctx-op')].find(op => op.querySelector('.ctx-op-h').textContent === 'Read');
  expect([...read.querySelectorAll('.kv b')].map(b => b.textContent)).toEqual(roleBandCounts(index, ROLE, 'Read').map(countWords));
  expect(panel().querySelector('[data-counts]')).toBeNull();
  } finally { if (width) Object.defineProperty(window, 'innerWidth', width); else delete window.innerWidth; }
});

it('says what Find in lists counts and clears it once the role page is left', async () => {
  const t = setup(({ snapshot }) => {
    snapshot.model.roles.push({ rid: '9000000000000000010', id: 'other', name: 'Other', parent: '' });
    snapshot.model.policies.push({ rid: '9000000000000000005', id: 'everyone_policy', name: 'For everyone', parent: '', enabled: true, content: { Statement: [grant('*', ['Read'])] } });
  });
  t.workspace.enter({ kind: 'role', rid: '9000000000000000010' }); await t.tick();
  t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
  // The role page lists two policies (one through Everyone); the lists find the one that names the role.
  expect(t.$('[data-role-section="what"] .rp-cnt').textContent).toMatch(/in 2 policies grant/);
  await t.click('[data-command="find-role-policies"]');
  const chip = () => t.$('#search-filter [data-command="clear-role-filter"]');
  expect(chip().textContent).toBe('Naming Risk review');
  expect(t.$('[data-tree-kind="policy"]').closest('.collection').querySelector('.collection-heading > span').textContent).toBe('1');
  // Opening a policy it found keeps the filter; another tab clears it.
  await t.click('#tree [data-open="9000000000000000004"]');
  expect(t.$('.record-name').value).toBe('Risk review access');
  expect(chip()).not.toBeNull();
  await t.click('#tabs [role="tab"][data-tab-key="role:9000000000000000010"]');
  expect(t.$('.record-name').value).toBe('Other');
  expect(chip()).toBeNull();
  expect(t.$('[data-tree-kind="policy"]').closest('.collection').querySelector('.collection-heading > span').textContent).toBe('2');
  await t.click('#tabs [role="tab"][data-tab-key="role:' + ROLE + '"]');
  expect(chip()).toBeNull();
});

it('does not keep the Find in lists filter across a reload, also one saved by an earlier version', async () => {
  const t = setup();
  t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
  await t.click('[data-command="find-role-policies"]');
  expect(t.$('#search-filter [data-command="clear-role-filter"]')).not.toBeNull();
  // The page closes: everything is written out, then mounted again from it.
  window.dispatchEvent(new Event('pagehide')); await t.tick();
  const data = t.persisted();
  const remount = saved => {
    document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    mountWorkspace({ snapshot: data.snapshot, saved, api: t.api, notice: vi.fn(), busy: () => {}, persist: async () => {} });
    return document.querySelector('#search-filter [data-command="clear-role-filter"]');
  };
  expect(remount(data)).toBeNull();
  // A state saved before the filter knew its role page (no roleFilterFrom).
  expect(remount({ ...data, state: { ...data.state, roleFilter: ROLE, roleFilterFrom: undefined } })).toBeNull();
});

it('closes the details pane below 1000 px and the lists below 760 px when the window narrows', async () => {
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const resize = async w => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: w }); window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 0)); };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  try {
    const t = setup();
    t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
    const panel = t.$('#context-panel'), lists = () => !document.body.classList.contains('no-explorer');
    expect([panel.hidden, lists()]).toEqual([false, true]);
    // 1000 px still has room for both beside the page.
    await resize(1000);
    expect([panel.hidden, lists()]).toEqual([false, true]);
    await resize(900);
    expect([panel.hidden, t.$('[data-command="context-panel"]').getAttribute('aria-expanded'), lists()]).toEqual([true, 'false', true]);
    await resize(759);
    expect([panel.hidden, lists()]).toEqual([true, false]);
    // Wide again: the pane is back beside the page.
    await resize(1280);
    expect(panel.hidden).toBe(false);
  } finally { if (width) Object.defineProperty(window, 'innerWidth', width); else delete window.innerWidth; document.body.classList.remove('no-explorer'); }
});

it('the details-pane and lists buttons toggle their pane at every width', async () => {
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const at = w => Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  try {
    for (const w of [1280, 980, 740]) {
      at(w);
      const t = setup();
      t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
      const panel = t.$('#context-panel'), button = t.$('.context-toggle[data-command="context-panel"]');
      const pane = () => [panel.hidden, button.getAttribute('aria-expanded')];
      // Inline beside the page from 1000 px: open by default. Below: a closed drawer.
      const first = w >= 1000 ? [false, 'true'] : [true, 'false'];
      const flipped = w >= 1000 ? [true, 'false'] : [false, 'true'];
      expect(pane(), `${w} px start`).toEqual(first);
      await t.click('.context-toggle[data-command="context-panel"]');
      expect(pane(), `${w} px after one click`).toEqual(flipped);
      if (!panel.hidden) expect(panel.textContent).toContain('Can do');
      await t.click('.context-toggle[data-command="context-panel"]');
      expect(pane(), `${w} px after two clicks`).toEqual(first);
      // The lists: docked from 760 px, a closed drawer below.
      const lists = () => !document.body.classList.contains('no-explorer');
      const listsFirst = w >= 760;
      expect(lists(), `${w} px lists start`).toBe(listsFirst);
      await t.click('.sidebar-toggle[data-command="explorer"]');
      expect(lists(), `${w} px lists after one click`).toBe(!listsFirst);
      await t.click('.sidebar-toggle[data-command="explorer"]');
      expect(lists(), `${w} px lists after two clicks`).toBe(listsFirst);
      t.workspace.destroy?.();
      document.body.classList.remove('no-explorer');
    }
  } finally { if (width) Object.defineProperty(window, 'innerWidth', width); else delete window.innerWidth; document.body.classList.remove('no-explorer'); }
});

const VIEWERS = '9000000000000000907';
const withViewers = ({ snapshot, classes }) => {
  classes.CeRiskAssessment.push({ rid: VIEWERS, accessor: 'viewers', label: 'Viewers', reference: true, principal: true, configClass: 'ReferenceMethodConfig', targets: '[User]' });
  snapshot.model.scope[0].referenceConfig = '9000000000000000901';
};
const pickField = async ({ $, tick, click }, label) => {
  await click('.rp-as-line .rp-tok[aria-label^="Field"]');
  const find = () => [...document.querySelectorAll('#picker-results button')].find(b => b.querySelector('strong')?.textContent === label);
  await vi.waitFor(() => expect(find()).toBeTruthy());
  find().click(); await tick();
  expect($('.rp-as-line .rp-tok[aria-label^="Field"]').getAttribute('aria-label')).toBe('Field: ' + label);
};

it('carries the new field\'s definition RID in the draft when the sentence changes an assignment\'s field, and reviews it old RID to new', async () => {
  const t = setup(withViewers);
  t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
  await pickField(t, 'Viewers');
  const draft = t.stored().scope.find(r => r.rid === '9000000000000000002');
  expect(draft).toMatchObject({ kind: 'RoleAssignment', source: 'CeRiskAssessment', field: 'viewers', referenceConfig: VIEWERS });
  // The save writes the same RID, resolved from the live schema.
  const { buildApplyCode } = await import('../lib/access-workspace/write');
  expect(buildApplyCode(t.snapshot.model, t.stored(), { ...t.snapshot, classes: { CeRiskAssessment: t.classes.CeRiskAssessment } })).toContain(`referenceConfig := lookup(${VIEWERS})`);
  await t.click('.rp-pending [data-command="review"]');
  const item = t.$$('.review-item').find(a => a.dataset.reviewRid === '9000000000000000002');
  // One difference names both fields; each RID is secondary text next to its name, never bare.
  expect(item.querySelector('.rv-diffs').textContent).toBe('Changed the field from owners to viewers.');
  // Where it goes, then a title in plain words: the role and the field of its type, no internal property names.
  expect(item.querySelector('.rv-target').textContent).toBe('Saves to Interaction QA · field assignment of role Risk review');
  expect(item.querySelector('.rvh b').textContent).toBe('Risk review · field viewers of CeRiskAssessment');
  expect(item.textContent).not.toMatch(/referenceConfig|Reference field|Saved to/);
  const deltas = [...item.querySelectorAll('.rv-delta')].map(row => [row.querySelector('.rv-field').textContent, ...[...row.querySelectorAll('.rv-v')].map(v => [v.firstElementChild.textContent, v.querySelector('small').textContent])]);
  expect(deltas).toEqual([['Field', ['owners', 'RID 9000000000000000901'], ['viewers', 'RID ' + VIEWERS]]]);
  // The field name is a column of its own, never the label inside the Before box.
  expect([...item.querySelectorAll('.rv-delta > .rv-field + .ba > .bf > span:first-child')].map(s => s.textContent)).toEqual(['Before', 'After']);
});

it('drops the change again when the assignment\'s field is set back to the saved one', async () => {
  const t = setup(withViewers);
  t.workspace.enter({ kind: 'role', rid: ROLE }); await t.tick();
  await pickField(t, 'Viewers');
  await pickField(t, 'Risk owners');
  expect(t.stored().scope.find(r => r.rid === '9000000000000000002').referenceConfig).toBe('9000000000000000901');
  expect(t.$('.rp-pending')).toBeNull();
});
