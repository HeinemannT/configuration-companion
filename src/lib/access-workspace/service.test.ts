import { beforeEach, expect, it, vi } from 'vitest';
import type { BmpClient } from '../bmp-client';
import { writeResult } from './test-response';
import { emptyModel, type AccessSnapshot } from './model';
import { handleAccessRequest, recoveryKey } from './service';

const mocks = vi.hoisted(() => ({ read: vi.fn(), schema: vi.fn(), principals: vi.fn() }));
vi.mock('./read', async original => ({ ...await original<typeof import('./read')>(), readAccess: mocks.read, readSchema: mocks.schema, readAccessPrincipals: mocks.principals }));
const journals = vi.hoisted(() => new Map());
vi.mock('./journal', () => ({ readJournal: vi.fn(async id => journals.get(id)), writeJournal: vi.fn(async value => journals.set(value.id, structuredClone(value))), removeJournal: vi.fn(async id => journals.delete(id)) }));
const environment = 'test@https://example.test/';
const storage: Record<string, unknown> = {};
const snapshot = (): AccessSnapshot => ({ environment, name: 'Test', loadedAt: '', roots: { roles: '1', policies: '2' }, model: { ...emptyModel(), roles: [{ rid: '3', id: 'role', name: 'Role', parent: '' }] }, classes: {}, users: [], groups: [] });
beforeEach(() => {
  vi.clearAllMocks(); journals.clear(); for (const key of Object.keys(storage)) delete storage[key];
  mocks.principals.mockResolvedValue({ choices: [], memberships: [] });
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async () => ({ ...storage })),
    set: vi.fn(async value => { Object.assign(storage, value); }),
    remove: vi.fn(async key => { delete storage[key]; }),
  } } });
});

it('preserves fresh memberships when assigning a user absent from the original inventory', async () => {
  const { live, client, executeEc } = setup();
  live.model.roles.push({ rid: '4', id: 'other', name: 'Other', parent: '' });
  const baseline = structuredClone(live.model), draft = structuredClone(baseline);
  const newMembership = { rid: 'draft:membership', id: '', name: '', parent: '3', subject: '9000000000000000001', mode: 'User' };
  draft.globals.push(newMembership);
  const existing = { ...newMembership, rid: 'global:9000000000000000001:4', parent: '4' };
  mocks.principals.mockResolvedValue({ choices: [{ rid: newMembership.subject, id: 'user', name: 'User', type: 'User' }], memberships: [existing] });
  mocks.read.mockResolvedValueOnce(structuredClone(live)).mockResolvedValueOnce({ ...live, model: { ...draft, globals: [existing, { ...newMembership, rid: 'global:9000000000000000001:3' }] } });
  await handleAccessRequest(client, environment, 'Test', { operation: 'apply', baseline, draft }, () => {});
  expect(executeEc.mock.calls[1][0]).toContain('roles := LIST(lookup(4), lookup(3))');
  expect(storage[recoveryKey(environment)]).toBeTruthy();
});
function setup() {
  const live = snapshot(), draft = structuredClone(live.model); draft.roles[0].name = 'Renamed';
  const executeEc = vi.fn<BmpClient['executeEc']>(async code => writeResult(code));
  const client = { executeEc } as unknown as BmpClient;
  mocks.read.mockResolvedValue(live);
  return { live, draft, client, executeEc, request: { operation: 'apply' as const, baseline: live.model, draft } };
}

it('does not apply after logout during preview even when the profile is unchanged', async () => {
  const { client, executeEc, request } = setup();
  const auth = { sessionEpoch: 0 };
  Object.assign(client, { auth });
  executeEc.mockImplementation(async code => { auth.sessionEpoch++; return writeResult(code); });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('connection changed');
  expect(executeEc).toHaveBeenCalledTimes(1);
});
it('does not write when the connection changes during the fresh read', async () => {
  const { client, executeEc, request } = setup(); let switched = false;
  mocks.read.mockImplementation(async () => { switched = true; return snapshot(); });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => { if (switched) throw Error('Changed environment'); })).rejects.toThrow('Changed environment');
  expect(executeEc).not.toHaveBeenCalled();
});
it('refuses the commit if the connection changes during preview', async () => {
  const { client, executeEc, request } = setup(); let switched = false;
  executeEc.mockImplementation(async code => { switched = true; return writeResult(code); });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {
    if (switched) throw Error('Changed environment');
  })).rejects.toThrow('Changed environment');
  expect(executeEc.mock.calls.map(args => args[2])).toEqual([false]);
  expect(storage[recoveryKey(environment)]).toBeUndefined();
});
it('verifies an already dispatched commit against its original client after switching connection', async () => {
  const { client, executeEc, request, live, draft } = setup(); let switched = false;
  mocks.read.mockResolvedValueOnce(live).mockResolvedValueOnce({ ...live, model: draft });
  executeEc.mockImplementation(async (code, _context, commit) => {
    if (commit) switched = true;
    return writeResult(code);
  });
  const result = await handleAccessRequest(client, environment, 'Test', request, () => {
    if (switched) throw Error('Changed environment');
  });
  expect(switched).toBe(true);
  expect(executeEc.mock.calls.map(args => args[2])).toEqual([false, true]);
  expect(mocks.read.mock.calls.every(args => args[0] === client)).toBe(true);
  expect(result).toMatchObject({ snapshot: { environment, model: draft } });
  expect(storage[recoveryKey(environment)]).toBeTruthy();
});
it('does not execute a rejected preview', async () => {
  const { client, executeEc, request } = setup(); executeEc.mockResolvedValue({ ok: true, hasError: true, log: 'Invalid policy' });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('Invalid policy');
  expect(executeEc).toHaveBeenCalledTimes(1); expect(executeEc.mock.calls[0][2]).toBe(false);
  expect(storage[recoveryKey(environment)]).toBeUndefined();
});
it('records an uncertain write before sending and blocks blind retries', async () => {
  const { client, executeEc, request } = setup();
  executeEc.mockImplementationOnce(async code => writeResult(code)).mockImplementationOnce(async () => { expect(storage[recoveryKey(environment)]).toBeTruthy(); throw Error('Connection lost'); });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('Connection lost');
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('reconciliation');
  expect(executeEc).toHaveBeenCalledTimes(2);
});
it('keeps the recovery marker when readback does not match', async () => {
  const { client, request } = setup();
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('different values');
  expect(storage[recoveryKey(environment)]).toBeTruthy();
});
it('retains the receipt until the tab acknowledges verified readback', async () => {
  const { client, executeEc, request, live, draft } = setup();
  mocks.read.mockResolvedValueOnce(live).mockResolvedValueOnce({ ...live, model: draft });
  const result = await handleAccessRequest(client, environment, 'Test', request, () => {});
  expect(executeEc.mock.calls.map(args => args[2])).toEqual([false, true]);
  expect(result).toMatchObject({ snapshot: { model: draft } });
  expect(storage[recoveryKey(environment)]).toBeTruthy();
  const id = (result as { operationId: string }).operationId;
  expect(await handleAccessRequest(client, environment, 'Test', { operation: 'status', id }, () => { throw Error('Connection changed'); })).toMatchObject({ state: 'complete', result });
  await handleAccessRequest(client, environment, 'Test', { operation: 'acknowledge', id }, () => {});
  expect(storage[recoveryKey(environment)]).toBeUndefined();
  expect(journals.size).toBe(0);
});
it('rejects an empty preview before any write or recovery marker is created', async () => {
  const { client, executeEc, request } = setup(); executeEc.mockResolvedValue({ ok: true, log: '' });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('incomplete');
  expect(executeEc).toHaveBeenCalledTimes(1); expect(journals.size).toBe(0);
});
it('requires the receipt for the correct phase and retains uncertain write intent', async () => {
  const { client, executeEc, request } = setup();
  executeEc.mockImplementationOnce(async code => writeResult(code)).mockImplementationOnce(async code => writeResult(code.replace('ACCESS_APPLY_', 'ACCESS_PREVIEW_')));
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('confirm completion');
  const journal = [...journals.values()][0];
  expect(journal).toMatchObject({ phase: 'writing', submittedDraft: request.draft });
  expect(await handleAccessRequest(client, environment, 'Test', { operation: 'status', id: journal.id }, () => {})).toMatchObject({ state: 'failed', error: expect.stringContaining('interrupted during writing') });
});
it('does not let a read-only load clear an uncertain outcome', async () => {
  const { client } = setup(); storage[recoveryKey(environment)] = { at: 'test' };
  expect(await handleAccessRequest(client, environment, 'Test', { operation: 'load' }, () => {})).toMatchObject({ recoveryRequired: true });
  expect(storage[recoveryKey(environment)]).toBeTruthy();
  await handleAccessRequest(client, environment, 'Test', { operation: 'reconcile' }, () => {});
  expect(storage[recoveryKey(environment)]).toBeUndefined();
});
it('commits and verifies a retained child move before deleting its old parent', async () => {
  const { client, executeEc, live } = setup();
  live.model.roles.push({ rid: '4', id: 'child', name: 'Child', parent: '3' });
  const draft = structuredClone(live.model); draft.roles.shift(); draft.roles[0].parent = '';
  const staged = structuredClone(live); staged.model.roles[1].parent = '';
  mocks.read.mockResolvedValueOnce(live).mockResolvedValueOnce(staged).mockResolvedValueOnce({ ...live, model: draft });
  await handleAccessRequest(client, environment, 'Test', { operation: 'apply', baseline: live.model, draft }, () => {});
  expect(executeEc.mock.calls.map(args => args[2])).toEqual([false, true, true]);
  expect(executeEc.mock.calls[1][0]).not.toContain('.delete()');
  expect(executeEc.mock.calls[2][0]).toContain('lookup(3).delete()');
  expect(storage[recoveryKey(environment)]).toBeTruthy();
});
it('never deletes the old parent if the retained child move did not persist', async () => {
  const { client, executeEc, live } = setup();
  live.model.roles.push({ rid: '4', id: 'child', name: 'Child', parent: '3' });
  const draft = structuredClone(live.model); draft.roles.shift(); draft.roles[0].parent = '';
  mocks.read.mockResolvedValue(live);
  await expect(handleAccessRequest(client, environment, 'Test', { operation: 'apply', baseline: live.model, draft }, () => {})).rejects.toThrow('different values');
  expect(executeEc).toHaveBeenCalledTimes(2);
  expect(storage[recoveryKey(environment)]).toBeTruthy();
});

it('does not finish a staged apply under a new session, and retains recovery', async () => {
  const { client, executeEc, live } = setup();
  const auth = { sessionEpoch: 0 };
  Object.assign(client, { auth });
  live.model.roles.push({ rid: '4', id: 'child', name: 'Child', parent: '3' });
  const draft = structuredClone(live.model); draft.roles.shift(); draft.roles[0].parent = '';
  const staged = structuredClone(live); staged.model.roles[1].parent = '';
  mocks.read.mockResolvedValueOnce(live).mockImplementationOnce(async () => { auth.sessionEpoch++; return staged; });
  await expect(handleAccessRequest(client, environment, 'Test', { operation: 'apply', baseline: live.model, draft }, () => {})).rejects.toThrow('connection changed');
  expect(executeEc.mock.calls.map(args => args[2])).toEqual([false, true]);
  expect(storage[recoveryKey(environment)]).toBeTruthy();
});

it('retains reconciliation when the session changes after commit during final verification', async () => {
  const { client, executeEc, request, live, draft } = setup();
  const auth = { sessionEpoch: 0 };
  Object.assign(client, { auth });
  mocks.read.mockResolvedValueOnce(live).mockImplementationOnce(async () => {
    auth.sessionEpoch++;
    return { ...live, model: draft };
  });
  await expect(handleAccessRequest(client, environment, 'Test', request, () => {})).rejects.toThrow('connection changed');
  expect(executeEc.mock.calls.map(args => args[2])).toEqual([false, true]);
  expect(storage[recoveryKey(environment)]).toBeTruthy();
  expect([...journals.values()].some(journal => journal.phase === 'complete')).toBe(false);
});
