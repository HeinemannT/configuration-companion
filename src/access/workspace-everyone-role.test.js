// @vitest-environment happy-dom
// The Everyone role page: every user holds it, there is nobody to add, and its
// grants read as one group.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

const EVERYONE = '9000000000000000010';
function setup() {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  fixture.snapshot.model.roles.push({ rid: EVERYONE, id: 'roleEveryone', name: 'Everyone', parent: '' });
  fixture.snapshot.model.policies.push({ rid: '9000000000000000011', id: 'basics', name: 'Basics', parent: '', enabled: true, content: { Version: '1.0', Statement: [
    { Effect: 'Allow', Subject: ['role:roleEveryone'], Action: ['Create'], Resource: { All: [] } },
    { Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [] } }] } });
  const api = vi.fn(async request => request.operation === 'schema' ? fixture.classes[request.type] || [] : []);
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice: vi.fn(), busy: () => {}, persist: async () => {} });
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  return { workspace, $, $$, tick };
}

it('says every user holds the Everyone role, offers no holders to add, and shows one group of grants', async () => {
  const { workspace, $, $$, tick } = setup();
  workspace.enter({ kind: 'role', rid: EVERYONE }); await tick();
  expect($('.rp-summary').textContent).toMatch(/^Every user holds this role\./);
  expect(document.body.textContent).not.toContain('No one holds this role');
  const who = $('[data-role-section="who"]');
  expect(who.textContent).toContain('Every user holds this role. It needs no field assignment and no user or group.');
  expect(who.querySelector('[data-command="add-assignment"], [data-command="add-global"]')).toBeNull();
  expect(who.textContent).not.toContain('Directly');
  expect($$('.gt-group .gt-title').map(t => t.textContent)).toEqual(['Granted to every user']);
  expect($$('.gt-st').map(r => r.dataset.grantRow)).toEqual(['9000000000000000011:0', '9000000000000000011:1']);
  expect($('.gt-group').textContent).not.toContain('Read-only');
});

it('keeps the holder actions on an ordinary role', async () => {
  const { workspace, $, tick } = setup();
  workspace.enter({ kind: 'role', rid: '9000000000000000001' }); await tick();
  expect($('[data-role-section="who"] [data-command="add-assignment"]')).not.toBeNull();
  expect($('[data-role-section="who"] [data-command="add-global"]')).not.toBeNull();
});
