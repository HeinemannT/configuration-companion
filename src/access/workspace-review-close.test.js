// @vitest-environment happy-dom
// Pending edits close by themselves once nothing is pending (Discard all,
// discarding the last change, saving), and the record tab the user came
// from is active and focused again. Opened by hand with nothing pending,
// the empty review stays.
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

function setup({ applyFails = false } = {}) {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const fixture = clarityFixture();
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return fixture.classes[request.type] || [];
    if (request.operation === 'apply' && applyFails) throw new Error('BMP rejected the change');
    if (request.operation === 'apply') return { snapshot: { ...fixture.snapshot, model: structuredClone(request.draft) }, mapping: {} };
    return [];
  });
  const workspace = mountWorkspace({ snapshot: fixture.snapshot, api, notice: vi.fn(), busy: () => {}, persist: async () => {} });
  const $ = selector => document.querySelector(selector);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await workspace.flush(); };
  const click = async selector => { await vi.waitFor(() => expect($(selector), selector).not.toBeNull()); $(selector).click(); await tick(); };
  const confirm = async () => { $('#dialog-form').dispatchEvent(new Event('submit', { cancelable: true })); await tick(); await tick(); };
  return { ...fixture, $, tick, click, confirm };
}

async function editAndReview(t) {
  const policy = t.snapshot.model.policies[0];
  await t.click(`[data-open="${policy.rid}"]`);
  await t.click('[data-view="rules"]');
  await t.click('[data-action="Update"]');
  await t.click('[data-command="review"]');
  expect(t.$('#tabs .review-tab [aria-selected="true"]')).not.toBeNull();
  return policy;
}

it('Discard all closes Pending edits and returns to the record tab, focused', async () => {
  const t = setup();
  const policy = await editAndReview(t);
  await t.click('.review-actions [data-command="discard-all"]');
  await t.confirm();
  expect(t.$('#tabs .review-tab')).toBeNull();
  expect(t.$('.review-page')).toBeNull();
  const active = t.$('#tabs [role="tab"][aria-selected="true"]');
  expect(active?.dataset.tabKey).toBe(`policy:${policy.rid}`);
  expect(document.activeElement).toBe(active);
});

it('saving the last change closes it as well', async () => {
  const t = setup();
  const policy = await editAndReview(t);
  await t.click('[data-command="apply-workspace"]');
  await t.tick();
  expect(t.$('#tabs .review-tab')).toBeNull();
  expect(t.$('#tabs [role="tab"][aria-selected="true"]')?.dataset.tabKey).toBe(`policy:${policy.rid}`);
});

it('a failed save keeps Pending edits open with its changes', async () => {
  const t = setup({ applyFails: true });
  await editAndReview(t);
  await t.click('[data-command="apply-workspace"]');
  await t.tick();
  expect(t.$('#tabs .review-tab [aria-selected="true"]')).not.toBeNull();
  expect(t.$('.review-title').textContent).toContain('Review 1 unsaved change');
});

it('opened by hand with nothing pending, the empty review stays', async () => {
  const t = setup();
  // Ctrl+S opens Pending edits even when nothing is pending.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await t.tick();
  expect(t.$('#tabs .review-tab [aria-selected="true"]')).not.toBeNull();
  expect(t.$('.review-intro').textContent).toContain('No unsaved changes. Everything matches the saved configuration.');
  await t.tick();
  expect(t.$('#tabs .review-tab')).not.toBeNull();
});
