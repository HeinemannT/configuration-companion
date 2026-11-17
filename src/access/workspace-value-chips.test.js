// @vitest-environment happy-dom
// Condition value lists in the policy editor: readable chips, a typed value that
// matches a known one keeps its stored form, an unknown one is not marked.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

const TYPE = { Condition: { Left: 'resource.Type', Comparison: 'ContainsAny', Right: ['ListPropertySetItem:type_risk'] } };
function setup() {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  const policies = fixture.snapshot.model.policies;
  policies[0].content.Statement[0].Resource = { All: [TYPE] };
  policies.push({ rid: '9000000000000000005', id: 'process_reading', name: 'Process reading', parent: '', enabled: true, content: { Version: '1.0', Statement: [
    { Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [{ Condition: { ...TYPE.Condition, Right: ['ListPropertySetItem:type_process'] } }] } }] } });
  let saved;
  const api = vi.fn(async request => request.operation === 'schema' ? fixture.classes[request.type] || [] : []);
  const notice = vi.fn();
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice, busy: () => {}, persist: async read => { saved = read(); } });
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  return { workspace, $, $$, tick, notice, policy: policies[0], stored: () => saved.model };
}
const enter = async (input, text, tick) => {
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
};

it('adds a known value in its stored form and does not mark a value outside the saved ones', async () => {
  const { workspace, $, $$, tick, policy, stored } = setup();
  workspace.enter({ kind: 'policy', rid: policy.rid, statement: 0 }); await tick();
  await vi.waitFor(() => expect($('.value-chips input.value-add')).not.toBeNull());
  expect($$('.value-chips .chip.val .nm').map(n => n.textContent)).toEqual(['type_risk']);
  expect($('.value-chips').textContent).not.toContain('ListPropertySetItem');

  await enter($('.value-chips input.value-add'), 'type_process', tick);
  const right = () => stored().policies[0].content.Statement[0].Resource.All[0].Condition.Right;
  expect(right()).toEqual(['ListPropertySetItem:type_risk', 'ListPropertySetItem:type_process']);
  expect($$('.value-chips .chip.val.missing')).toHaveLength(0);

  await enter($('.value-chips input.value-add'), 'type_pro', tick);
  expect(right().at(-1)).toBe('type_pro');
  // Saved values are not a list of valid values: an unsaved one is not marked.
  expect($$('.value-chips .chip.val.missing')).toHaveLength(0);
  expect($('#status, .statusbar').textContent).toContain('Added a condition value');
  expect($('#status, .statusbar').textContent).not.toContain('not found');
});

it('opens the known values from the button beside a free-text box and adds the chosen one in its stored form', async () => {
  const { workspace, $, $$, tick, notice, policy, stored } = setup();
  workspace.enter({ kind: 'policy', rid: policy.rid, statement: 0 }); await tick();
  await vi.waitFor(() => expect($('.value-chips [data-command="value-suggest"]')).not.toBeNull());
  // The box keeps its own list for typed suggestions; the generic reference combo leaves it alone.
  const box = $('.value-chips input.value-add');
  expect([...document.querySelectorAll(`#${box.getAttribute('list')} option`)].map(o => o.value)).toEqual(['type_process']);
  expect($('.value-chips .reference-combo')).toBeNull();

  $('.value-chips [data-command="value-suggest"]').click(); await tick();
  expect(notice).not.toHaveBeenCalled();
  expect($$('#picker .picker-option strong').map(o => o.textContent)).toEqual(['type_process']);
  $$('#picker .picker-option')[0].click(); await tick();
  expect(stored().policies[0].content.Statement[0].Resource.All[0].Condition.Right).toEqual(['ListPropertySetItem:type_risk', 'ListPropertySetItem:type_process']);
  expect(notice).not.toHaveBeenCalled();
});

it('does nothing but say so when a condition command reaches a control without its path', async () => {
  const { workspace, $, tick, notice, policy } = setup();
  workspace.enter({ kind: 'policy', rid: policy.rid, statement: 0 }); await tick();
  await vi.waitFor(() => expect($('.value-chips')).not.toBeNull());
  for (const command of ['value-suggest', 'value-remove', 'schema-value', 'remove-condition']) {
    const stray = document.createElement('button');
    stray.dataset.command = command;
    $('.value-chips').append(stray);
    stray.click(); await tick();
    expect($('#status, .statusbar').textContent, command).toContain('This control has lost its condition');
    stray.remove();
  }
  expect(notice).not.toHaveBeenCalled();
});
