// @vitest-environment happy-dom
// The redesigned Access workspace: statement rows, conditions, context panel,
// review, role page, blocked Rules and the saved-policies test banner.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

function setup(adjust = () => {}) {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  adjust(fixture);
  let saved;
  const api = vi.fn(async request => {
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
  return { ...fixture, api, workspace, $, $$, tick, click, key, stored: () => saved.model };
}

it('shows statements one per line, expands one in place, and reorders, duplicates and removes by keyboard', async () => {
  const { snapshot, $, $$, click, key, stored } = setup(({ snapshot }) => {
    snapshot.model.policies[0].content.Statement[1].Action = ['Delete'];
  });
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  expect($$('.st-main')).toHaveLength(2);
  expect($$('.st-main')[0].textContent).toContain('Allow');
  expect($$('.st-main')[0].getAttribute('aria-label')).toBe('Statement 1: Risk review may Read objects of type: CeRiskAssessment, when 1 more condition holds.');
  expect($$('.xp')).toHaveLength(1);
  expect($('.ui-band.st-band').textContent).toContain('Without a grant there is no access.');
  expect($('.ui-band.st-band').textContent).not.toContain('Deny');
  await click('[data-command="select-statement"][data-index="1"]');
  expect($('.st.sel .n').textContent).toBe('2');
  expect($('#st-detail .effect-value').textContent).toBe('Deny');
  expect($('#st-detail [data-command="rule-effect"]')).toBeNull();
  // Alt+Up moves the focused statement; the row mark shows it differs from the saved copy.
  await key($('.st-main[data-index="1"]'), { key: 'ArrowUp', altKey: true });
  expect(stored().policies[0].content.Statement.map(s => s.Effect)).toEqual(['Deny', 'Allow']);
  expect(document.activeElement.dataset.index).toBe('0');
  expect($$('.st .dmark')).toHaveLength(1); // one statement moved; the other keeps its relative order
  expect($('#pending-review').hidden).toBe(false);
  expect($('#pending-review').textContent).toContain('1 unsaved change');
  await key(document.activeElement, { key: 'd', ctrlKey: true });
  expect(stored().policies[0].content.Statement).toHaveLength(3);
  await key($('.st-main[data-index="2"]'), { key: 'Delete' });
  expect(stored().policies[0].content.Statement).toHaveLength(2);
  await click('[data-command="statements-collapse"]');
  expect($$('.xp')).toHaveLength(0);
});

it('never offers Deny for a new statement and removes a stored Deny as an ordinary unsaved edit', async () => {
  const { snapshot, $, $$, click, stored } = setup();
  const policy = snapshot.model.policies[0];
  await click(`[data-open="${policy.rid}"]`);
  await click('[data-view="rules"]');
  await click('[data-command="add-statement"]');
  expect(stored().policies[0].content.Statement[2].Effect).toBe('Allow');
  // Allow is the only effect: plain text, no one-option selector and no Deny anywhere.
  expect($('#st-detail .effect-value').textContent).toBe('Allow');
  expect($('#st-detail [data-command="rule-effect"], #st-detail .rule-effect, #st-detail select')).toBeNull();
  expect($('[data-effect="Deny"]')).toBeNull();
  expect($('#st-detail').textContent).not.toContain('Deny');
  // The stored Deny keeps its note and the one action it offers.
  const notes = $$('.st-ignored');
  expect(notes).toHaveLength(1);
  expect(notes[0].closest('.st-item').querySelector('[data-statement-row]').dataset.statementRow).toBe('1');
  await click('.st-ignored [data-command="statement-delete"]');
  expect(stored().policies[0].content.Statement.map(s => s.Effect)).toEqual(['Allow', 'Allow']);
  expect($$('.st-ignored')).toHaveLength(0);
  expect($('#pending-review').hidden).toBe(false);
});
