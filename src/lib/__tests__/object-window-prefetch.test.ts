import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectRootPayload } from '../object-window';

const mocks = vi.hoisted(() => ({ getCtx: vi.fn(), openObjectRoot: vi.fn() }));
vi.mock('../sw-context', () => ({ getCtx: mocks.getCtx, ctxOf: (meta?: { ctx?: unknown }) => meta?.ctx ?? mocks.getCtx(), boundCtxForTab: async (_t: unknown, fallback?: unknown) => fallback ?? mocks.getCtx(), boundContexts: () => [mocks.getCtx()] }));
vi.mock('../object-window', () => ({ openObjectRoot: mocks.openObjectRoot }));

const ISSUE = '4359639872573959006';
const TPL = '2900378040243201069';

function payload(rid: string, template?: string): ObjectRootPayload {
  return {
    rid,
    root: { rid, type: template ? 'CeIssue' : 'EnterpriseTemplate', name: 'x', businessId: 'x', props: {}, references: template ? { template: [template] } : {}, overridden: [] },
    rows: null, nodes: {}, posts: 1, ms: 1,
  } as ObjectRootPayload;
}

async function ask(rid: string): Promise<unknown> {
  const { getHandler } = await import('../handler-registry');
  return new Promise(resolve => { void getHandler('OPEN_OBJECT_ROOT')!({ type: 'OPEN_OBJECT_ROOT', rid } as never, resolve as never, {} as never); });
}

describe('object window: service-worker prefetch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getCtx.mockReturnValue({ client: { serverUrl: 'https://bmp.test/' }, settings: { activeProfileId: 'p' } });
    mocks.openObjectRoot.mockImplementation(async (_c: unknown, rid: string) => payload(rid, rid === ISSUE ? TPL : undefined));
  });

  it('answers the window from the prefetched read and starts the presenting template early', async () => {
    const { prefetchObjectRoot } = await import('../handlers/object-window');
    prefetchObjectRoot(ISSUE, 'CeIssue');
    await vi.waitFor(() => expect(mocks.openObjectRoot).toHaveBeenCalledWith(expect.anything(), TPL, 'EnterpriseTemplate', undefined));
    const root = await ask(ISSUE) as { ok: boolean; payload: ObjectRootPayload };
    const tpl = await ask(TPL) as { ok: boolean };
    expect(root.ok && tpl.ok).toBe(true);
    // One read each: the window's requests joined the prefetches.
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(2);
  });

  it('a window frame may write what the worker served to it: root, tree nodes, template, full reads', async () => {
    const NODE = '7000000000000000099';
    const LINKED = '7000000000000000097';
    const READ = '7000000000000000096';
    const NEVER = '7000000000000000095';
    mocks.openObjectRoot.mockImplementation(async (_c: unknown, rid: string) => {
      const p = payload(rid, TPL);
      return { ...p, root: { ...p.root, references: { ...p.root.references, linkedTo: [LINKED] } }, nodes: { [NODE]: payload(NODE).root } };
    });
    const readFullObjects = vi.fn(async (rids: string[]) => ({ objects: Object.fromEntries(rids.filter(r => r !== NEVER).map(r => [r, payload(r).root])), errors: {} }));
    mocks.getCtx.mockReturnValue({ client: { serverUrl: 'https://bmp.test/', readFullObjects }, settings: { activeProfileId: 'p' } });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/object-window');
    const { frameMayWrite, resetFrameReads } = await import('../sender-trust');
    resetFrameReads();
    const url = 'chrome-extension://abcdef/objectview/window.html#1';
    const meta = { senderKind: 'frame', senderTabId: 5, senderFrameId: 2, senderDocumentId: 'doc-w', senderUrl: url };
    const call = <T>(msg: object, m: object = meta) => new Promise<T>(resolve => { void getHandler((msg as { type: never }).type)!(msg as never, resolve as never, m as never); });
    const res = await call<{ ok: boolean; environment: string }>({ type: 'OPEN_OBJECT_ROOT', rid: ISSUE });
    expect(res.ok).toBe(true);
    const env = res.environment;
    const win = { tabId: 5, frameId: 2, documentId: 'doc-w', url };
    expect(await frameMayWrite(win, env, ISSUE)).toBe(true);
    expect(await frameMayWrite(win, env, NODE)).toBe(true);
    expect(await frameMayWrite(win, env, TPL)).toBe(true);
    expect(await frameMayWrite(win, env, LINKED)).toBe(true);
    expect(await frameMayWrite(win, env, READ)).toBe(false);
    await call({ type: 'READ_FULL_OBJECTS', rids: [READ, NEVER] });
    expect(await frameMayWrite(win, env, READ)).toBe(true);
    // Asked for but not answered, or never asked for: refused.
    expect(await frameMayWrite(win, env, NEVER)).toBe(false);
    // Served to this frame only: another frame of the tab has nothing.
    expect(await frameMayWrite({ ...win, frameId: 3, documentId: 'doc-x' }, env, ISSUE)).toBe(false);
    // A full read answered to another frame does not extend this one.
    await call({ type: 'READ_FULL_OBJECTS', rids: [NODE.replace(/9$/, '4')] }, { ...meta, senderFrameId: 3, senderDocumentId: 'doc-x' });
    expect(await frameMayWrite(win, env, NODE.replace(/9$/, '4'))).toBe(false);
  });

  it('hands a finished prefetch out once; a later open reads again', async () => {
    const { prefetchObjectRoot } = await import('../handlers/object-window');
    prefetchObjectRoot(TPL);
    await ask(TPL);
    await ask(TPL);
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(2);
    // A new prefetch (reopening after a save) never reuses a finished one.
    prefetchObjectRoot(TPL);
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(3);
  });

  it('a hover read is background work, superseded by the next hover', async () => {
    const signals: AbortSignal[] = [];
    mocks.openObjectRoot.mockImplementation((_c: unknown, rid: string, _t: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')));
        setTimeout(() => resolve(payload(rid)), 20);
      });
    });
    const { hoverPrefetchObjectRoot } = await import('../handlers/object-window');
    const { requestClassOf } = await import('../request-class');
    hoverPrefetchObjectRoot(ISSUE, 'CeIssue');
    expect(requestClassOf(signals[0]).requestClass).toBe('background');
    hoverPrefetchObjectRoot(ISSUE, 'CeIssue');
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(1);
    hoverPrefetchObjectRoot(TPL);
    // One object at a time: the first hover read is cancelled.
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(2);
  });

  it('a user open joins a hover read and promotes it to user class', async () => {
    const signals: AbortSignal[] = [];
    mocks.openObjectRoot.mockImplementation((_c: unknown, rid: string, _t: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(resolve => setTimeout(() => resolve(payload(rid)), 20));
    });
    const { hoverPrefetchObjectRoot, prefetchObjectRoot } = await import('../handlers/object-window');
    const { requestClassOf } = await import('../request-class');
    hoverPrefetchObjectRoot(TPL);
    expect(requestClassOf(signals[0]).requestClass).toBe('background');
    prefetchObjectRoot(TPL);
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(1);
    expect(requestClassOf(signals[0]).requestClass).toBe('user');
    // A later hover elsewhere no longer cancels what the user waits for.
    hoverPrefetchObjectRoot(ISSUE);
    expect(signals[0].aborted).toBe(false);
    const res = await ask(TPL) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it('an open right after a finished hover read uses it instead of reading again', async () => {
    const { hoverPrefetchObjectRoot, prefetchObjectRoot } = await import('../handlers/object-window');
    hoverPrefetchObjectRoot(TPL);
    await vi.waitFor(async () => expect(await mocks.openObjectRoot.mock.results[0]?.value).toBeTruthy());
    prefetchObjectRoot(TPL);
    const res = await ask(TPL) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(mocks.openObjectRoot).toHaveBeenCalledTimes(1);
  });
});
