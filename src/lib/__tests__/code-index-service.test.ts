/**
 * The code index service (code-index-service.ts) against a simulated BMP:
 * opt-in start, the build stages as the status reports them, one job per
 * server, stop and resume, an overloaded server, a server without bulk
 * reads, per-profile separation, clearing during a build, a complete copy
 * that sends nothing by itself, and the copy after the user's own save. The sync itself is covered in code-search-engine.test.ts;
 * the store upgrade from version 1 in code-index-cards.test.ts.
 *
 * Each test loads the service fresh: its job state and the shared store are
 * module state.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { server, sim, type SimObject } from './code-search-sim';
import type { SwContext } from '../sw-context';
import type { InspectorMessage } from '../types';

const URL_1 = 'https://one.example.test/Ws/';
const URL_2 = 'https://two.example.test/Ws/';
const READ_CODE = '"~CREV_R~1:I"';

/** A simulated server whose code reads can be held until released. */
function heldServer(objects: SimObject[], opts: Parameters<typeof server>[1] = {}) {
  const base = server(objects, opts);
  let hold: Promise<void> | null = null;
  let release = () => {};
  let reached = () => {};
  let reachedP: Promise<void> = Promise.resolve();
  const client = {
    ...base,
    posts: base.posts,
    executeEcBatch: async (codes: string[], ...rest: unknown[]) => {
      if (hold && codes.some(c => c.includes(READ_CODE))) { reached(); await hold; }
      return (base.executeEcBatch as (c: string[], ...r: unknown[]) => ReturnType<typeof base.executeEcBatch>)(codes, ...rest);
    },
  };
  return {
    client,
    /** Hold the next code read; resolves `reached` once a read waits. */
    holdReads() {
      hold = new Promise(r => { release = () => { hold = null; r(); }; });
      reachedP = new Promise(r => { reached = r; });
      return { reached: reachedP, release: () => release() };
    },
  };
}

function ctxFor(profileId: string, serverUrl: string, client: object): SwContext {
  return { client: { ...client, serverUrl }, settings: { activeProfileId: profileId } } as unknown as SwContext;
}

async function load() {
  vi.resetModules();
  mockChromeStorage();
  const sent: InspectorMessage[] = [];
  (globalThis.chrome as unknown as { runtime: Record<string, unknown> }).runtime.sendMessage = vi.fn(async (m: InspectorMessage) => { sent.push(m); });
  const svc = await import('../code-index-service');
  const { codeIndexStore } = await import('../code-index-store');
  /** Wait until the index of `env` is no longer being built. */
  const settled = (env: string) => vi.waitFor(async () => {
    const s = await svc.indexStatus(env);
    if (s.state === 'building' || s.state === 'refreshing') throw new Error(`still ${s.state}`);
    return s;
  }, { timeout: 10_000, interval: 5 });
  return { svc, store: codeIndexStore(), settled, sent };
}

describe('starting a build', () => {
  it('builds nothing until the user asks (opt-in per profile)', async () => {
    const { svc } = await load();
    const s = heldServer(sim());
    const ctx = ctxFor('p1', URL_1, s.client);
    const env = await svc.startIndexSync(false, false, undefined, ctx);
    expect(env).toBe(`p1@${URL_1}`);
    expect(s.client.posts).toEqual([]);
    expect((await svc.indexStatus(env!)).state).toBe('none');
  });

  it('a user start reports building with progress, then ready with the objects', async () => {
    const { svc, settled, sent } = await load();
    const s = heldServer(sim());
    const ctx = ctxFor('p1', URL_1, s.client);
    const held = s.holdReads();
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    await held.reached;
    const during = await svc.indexStatus(env);
    expect(during.state).toBe('building');
    expect(during.progress).toBeDefined();
    // What the progress component shows: when it started.
    expect(during.progress!.startedAt).toBeTypeOf('number');
    expect(during.problem).toBeUndefined();
    held.release();
    const after = await settled(env);
    expect(after).toMatchObject({ state: 'ready', objects: 4, pending: 0, last: { first: true } });
    expect(after.builtAt).toBeTypeOf('number');
    expect(sent.some(m => m.type === 'CODE_INDEX_STATUS')).toBe(true);
  });

  it('without a client or a profile there is nothing to build', async () => {
    const { svc } = await load();
    expect(await svc.startIndexSync(true, true, undefined, { client: null, settings: { activeProfileId: 'p1' } } as unknown as SwContext)).toBeNull();
    expect(await svc.startIndexSync(true, true, undefined, ctxFor('', URL_1, heldServer(sim()).client))).toBeNull();
  });
});

describe('one job at a time', () => {
  it('a second start joins the running build and sends nothing of its own', async () => {
    const { svc, settled } = await load();
    const s = heldServer(sim());
    const ctx = ctxFor('p1', URL_1, s.client);
    const held = s.holdReads();
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    await held.reached;
    const postsBefore = s.client.posts.length;
    expect(await svc.startIndexSync(true, true, undefined, ctx)).toBe(env);
    expect(s.client.posts.length).toBe(postsBefore);
    held.release();
    await settled(env);
  });

  it('two profiles on one server: the second waits, it does not run in parallel', async () => {
    const { svc, settled, sent } = await load();
    const s = heldServer(sim());
    const held = s.holdReads();
    const env1 = (await svc.startIndexSync(true, true, undefined, ctxFor('p1', URL_1, s.client)))!;
    await held.reached;
    const env2 = (await svc.startIndexSync(true, true, undefined, ctxFor('p2', URL_1, s.client)))!;
    expect(env2).toBe(`p2@${URL_1}`);
    // Not silent: the second profile's window says why nothing started.
    expect(await svc.indexStatus(env2)).toMatchObject({ state: 'none', problem: { kind: 'busy' } });
    sent.length = 0;
    held.release();
    await settled(env1);
    // The second profile's window is told without asking again.
    await vi.waitFor(() => expect(sent.some(m => m.type === 'CODE_INDEX_STATUS' && m.status.environment === env2 && !m.status.problem)).toBe(true));
    const after = await svc.indexStatus(env2);
    expect(after.state).toBe('none');
    expect(after.problem).toBeUndefined();
    // The other profile's copy of the same server is on this computer: shown, removable.
    expect(after.others).toEqual([expect.objectContaining({ environment: env1, objects: 4, profile: 'another server profile' })]);
    await svc.removeCodeCopy(env1);
    expect((await svc.indexStatus(env2)).others).toBeUndefined();
    expect((await svc.indexStatus(env1)).state).toBe('none');
  });

  it('two servers build independently, each into its own index', async () => {
    const { svc, settled, store } = await load();
    const one = heldServer(sim());
    const two = heldServer(sim().slice(0, 2));
    const env1 = (await svc.startIndexSync(true, true, undefined, ctxFor('p1', URL_1, one.client)))!;
    const env2 = (await svc.startIndexSync(true, true, undefined, ctxFor('p2', URL_2, two.client)))!;
    expect((await settled(env1)).objects).toBe(4);
    expect((await settled(env2)).objects).toBe(2);
    expect(await store.get(env2, '9007199254740997')).toBeNull();
    expect(await store.get(env1, '9007199254740997')).not.toBeNull();
  });
});

describe('stop and resume', () => {
  it('a stopped build is paused, not failed; it resumes only when the user asks', async () => {
    const { svc, settled } = await load();
    const s = heldServer(sim());
    const ctx = ctxFor('p1', URL_1, s.client);
    const held = s.holdReads();
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    await held.reached;
    svc.cancelIndexSync(ctx);
    held.release();
    const paused = await settled(env);
    expect(paused.state).toBe('paused');
    expect(paused.error).toBeUndefined();
    expect(paused.builtAt).toBeNull();
    // Automatic work does not resume a build the user stopped.
    const posts = s.client.posts.length;
    await svc.startIndexSync(false, false, undefined, ctx);
    expect(s.client.posts.length).toBe(posts);
    expect((await svc.indexStatus(env)).state).toBe('paused');
    // Resume (a user start without force) completes it.
    await svc.startIndexSync(false, true, undefined, ctx);
    expect(await settled(env)).toMatchObject({ state: 'ready', objects: 4 });
  });

  it('a built index is never checked again without the user, however old it is', async () => {
    const { svc, settled, store } = await load();
    const s = heldServer(sim());
    const ctx = ctxFor('p1', URL_1, s.client);
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    await settled(env);
    const meta = (await store.getMeta(env))!;
    await store.putMeta({ ...meta, syncedAt: Date.now() - 30 * 86_400_000 });
    const posts = s.client.posts.length;
    await svc.startIndexSync(false, false, undefined, ctx);
    await settled(env);
    expect(s.client.posts.length).toBe(posts);
  });
});

describe('the script count in the status', () => {
  it('past the limit the status asks the client for a restart check; a restart seen sends every window a status without the count', async () => {
    const { svc, sent } = await load();
    const { LoadGovernor, scriptKey } = await import('../load-governor');
    const { SCRIPT_COST } = await import('../script-ledger');
    const g = new LoadGovernor();
    await g.noteServerCounter('500');
    for (let i = 0; i < SCRIPT_COST.backgroundEntries; i++) g.start('user', { commands: 1, fullReads: 0, scripts: [scriptKey(`s ${i}`)] }, 0);
    const checkServerRestart = vi.fn();
    const ctx = ctxFor('p1', URL_1, { ...heldServer(sim()).client, governor: g, checkServerRestart });
    const env = (await svc.startIndexSync(false, false, undefined, ctx))!;
    expect((await svc.indexStatus(env, ctx)).serverScripts).toMatchObject({ entries: SCRIPT_COST.backgroundEntries });
    expect(checkServerRestart).toHaveBeenCalledWith('limit');
    sent.length = 0;
    await g.noteServerCounter('20');
    await vi.waitFor(() => expect(sent.filter(m => m.type === 'CODE_INDEX_STATUS')).toHaveLength(1));
    const st = sent.find(m => m.type === 'CODE_INDEX_STATUS') as Extract<InspectorMessage, { type: 'CODE_INDEX_STATUS' }>;
    expect(st.status.environment).toBe(env);
    expect(st.status.serverScripts).toBeUndefined();
    checkServerRestart.mockClear();
    await svc.indexStatus(env, ctx);
    expect(checkServerRestart).not.toHaveBeenCalled();
  });
});

describe('a server that cannot or will not answer', () => {
  it('an overloaded server stops the build with a failure that says so, and marks overload', async () => {
    const { svc, settled, store } = await load();
    const s = heldServer(sim(), { overload: code => code.includes(READ_CODE) });
    const ctx = ctxFor('p1', URL_1, s.client);
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    const st = await settled(env);
    expect(st.state).toBe('failed');
    expect(st.overload).toBe(true);
    expect(st.error).toMatch(/overloaded/);
    // A kind, not a sentence: the window words it and says until when.
    expect(st.problem?.kind).toBe('overload');
    expect(st.problem!.until!).toBeGreaterThan(Date.now() + 25 * 60_000);
    // Reads stop at the first overloaded answer.
    expect(s.client.posts.flat().filter(c => c.includes(READ_CODE))).toHaveLength(1);
    // Stored so a worker restart keeps the cool-down.
    expect((await store.getMeta(env))?.overloadAt).toBeTypeOf('number');
  });

  it('a server without bulk reads is unavailable, not failed', async () => {
    const { svc, settled } = await load();
    const ctx = ctxFor('p1', URL_1, heldServer(sim(), { lookup: false }).client);
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    const st = await settled(env);
    expect(st.state).toBe('unavailable');
    expect(st.problem?.kind).toBe('unavailable');
  });

  it('names why a sync ended from the error class, not from the sentence or a refusal of other work', async () => {
    const { svc } = await load();
    const { CopyIncompleteError } = await import('../code-copy');
    const { ServerOverloadError } = await import('../index-budget');
    // A cool-down the governor holds (another post was refused) does not make another failure an overload.
    expect(svc.problemOf(new Error('x'), { until: 9_000, why: 'overloaded' }, 5_000)).toMatchObject({ kind: 'failed', detail: 'x' });
    expect(svc.problemOf(new Error('overloaded'), null, 5_000)).toMatchObject({ kind: 'failed' });
    // An overload lasts until the governor's own cool-down ends; without one, a full cool-down from now.
    expect(svc.problemOf(new ServerOverloadError('x'), { until: 9_000, why: 'overloaded' }, 5_000)).toEqual({ kind: 'overload', until: 9_000, detail: 'x' });
    expect(svc.problemOf(new ServerOverloadError('x'), null, 5_000)).toEqual({ kind: 'overload', until: 5_000 + 30 * 60_000, detail: 'x' });
    expect(svc.problemOf(new ServerOverloadError('x'), { until: 9_000, why: 'slow' }, 5_000)).toEqual({ kind: 'overload', until: 5_000 + 30 * 60_000, detail: 'x' });
    expect(svc.problemOf(new CopyIncompleteError('m', 'too-large', ['Organisation A']), null)).toMatchObject({ kind: 'too-large', sources: ['Organisation A'] });
    expect(svc.problemOf(new CopyIncompleteError('m', 'not-listed', ['Portal']), null)).toMatchObject({ kind: 'not-listed', sources: ['Portal'] });
  });

  it('a copy refused during a cool-down that began before it: overload until that cool-down ends, nothing stored', async () => {
    const { svc, settled, store } = await load();
    const until = Date.now() + 10 * 60_000;
    // The governor went into its cool-down 20 minutes ago (another post met the overload).
    const governor = { backgroundBlocked: () => ({ until, why: 'overloaded' as const }), state: () => ({ state: 'overloaded', until }), scriptBudgetUsed: () => false, onRestart: () => () => {} };
    const s = heldServer(sim(), { overload: code => code.includes(READ_CODE) });
    const env = (await svc.startIndexSync(true, true, undefined, ctxFor('p1', URL_1, { ...s.client, governor })))!;
    const st = await settled(env);
    expect(st.problem).toMatchObject({ kind: 'overload', until });
    expect(st.error).toMatch(/for 10 minutes\.$/);
    expect((await store.getMeta(env))?.overloadAt).toBeUndefined();
  });
});

describe('clearing', () => {
  it('clearing a profile during its build stops the build first and leaves no index behind', async () => {
    const { svc, store } = await load();
    const s = heldServer(sim());
    const ctx = ctxFor('p1', URL_1, s.client);
    const held = s.holdReads();
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    await held.reached;
    const cleared = svc.clearCodeIndex('p1');
    held.release();
    await cleared;
    expect(await store.getMeta(env)).toBeNull();
    expect(await store.get(env, '9007199254740993')).toBeNull();
    expect((await svc.indexStatus(env)).state).toBe('none');
  });

  it('a write already under way when the clear comes is finished before the delete, not after it', async () => {
    const { svc, store } = await load();
    const ctx = ctxFor('p1', URL_1, heldServer(sim()).client);
    // Hold the first object write of the build inside the store.
    const put = store.put.bind(store);
    let writing = () => {};
    const writingP = new Promise<void>(r => { writing = r; });
    let finish = () => {};
    const finishP = new Promise<void>(r => { finish = r; });
    let held = false;
    store.put = async objects => {
      if (!held && objects.length) { held = true; writing(); await finishP; }
      return put(objects);
    };
    const env = (await svc.startIndexSync(true, true, undefined, ctx))!;
    await writingP;
    const cleared = svc.clearCodeIndex('p1');
    finish();
    await cleared;
    // Let anything still running after the clear finish before looking.
    await svc.startIndexSync(false, false, undefined, ctx);
    await new Promise(r => setTimeout(r, 0));
    expect(await store.getMeta(env)).toBeNull();
    expect([...(store as unknown as { objects: Map<string, unknown> }).objects.keys()]).toEqual([]);
  });

  it('clearing one profile keeps the other profile’s index; clearing all removes both', async () => {
    const { svc, settled, store } = await load();
    const env1 = (await svc.startIndexSync(true, true, undefined, ctxFor('p1', URL_1, heldServer(sim()).client)))!;
    const env2 = (await svc.startIndexSync(true, true, undefined, ctxFor('p2', URL_2, heldServer(sim()).client)))!;
    await settled(env1);
    await settled(env2);
    await svc.clearCodeIndex('p1');
    expect(await store.getMeta(env1)).toBeNull();
    expect((await svc.indexStatus(env2)).state).toBe('ready');
    await svc.clearCodeIndex();
    expect(await store.getMeta(env2)).toBeNull();
  });

  it('Remove with a named copy removes only that copy of the window’s server; a name of another server removes nothing', async () => {
    const { svc, settled, store } = await load();
    await import('../handlers/code-search');
    const { getHandler } = await import('../handler-registry');
    const env1 = (await svc.startIndexSync(true, true, undefined, ctxFor('p1', URL_1, heldServer(sim()).client)))!;
    await settled(env1);
    const win = ctxFor('p2', URL_1, heldServer(sim()).client);
    const own = (await svc.startIndexSync(true, true, undefined, win))!;
    await settled(own);
    const env3 = (await svc.startIndexSync(true, true, undefined, ctxFor('p3', URL_2, heldServer(sim()).client)))!;
    await settled(env3);
    const remove = async (environment?: string) => {
      const replies: InspectorMessage[] = [];
      try {
        await getHandler('CODE_INDEX_REMOVE')!({ type: 'CODE_INDEX_REMOVE', ...(environment != null ? { environment } : {}) } as never, r => replies.push(r), { isOneShot: true, ctx: win });
      } catch (e) { return { error: (e as Error).message }; }
      return { replies };
    };
    // Another server's copy: refused, and the window's own copy stays.
    expect(await remove(env3)).toEqual({ error: expect.stringMatching(/not of this server/) });
    expect(await remove('nonsense')).toEqual({ error: expect.stringMatching(/not of this server/) });
    expect(await store.getMeta(env3)).not.toBeNull();
    expect(await store.getMeta(own)).not.toBeNull();
    // Another profile's copy of the same server: only that one goes.
    await remove(env1);
    expect(await store.getMeta(env1)).toBeNull();
    expect(await store.getMeta(own)).not.toBeNull();
    // Without a name: the window's own copy.
    await remove();
    expect(await store.getMeta(own)).toBeNull();
    expect(await store.getMeta(env3)).not.toBeNull();
  });
});

/** A server with the context path whose code can be held at the n-th read
 *  post: three roots, each read in its own post (bulk reads of about
 *  BULK_POST_CHARS). */
function copyServer(opts: Parameters<typeof server>[1] = {}) {
  const objects: SimObject[] = [];
  const big = 'x'.repeat(100_000);
  for (const [root, lead] of [['expression', '91'], ['portal', '92'], ['templateCategory', '93']] as const) {
    for (let i = 0; i < 10; i++) objects.push({ rid: `${lead}${String(i).padStart(17, '0')}`, type: 'ExtendedExpression', id: `${root}${i}`, name: `${root} ${i}`, stamp: 'Nov 1, 2026 10:00:00', root, code: { expression: `_${root} := ${i}\n${big}` } });
  }
  const base = server(objects, { ...opts, context: true });
  const pairs = base.executeEcPairs!;
  let hold: Promise<void> | null = null;
  let at = 0;
  let seen = 0;
  let release = () => {};
  let reached = () => {};
  base.executeEcPairs = async (p, ...rest) => {
    if (hold && p.some(x => x.code.includes(READ_CODE)) && ++seen === at) { reached(); await hold; }
    return pairs(p, ...rest);
  };
  return {
    client: base, objects,
    /** Hold the `n`-th code read post from now. */
    holdRead(n = 1) {
      seen = 0;
      at = n;
      hold = new Promise(r => { release = () => { hold = null; r(); }; });
      const reachedP = new Promise<void>(r => { reached = r; });
      return { reached: reachedP, release: () => release() };
    },
  };
}
const bulkFrom = (posts: string[][]) => posts.flat().filter(c => c.includes(READ_CODE) && /^_g := /m.test(c)).map(c => /^_g := (\S+)$/m.exec(c)![1]);

describe('a copy made from the search\'s read', () => {
  it('Stop leaves a paused copy that is never searched as complete; Resume reads only the rest', async () => {
    const { svc, settled, store } = await load();
    const s = copyServer();
    const ctx = ctxFor('p1', URL_1, s.client);
    const held = s.holdRead(2);
    const env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    await held.reached;
    svc.cancelIndexSync(ctx);
    held.release();
    const paused = await settled(env);
    expect(paused).toMatchObject({ state: 'paused', builtAt: null, copy: true });
    expect(paused.error).toBeUndefined();
    // How far it got: the first root was read (the second post was under way).
    expect(paused.progress).toMatchObject({ read: 10, toRead: 30 });
    // A partial copy is not a source: searches read the server.
    expect((await svc.workerSearchSource(ctx))?.kind).toBe('server');
    expect(await store.get(env, '93' + '0'.repeat(17))).toBeNull();
    // Resume: the code of the posts sent before the stop was kept; only the
    // last root is read.
    s.client.posts.length = 0;
    await svc.startIndexSync(false, true, undefined, ctx);
    const ready = await settled(env);
    expect(ready).toMatchObject({ state: 'ready', objects: 30, copy: true });
    const read = bulkFrom(s.client.posts);
    expect(read.length).toBeGreaterThan(0);
    expect(new Set(read)).toEqual(new Set(['lookup(901)']));
    expect((await svc.workerSearchSource(ctx))?.kind).toBe('index');
  });

  it('Remove works in every state: building, paused, failed and ready', async () => {
    const { svc, settled, store } = await load();
    const gone = async (env: string) => {
      expect(await store.getMeta(env)).toBeNull();
      expect((await svc.indexStatus(env)).state).toBe('none');
    };
    // Building.
    let s = copyServer();
    let ctx = ctxFor('p1', URL_1, s.client);
    let held = s.holdRead(1);
    let env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    await held.reached;
    expect((await svc.indexStatus(env)).state).toBe('building');
    const clearing = svc.clearCodeIndex('p1');
    held.release();
    await clearing;
    await gone(env);
    // Paused.
    s = copyServer();
    ctx = ctxFor('p1', URL_1, s.client);
    held = s.holdRead(2);
    env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    await held.reached;
    svc.cancelIndexSync(ctx);
    held.release();
    expect((await settled(env)).state).toBe('paused');
    await svc.clearCodeIndex('p1');
    await gone(env);
    // Failed (an overloaded answer to a read).
    s = copyServer({ overload: code => code.includes(READ_CODE) });
    ctx = ctxFor('p1', URL_1, s.client);
    env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    expect((await settled(env))).toMatchObject({ state: 'failed', overload: true });
    await svc.clearCodeIndex('p1');
    await gone(env);
    // Ready.
    s = copyServer();
    ctx = ctxFor('p1', URL_1, s.client);
    env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    expect((await settled(env)).state).toBe('ready');
    await svc.clearCodeIndex('p1');
    await gone(env);
  });
});

/** The copy server with a change feed (tree events), counting its polls. */
function feedServer() {
  const s = copyServer();
  const polls: string[] = [];
  const pack = (id: string) => ({ packId: id, propertiesChanged: false, added: [], deleted: [], relocated: [], reordered: [], updated: [] });
  const client = Object.assign(s.client, {
    sessionEpoch: 1,
    async readTreeEvents(last: string) { polls.push(last); return { ok: true as const, packs: [pack(last === '-1' ? '10' : last)] }; },
    async readTreeIdentities(rids: readonly string[]) { return new Map(rids.map(r => [r, null] as const)); },
  });
  return { ...s, client, polls };
}

/** A code search window's keep-alive port, closed with `close()`. */
function fakePort() {
  const closers: Array<() => void> = [];
  return { port: { onDisconnect: { addListener: (fn: () => void) => { closers.push(fn); } } } as unknown as chrome.runtime.Port, close: () => { for (const fn of closers) fn(); } };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

describe('a complete copy is a snapshot', () => {
  it('opening a window, three searches, 60 s idle, closing and reopening send nothing', async () => {
    const { svc, settled } = await load();
    const feed = await import('../code-feed');
    const { runCodeSearch } = await import('../code-search');
    let t = Date.now();
    feed.setFeedClock(() => t, { set: () => 1 as never, clear: () => {} });
    const s = feedServer();
    const ctx = ctxFor('p1', URL_1, s.client);
    // A window held its port while the copy was built: the build's listing
    // started the live search's change feed.
    const first = fakePort();
    svc.holdFeedForPort(first.port, async () => ctx);
    await flush();
    const env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    expect(await settled(env)).toMatchObject({ state: 'ready', copy: true });
    expect(s.polls).toContain('-1');
    const sent = () => s.client.posts.length + s.polls.length;
    const before = sent();

    // Opening a window: its status, and a start without the user.
    await svc.indexStatus(env);
    await svc.startIndexSync(false, false, undefined, ctx);
    // Three searches (the worker's source is the copy).
    for (const text of ['_expression', '_portal := 3', 'x']) {
      const source = (await svc.workerSearchSource(ctx))!;
      expect(source.kind).toBe('index');
      expect((await runCodeSearch({ mode: 'text', text }, source, () => {})).matchedObjects).toBeGreaterThan(0);
    }
    // 60 s with the window open: four feed rounds.
    for (let i = 0; i < 4; i++) { t += feed.FEED_POLL_MS; await feed.tick(); await flush(); }
    // Closing and reopening the window.
    first.close();
    const second = fakePort();
    svc.holdFeedForPort(second.port, async () => ctx);
    await flush();
    await svc.indexStatus(env);
    t += feed.FEED_POLL_MS;
    await feed.tick();
    await flush();
    second.close();
    expect(sent()).toBe(before);
    expect((await svc.indexStatus(env)).syncedAt).toBe((await svc.indexStatus(env)).builtAt);
  });

  it('Refresh runs as the user\'s request and shows its progress; the copy keeps its time when nothing changed', async () => {
    const { svc, settled, sent } = await load();
    const s = copyServer();
    const ctx = ctxFor('p1', URL_1, s.client);
    const env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    const built = await settled(env);
    s.client.posts.length = 0;
    sent.length = 0;
    await new Promise(r => setTimeout(r, 5));
    await svc.startIndexSync(true, true, undefined, ctx);
    expect((await svc.indexStatus(env)).state).toBe('refreshing');
    const after = await settled(env);
    // Nothing changed: one request (the summary).
    expect(s.client.posts).toHaveLength(1);
    expect(after.syncedAt).toBeGreaterThan(built.syncedAt!);
    expect(after.version).toBe(built.version);
    expect(sent.some(m => m.type === 'CODE_INDEX_STATUS' && m.status.state === 'refreshing')).toBe(true);
  });

  it('Refresh in a later worker life: nothing changed is the summary alone; a change reads the roots for the listing', async () => {
    // Build in one worker life.
    const first = await load();
    const s = copyServer();
    const ctx = ctxFor('p1', URL_1, s.client);
    const env = (await first.svc.startIndexSync(false, true, undefined, ctx))!;
    await first.settled(env);
    const meta = (await first.store.getMeta(env))!;
    const objects: Array<Parameters<typeof first.store.put>[0][number]> = [];
    await first.store.scan(env, batch => { objects.push(...batch.map(o => ({ ...o, env }))); });
    // A new worker: the copy is on disk, nothing is known in memory.
    const later = await load();
    await later.store.putMeta(meta);
    await later.store.put(objects);
    const isRoots = (post: string[]) => post.some(c => c.includes('_x := root.'));
    s.client.posts.length = 0;
    await later.svc.startIndexSync(true, true, undefined, ctx);
    expect(await later.settled(env)).toMatchObject({ state: 'ready', objects: 30 });
    expect(s.client.posts).toHaveLength(1);
    expect(s.client.posts.some(isRoots)).toBe(false);
    // One object changed: the listing needs the server's current roots.
    s.objects[0].code = { expression: '_expression := 99' };
    s.objects[0].stamp = 'Nov 2, 2026 10:00:00';
    s.client.posts.length = 0;
    await later.svc.startIndexSync(true, true, undefined, ctx);
    expect(await later.settled(env)).toMatchObject({ state: 'ready', objects: 30 });
    expect(s.client.posts.filter(isRoots)).toHaveLength(1);
    expect((await later.store.get(env, s.objects[0].rid))?.code.expression).toBe('_expression := 99');
  });
});

describe('after a save by the extension', () => {
  it('the copy takes the saved code without asking the server', async () => {
    const { svc, settled, store } = await load();
    const s = copyServer();
    const ctx = ctxFor('p1', URL_1, s.client);
    const env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    const before = await settled(env);
    const rid = s.objects[0].rid;
    const posts = s.client.posts.length;
    svc.noteSavedObject(rid, { expression: '_saved := t.saved_object', name: 'Not code' }, ctx);
    await vi.waitFor(async () => expect((await store.get(env, rid))?.code.expression).toBe('_saved := t.saved_object'), { timeout: 10_000, interval: 5 });
    const o = (await store.get(env, rid))!;
    expect(o.code).toEqual({ expression: '_saved := t.saved_object' });
    expect(o.len).toBe('_saved := t.saved_object'.length);
    expect(o.refs.map(r => r.k)).toContain('t.saved_object');
    // The stamp stays: the next Refresh reads the object again.
    expect(o.stamp).toBe(s.objects[0].stamp);
    const after = await svc.indexStatus(env);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.syncedAt).toBe(before.syncedAt);
    expect(s.client.posts.length).toBe(posts);
  });

  it('a save without code text, or without a built copy, changes nothing and sends nothing', async () => {
    const { svc, settled, store } = await load();
    const s = copyServer();
    const ctx = ctxFor('p1', URL_1, s.client);
    svc.noteSavedObject(s.objects[0].rid, { expression: '_x := 1' }, ctx);
    await flush();
    expect(s.client.posts).toEqual([]);
    const env = (await svc.startIndexSync(false, true, undefined, ctx))!;
    const before = await settled(env);
    const posts = s.client.posts.length;
    svc.noteSavedObject(s.objects[0].rid, undefined, ctx);
    svc.noteSavedObject(s.objects[0].rid, { name: 'Renamed' }, ctx);
    await flush();
    expect((await svc.indexStatus(env)).version).toBe(before.version);
    expect((await store.get(env, s.objects[0].rid))?.code.expression).toBe(s.objects[0].code.expression);
    expect(s.client.posts.length).toBe(posts);
  });
});
