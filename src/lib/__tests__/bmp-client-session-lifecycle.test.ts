import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import { mockChromeStorage } from './chrome-mock';

beforeEach(() => { mockChromeStorage(); });

describe('command identity across asynchronous write preparation', () => {
  it('does not send EC prepared under a logged-out identity', async () => {
    const client = new BmpClient('https://bmp.test/', '', '', 'p', 'portal');
    let finish!: (org: bigint) => void;
    const resolver = client as unknown as { resolveOrgRid(rid: string): Promise<bigint> };
    vi.spyOn(resolver, 'resolveOrgRid').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const send = vi.spyOn((client as any).transport, 'sendStreamingCommand').mockResolvedValue([]);
    const result = client.executeEc('1', '42', true);
    client.logout();
    finish(1n);
    expect((await result).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not commit an identity change validated under a previous account', async () => {
    const client = new BmpClient('https://bmp.test/', '', '', 'p', 'portal');
    vi.spyOn(client, 'resolveRef').mockResolvedValue('lookup(42)');
    const execute = vi.spyOn(client, 'executeEc').mockImplementation(async (_code, _rid, transactional) => {
      if (!transactional) client.logout();
      return { ok: true, log: 'validated' };
    });
    const result = await client.applyIdentityChanges('42', { name: 'example' }).catch(error => error);
    expect(result.ok).not.toBe(true);
    expect(execute.mock.calls.filter(args => args[2] === true)).toHaveLength(0);
  });
});
