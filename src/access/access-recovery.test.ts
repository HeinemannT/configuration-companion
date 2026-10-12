// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { emptyModel, type AccessSnapshot } from '../lib/access-workspace/model';
import type { SavedWorkspace } from './workspace.js';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), api: vi.fn(), mount: vi.fn() }));
vi.mock('./storage', () => ({ loadDraft: mocks.load, saveDraft: mocks.save, openDraftStore: vi.fn() }));
vi.mock('./api', () => ({ createAccessApi: () => mocks.api }));
vi.mock('./persistence', () => ({ createWorkspacePersistence: () => ({ persist: vi.fn(), pending: false }) }));
vi.mock('./workspace.js', () => ({ mountWorkspace: mocks.mount }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  document.body.innerHTML = '<div id="connection-banner"></div><div id="access-busy"></div><div class="workspace"></div>';
  window.history.replaceState(null, '', '?environment=demo');
  vi.stubGlobal('chrome', { tabs: { getCurrent: vi.fn().mockResolvedValue({ id: 1 }) }, runtime: { onMessage: { addListener: vi.fn() } } });
  mocks.mount.mockReturnValue({ enter: vi.fn(), focusArrival: vi.fn(), flush: vi.fn(), hasDraft: () => false });
});

function fixture() {
  const model = emptyModel();
  model.roles.push({ rid: 'draft:role', id: 'reviewer', name: 'Reviewer', parent: '' });
  const snapshot: AccessSnapshot = { environment: 'demo', name: 'Demo', loadedAt: '', model: emptyModel(),
    roots: { roles: '1', policies: '2' }, classes: {}, users: [], groups: [] };
  const saved: SavedWorkspace = { version: 1, snapshot, model, baseline: emptyModel(), state: {
    rid: 'draft:role', tests: { $map: [['role:draft:role:0', { mode: 'role', subject: 'draft:role', resource: '9007199254740993', result: { running: true } }]] },
    testOpen: { $set: ['role:draft:role:0'] } } };
  const verified = structuredClone(model); verified.roles[0].rid = '9007199254740994';
  const receipt = { draft: structuredClone(model), snapshot: { ...snapshot, model: verified },
    mapping: { 'draft:role': '9007199254740994' }, operationId: 'receipt-1' };
  mocks.load.mockResolvedValue(saved);
  mocks.api.mockResolvedValue({ snapshot: receipt.snapshot, receipt });
  return { saved, receipt };
}

it('saves recovered test state durably before acknowledging the completed write', async () => {
  fixture();
  let commit!: () => void;
  mocks.save.mockImplementation(() => new Promise<void>(resolve => { commit = resolve; }));
  await import('./access');
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.api.mock.calls.map(([request]) => request.operation)).toEqual(['load']);
  expect(mocks.mount).not.toHaveBeenCalled();
  const recovered = mocks.save.mock.calls[0][1];
  expect(recovered.state.testOpen.$set).toEqual(['role:9007199254740994:0']);
  expect(recovered.state.tests.$map[0][1]).toMatchObject({ subject: '9007199254740994', resource: '9007199254740993', result: null, rerunRequired: true });
  commit();
  await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce());
  expect(mocks.api).toHaveBeenLastCalledWith({ operation: 'acknowledge', id: 'receipt-1' });
  expect(mocks.mount.mock.calls[0][0].saved).toEqual(recovered);
});

it('keeps the original draft and the recovery receipt when durable saving fails', async () => {
  const { saved } = fixture();
  mocks.save.mockRejectedValue(Error('Disk full'));
  await import('./access');
  await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce());
  expect(mocks.api.mock.calls.map(([request]) => request.operation)).toEqual(['load']);
  expect(mocks.mount.mock.calls[0][0].saved).toBe(saved);
  expect(document.querySelector('#connection-banner')?.textContent).toContain('Disk full');
});

it('does not acknowledge or overwrite a newer local draft', async () => {
  const { saved } = fixture(); saved.model.roles[0].name = 'Newer edit';
  await import('./access');
  await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce());
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.api.mock.calls.map(([request]) => request.operation)).toEqual(['load']);
  expect(mocks.mount.mock.calls[0][0].saved).toBe(saved);
  expect(document.querySelector('#connection-banner')?.textContent).toContain('local draft differs');
});
