/**
 * The four Studio write handlers (add, save, delete a data input; host a
 * resource) with a fake client: what they send, what they refuse, and how
 * they answer when the write's answer is lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { EcResult } from '../bmp-client';

vi.mock('../cvo-studio', () => ({ openStudioWindow: vi.fn(async () => {}) }));

const FIELD = '\u0001';
const ROW = '\u0002';

async function harness(execute: (code: string, rid?: string, transactional?: boolean) => Promise<EcResult>) {
  vi.resetModules();
  mockChromeStorage();
  const executeEc = vi.fn(execute);
  const ctx: any = {
    client: { serverUrl: 'https://bmp.example/Steadfast/', executeEc },
    cache: { get: vi.fn(() => null) },
    logActivity: vi.fn(),
    settings: { activeProfileId: 'current' },
  };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  const { environmentToken } = await import('../environment');
  setSwContext(ctx);
  await import('../handlers/studio');
  // Every write names the server it was read from (the window's token).
  const environment = environmentToken(ctx);
  const call = async (msg: Record<string, unknown>) => {
    const respond = vi.fn();
    await getHandler(msg.type as string)!({ environment, ...msg } as any, respond, { isOneShot: true } as any);
    return respond.mock.calls[0]?.[0];
  };
  return { call, executeEc, ctx };
}

const row = (c: Record<string, string>) => [c.rid, c.id, c.className, c.key, c.expression ?? '', c.table ?? '', c.url ?? '', c.urlParameters ?? '', c.headers ?? '', c.timeout ?? ''].join(FIELD) + ROW;
const STALE_ENV = 'other@https://bmp.example/Steadfast/';
const OTHER_SERVER = expect.stringContaining('another server');

describe('STUDIO_ADD_CHILD', () => {
  it('sends one transactional add with sanitised ids and returns the new RID as a string', async () => {
    const h = await harness(async () => ({ ok: true, log: 'changes…\nRID=9007199254740993' }));
    const res = await h.call({ type: 'STUDIO_ADD_CHILD', cvoBid: 'cvo"1', childId: 'cve_x"; delete()', key: 'input_1', childType: 'expression' });
    expect(res).toEqual({ type: 'STUDIO_CHILD_ADDED', ok: true, rid: '9007199254740993' });
    const [code, rid, transactional] = h.executeEc.mock.calls[0];
    expect(transactional).toBe(true);
    expect(rid).toBeUndefined();
    expect(code).toBe([
      '_r := SELECT CustomVisualization WHERE id = "cvo1"',
      '_c := _r.first()',
      "_n := _c.add(CustomVisualizationExpression, id := 'cve_xdelete', key := 'input_1')",
      "_n.change(key := 'input_1')",
      'output("RID=" + str(_n.rid))',
    ].join('\n'));
  });

  it('refuses another server before any request', async () => {
    const h = await harness(async () => ({ ok: true }));
    const res = await h.call({ type: 'STUDIO_ADD_CHILD', cvoBid: 'c', childId: 'x', key: 'k', childType: 'table', environment: STALE_ENV });
    expect(res).toEqual({ type: 'STUDIO_CHILD_ADDED', ok: false, error: OTHER_SERVER });
    expect(h.executeEc).not.toHaveBeenCalled();
  });

  it('a lost answer is reported as outcome unknown, not a plain failure', async () => {
    const h = await harness(async () => ({ ok: false, error: 'timed out', errorKind: 'timeout', outcomeUnknown: true }));
    const res = await h.call({ type: 'STUDIO_ADD_CHILD', cvoBid: 'c', childId: 'x', key: 'k', childType: 'table' });
    expect(res).toEqual({ type: 'STUDIO_CHILD_ADDED', ok: false, error: 'timed out', outcomeUnknown: true });
  });
});

describe('STUDIO_SAVE_CHILD', () => {
  const base = { type: 'STUDIO_SAVE_CHILD', childId: 'csc_1', childType: 'connection', key: 'feed' };

  it('writes the same script as before for valid fields', async () => {
    const h = await harness(async () => ({ ok: true, log: 'ok' }));
    const res = await h.call({ ...base, fields: { url: 'https://x/"y', urlParameters: 'a=b', headers: 'H: v', timeout: '30000' } });
    expect(res).toEqual({ type: 'STUDIO_CHILD_SAVED', ok: true, error: undefined });
    expect(h.executeEc.mock.calls[0][0]).toBe([
      '_r := SELECT CustomVisualizationServerConnection WHERE id = "csc_1"',
      '_o := _r.first()',
      '_o.change(key := "feed")',
      '_o.change(url := "https://x/\\"y")',
      '_o.change(urlParameters := "a=b")',
      '_o.change(headers := "H: v")',
      '_o.change(timeout := 30000)',
      'output("ok")',
    ].join('\n'));
    expect(h.executeEc.mock.calls[0][2]).toBe(true);
  });

  it('names a rejected field instead of answering ok: timeout that is not a whole number', async () => {
    const h = await harness(async () => ({ ok: true }));
    const res = await h.call({ ...base, fields: { timeout: '30s' } });
    expect(res).toEqual({
      type: 'STUDIO_CHILD_SAVED', ok: false, notSent: true, field: 'timeout',
      error: 'Timeout must be a whole number of milliseconds, for example 30000. Nothing was saved.',
    });
    expect(h.executeEc).not.toHaveBeenCalled();
  });

  it('names a rejected field: a cleared table reference, and a field of another input type', async () => {
    const h = await harness(async () => ({ ok: true }));
    expect(await h.call({ ...base, childType: 'table', fields: { table: '' } })).toMatchObject({ ok: false, field: 'table', notSent: true });
    expect(await h.call({ ...base, childType: 'expression', fields: { url: 'x' } })).toMatchObject({ ok: false, field: 'url', notSent: true });
    expect(h.executeEc).not.toHaveBeenCalled();
  });

  it('with expect: unchanged inputs are written after one read', async () => {
    const h = await harness(async (_code, _rid, tx) => (tx ? { ok: true, log: 'ok' }
      : { ok: true, log: row({ rid: '1', id: 'csc_1', className: 'CustomVisualizationServerConnection', key: 'feed', url: 'u', timeout: '100' }) }));
    const res = await h.call({ ...base, cvoBid: 'cvo1', fields: { url: 'u2' }, expect: { key: 'feed', url: 'u' } });
    expect(res).toMatchObject({ ok: true });
    expect(h.executeEc).toHaveBeenCalledTimes(2);
    expect(h.executeEc.mock.calls[0][2]).toBeUndefined(); // the check is a read
  });

  it('with expect: a value changed in BMP is refused with the change, nothing written', async () => {
    const h = await harness(async () => ({ ok: true, log: row({ rid: '1', id: 'csc_1', className: 'CustomVisualizationServerConnection', key: 'feed', url: 'changed' }) }));
    const res = await h.call({ ...base, cvoBid: 'cvo1', fields: { url: 'mine' }, expect: { key: 'feed', url: 'u' } });
    expect(res).toEqual({
      type: 'STUDIO_CHILD_SAVED', ok: false, notSent: true,
      conflict: [{ prop: 'url', opened: 'u', current: 'changed' }],
      error: 'The input changed in BMP since you opened it. Nothing was saved.',
    });
    expect(h.executeEc).toHaveBeenCalledTimes(1);
  });

  it('with expect: the check cannot read: refused with checkFailed', async () => {
    const h = await harness(async () => ({ ok: false, error: 'EC error' }));
    const res = await h.call({ ...base, cvoBid: 'cvo1', fields: { url: 'mine' }, expect: { key: 'feed' } });
    expect(res).toMatchObject({ ok: false, notSent: true, checkFailed: true, error: 'Could not check whether it changed in BMP since you opened it: EC error' });
  });

  it('a lost answer is reported as outcome unknown', async () => {
    const h = await harness(async () => ({ ok: false, error: 'timed out', outcomeUnknown: true }));
    expect(await h.call({ ...base, fields: { url: 'x' } })).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it('refuses another server', async () => {
    const h = await harness(async () => ({ ok: true }));
    expect(await h.call({ ...base, fields: {}, environment: STALE_ENV })).toMatchObject({ ok: false, error: OTHER_SERVER, notSent: true });
    expect(h.executeEc).not.toHaveBeenCalled();
  });
});

describe('STUDIO_DELETE_CHILD', () => {
  it('resolves the child by sanitised id across the three classes and deletes it', async () => {
    const h = await harness(async () => ({ ok: true, log: 'deleted' }));
    const res = await h.call({ type: 'STUDIO_DELETE_CHILD', childId: 'cve_1" OR 1' });
    expect(res).toEqual({ type: 'STUDIO_CHILD_DELETED', ok: true, error: undefined });
    const code = h.executeEc.mock.calls[0][0] as string;
    expect(code).toContain('_r := SELECT CustomVisualizationExpression WHERE id = "cve_1OR1"');
    expect(code).toContain('_o.delete()');
    expect(h.executeEc.mock.calls[0][2]).toBe(true);
  });

  it('an empty id deletes nothing it cannot name (the resolve finds no child)', async () => {
    const h = await harness(async () => ({ ok: false, error: 'Missing value' }));
    const res = await h.call({ type: 'STUDIO_DELETE_CHILD', childId: '"' });
    expect((h.executeEc.mock.calls[0][0] as string)).toContain('WHERE id = ""');
    expect(res).toMatchObject({ ok: false });
  });

  it('a lost answer is reported as outcome unknown; another server is refused', async () => {
    const h = await harness(async () => ({ ok: false, error: 'timed out', outcomeUnknown: true }));
    expect(await h.call({ type: 'STUDIO_DELETE_CHILD', childId: 'x' })).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(await h.call({ type: 'STUDIO_DELETE_CHILD', childId: 'x', environment: STALE_ENV })).toMatchObject({ ok: false, error: OTHER_SERVER });
    expect(h.executeEc).toHaveBeenCalledTimes(1);
  });
});

describe('STUDIO_WRITE_RESOURCE', () => {
  it('escapes the name, strips the content delimiter and returns the RID from the marker', async () => {
    const h = await harness(async () => ({ ok: true, log: 'x\nRID=-12' }));
    const res = await h.call({ type: 'STUDIO_WRITE_RESOURCE', resId: 'lib"x', name: 'a;"b.js', mime: 'text/javascript', base64: 'QQ==' });
    expect(res).toEqual({ type: 'STUDIO_RESOURCE_WRITTEN', ok: true, rid: '-12', id: 'libx' });
    const code = h.executeEc.mock.calls[0][0] as string;
    expect(code).toContain('content := "a\\"b.js;text/javascript;QQ=="');
    expect(code).toContain("filter(self.id = 'libx')");
  });

  it('no RID marker is a failed verification, not a success', async () => {
    const h = await harness(async () => ({ ok: true, log: 'ok' }));
    expect(await h.call({ type: 'STUDIO_WRITE_RESOURCE', resId: 'x', name: 'a', mime: '', base64: '' }))
      .toEqual({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error: 'Hosted, but could not read the new resource rid from BMP' });
  });

  it('a lost answer is reported as outcome unknown; another server is refused', async () => {
    const h = await harness(async () => ({ ok: false, error: 'timed out', outcomeUnknown: true }));
    expect(await h.call({ type: 'STUDIO_WRITE_RESOURCE', resId: 'x', name: 'a', mime: '', base64: '' })).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(await h.call({ type: 'STUDIO_WRITE_RESOURCE', resId: 'x', name: 'a', mime: '', base64: '', environment: STALE_ENV }))
      .toMatchObject({ ok: false, error: OTHER_SERVER });
  });
});

describe('STUDIO_FETCH_CODE with an environment', () => {
  beforeEach(() => vi.clearAllMocks());
  it('refuses a read for another server (a save check must not compare with the wrong server)', async () => {
    const h = await harness(async () => ({ ok: true }));
    (h.ctx.client as any).fetchCodeViaEc = vi.fn();
    expect(await h.call({ type: 'STUDIO_FETCH_CODE', rid: '1', props: ['html'], environment: STALE_ENV }))
      .toEqual({ type: 'STUDIO_CODE_DATA', ok: false, error: OTHER_SERVER });
  });
});
