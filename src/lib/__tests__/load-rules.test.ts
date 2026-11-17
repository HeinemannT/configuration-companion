/**
 * The load rules hold for every path (load-governor.ts): every BMP command
 * post and every other multi-object read goes through the transport lane and
 * its governor, and no post carries more full object reads than the governor
 * allows (25 at most, fewer after large or slow answers).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import { BmpTransport } from '../bmp-transport';
import { GOVERNOR } from '../load-governor';
import { registerBmpTypes } from '../bmp-types';

afterEach(() => vi.unstubAllGlobals());

const SRC = join(__dirname, '..', '..');

function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'integration') out.push(...sources(p)); continue; }
    if (/\.(ts|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

describe('full object reads per post', () => {
  function fakeClient(perPost: number) {
    const posts: number[] = [];
    const transport = {
      governor: { fullReadsPerPost: perPost },
      sendCommands: vi.fn(async (cmds: unknown[]) => { posts.push(cmds.length); return new ArrayBuffer(0); }),
      deserializeResponse: () => [],
      formatError: (e: unknown) => String(e),
    };
    return { client: { transport } as unknown as BmpClient, posts };
  }

  it('never sends more than 25 full reads in one post, whatever the caller asks for', async () => {
    const { client, posts } = fakeClient(GOVERNOR.fullReadsPerPost);
    const rids = Array.from({ length: 100 }, (_, i) => String(9007199254740993n + BigInt(i)));
    await BmpClient.prototype.readFullObjects.call(client, rids);
    expect(posts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...posts)).toBe(25);
  });

  it('follows the governor when it lowers the size after large or slow answers', async () => {
    const { client, posts } = fakeClient(6);
    await BmpClient.prototype.readFullObjects.call(client, Array.from({ length: 20 }, (_, i) => String(100 + i)));
    expect(posts).toEqual([6, 6, 6, 2]);
  });

  it('builds full read commands in one place only: readFullObjects', () => {
    const users = sources().filter(p => /makeGetObjectCommand\(/.test(read(p))).map(rel).sort();
    expect(users).toEqual(['lib/bmp-client.ts', 'lib/bmp-types.ts']);
    const calls = read(join(SRC, 'lib/bmp-client.ts')).match(/makeGetObjectCommand\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

describe('every post goes through the transport lane', () => {
  it('no code posts to the command endpoint except the transport (via the auth layer)', () => {
    // Only bmp-auth builds the command URL, and it sends what the transport
    // hands it (fetchCommand); other files only name the path in text.
    const builders = sources().filter(p => /cs\/command\?/.test(read(p))).map(rel);
    expect(builders).toEqual(['lib/bmp-auth.ts']);
    const callers = sources().filter(p => /\.fetchCommand\(/.test(read(p))).map(rel);
    expect(callers).toEqual(['lib/bmp-transport.ts']);
  });

  it('the portal search, a multi-object read without commands, takes its turn and is counted', async () => {
    registerBmpTypes();
    const transport = new BmpTransport('https://bmp.test/W/', {
      sessionEpoch: 0, getLoginTicket: vi.fn(), refreshLoginTicket: vi.fn(), invalidateLoginTicket: vi.fn(),
      rejectCommandAuthentication: vi.fn(), fetchCommand: vi.fn(),
    } as never);
    const run = vi.fn(async () => 'answer');
    await expect(transport.sendGoverned('QuickSearch', undefined, run)).resolves.toBe('answer');
    expect(run).toHaveBeenCalledTimes(1);
    expect(transport.governor.counters).toMatchObject({ posts: 1, commands: 1, fullReads: 0 });
    expect(transport.governor.recentPosts.at(-1)).toMatchObject({ op: 'QuickSearch', ok: true, fullReads: 0 });
    // A failure is recorded as well and reaches the caller.
    await expect(transport.sendGoverned('QuickSearch', undefined, async () => { throw new Error('HTTP 500'); })).rejects.toThrow('HTTP 500');
    expect(transport.governor.recentPosts.at(-1)).toMatchObject({ op: 'QuickSearch', ok: false });
  });

  it('quickSearch uses the governed lane', () => {
    const src = read(join(SRC, 'lib/bmp-client.ts'));
    const body = src.slice(src.indexOf('async quickSearch('), src.indexOf('async quickSearch(') + 2500);
    expect(body).toMatch(/this\.transport\.sendGoverned\('QuickSearch'/);
  });
});
