// @vitest-environment happy-dom
// Add statement on a role page: choose a policy, get a statement for this role
// in its editor, and find it listed as unsaved back on the role page.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

const ROLE = '9000000000000000001';
function setup() {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  fixture.snapshot.model.policies.push({ rid: '9000000000000000005', id: 'shared_reading', name: 'Shared reading', parent: '', enabled: true,
    content: { Version: '1.0', Statement: [{ Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [] } }] } });
  let saved;
  const api = vi.fn(async request => request.operation === 'schema' ? fixture.classes[request.type] || [] : []);
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice: vi.fn(), busy: () => {}, persist: async read => { saved = read(); } });
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async s => { await vi.waitFor(() => expect($(s), s).not.toBeNull()); $(s).click(); await tick(); };
  return { workspace, $, $$, tick, click, stored: () => saved.model, state: () => saved.state };
}
const options = $$ => $$('#picker .picker-option').map(o => o.querySelector('strong').textContent);

it('adds a statement for the role to a chosen policy, opens it there, and lists it as unsaved on the role page', async () => {
  const { workspace, $, $$, tick, click, stored } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  const roleRoute = window.history.state;
  expect($('[data-command="new-policy-for-role"]')).toBeNull();
  expect($('[data-role-section="what"] [data-command="add-statement-for-role"]').textContent).toBe('Add statement');
  await click('[data-command="add-statement-for-role"]');
  expect($$('#picker .picker-group').map(g => g.textContent)).toEqual(['Naming this role', 'All policies', 'New']);
  expect(options($$)).toEqual(['Risk review access', 'Shared reading', 'New policy…']);
  $$('#picker .picker-option')[1].click(); await tick();

  const policy = stored().policies.find(p => p.id === 'shared_reading');
  expect(policy.content.Statement).toHaveLength(2);
  expect(policy.content.Statement[1]).toEqual({ Subject: ['role:risk_review'], Effect: 'Allow', Action: [], Resource: { All: [] } });
  // The policy editor is open at the new statement, with Who set to the role.
  expect($('.record-name').value).toBe('Shared reading');
  expect($('.st.sel').dataset.statementRow).toBe('1');
  expect($('.subject-chips').textContent).toContain('Risk review');

  // Back on the role page the statement is listed under Naming this role, marked unsaved.
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: roleRoute })); await tick();
  const row = $$('.gt-st').find(r => r.dataset.grantRow === '9000000000000000005:1');
  expect(row.dataset.grantOf).toBe('own');
  expect(row.querySelector('.gt-unsaved')).not.toBeNull();
  expect($$('.gt-group .gt-title')[0].textContent).toBe('Naming this role');
});

it('says the new statement grants nothing yet in its summary line, Reads as and the review', async () => {
  const { workspace, $, $$, tick, click } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  await click('[data-command="add-statement-for-role"]');
  $$('#picker .picker-option')[1].click(); await tick();
  const row = $('.st.sel .st-main');
  expect(row.querySelector('.res').textContent).toBe('Grants nothing yet: no action is ticked.');
  expect(row.querySelector('.ops')).toBeNull();
  expect($('#context-panel .qt.big').textContent).toBe('Grants nothing yet: no action is ticked.');
  await click('[data-command="review"]');
  const can = $$('.rv .rv-delta').find(d => d.dataset.part === 'Can');
  expect(can.querySelector('.rv-v').textContent).toBe('Grants nothing yetno action is ticked');
  expect(document.body.textContent).not.toContain('no operation');
});

it('offers New policy, which starts the policy with a statement for the role', async () => {
  const { workspace, $, $$, tick, click } = setup();
  workspace.enter({ kind: 'role', rid: ROLE }); await tick();
  await click('[data-command="add-statement-for-role"]');
  $$('#picker .picker-option').at(-1).click(); await tick();
  expect($('#dialog').open).toBe(true);
  expect($('#dialog h2').textContent).toBe('New policy');
});
