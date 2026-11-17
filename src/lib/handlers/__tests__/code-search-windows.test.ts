import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A search that waits until the test lets it end or its signal aborts. */
const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
vi.mock('../../code-search', () => ({
  runCodeSearch: (_req: unknown, _src: unknown, _onHits: unknown, o: { signal: AbortSignal }) => new Promise(resolve => {
    pending.push({ signal: o.signal, finish: () => resolve({ matches: 0 }) });
    o.signal.addEventListener('abort', () => resolve({ matches: 0 }));
  }),
}));
vi.mock('../../code-index-service', () => ({
  cancelIndexSync: vi.fn(), clearCodeIndex: vi.fn(), currentEnvironment: vi.fn(), indexStatus: vi.fn(),
  serverRoots: vi.fn(), serverScanSource: vi.fn(async () => ({})), startIndexSync: vi.fn(),
}));
vi.mock('../../codesearch-launcher', () => ({ openCodeSearchWindow: vi.fn() }));

type Handler = (msg: unknown, respond: (r: unknown) => void, meta: unknown) => Promise<void> | void;

describe('code search per window', () => {
  let start: Handler;
  let stop: Handler;
  let status: Handler;
  let sent: Array<Record<string, unknown>>;
  const ctx = { profileId: 'p1', client: {} } as never;
  const meta = (tab: number) => ({ senderTabId: tab, isOneShot: true, ctx });
  const START = (id: string, windowId: string) => ({ type: 'CODE_SEARCH_START', id, windowId, search: { mode: 'text', text: 'x' } });
  const done = () => sent.filter(m => m.type === 'CODE_SEARCH_DONE');
  const flush = () => new Promise(r => setTimeout(r, 0));

  beforeEach(async () => {
    vi.resetModules();
    pending.length = 0;
    sent = [];
    (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage: vi.fn((m: Record<string, unknown>) => { sent.push(m); return Promise.resolve(); }) } };
    await import('../code-search');
    const { getHandler } = await import('../../handler-registry');
    start = getHandler('CODE_SEARCH_START') as Handler;
    stop = getHandler('CODE_SEARCH_STOP') as Handler;
    status = getHandler('CODE_SEARCH_STATUS') as Handler;
  });
  afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

  it('a new search in the same window ends the old one as superseded', async () => {
    void start(START('a:1', 'win-a'), () => {}, meta(5));
    await flush();
    void start(START('a:2', 'win-a'), () => {}, meta(5));
    await flush();
    expect(done()).toEqual([{ type: 'CODE_SEARCH_DONE', id: 'a:1', cancelled: 'superseded' }]);
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);
  });

  it('two windows do not abort each other', async () => {
    void start(START('a:1', 'win-a'), () => {}, meta(5));
    void start(START('b:1', 'win-b'), () => {}, meta(6));
    void start(START('c:1', 'win-c'), () => {}, meta(5));
    await flush();
    expect(pending.map(p => p.signal.aborted)).toEqual([false, false, false]);
    expect(done()).toEqual([]);
    const answers: unknown[] = [];
    void status({ type: 'CODE_SEARCH_STATUS', id: 'a:1', windowId: 'win-a' }, r => answers.push(r), meta(5));
    expect(answers).toEqual([{ type: 'CODE_SEARCH_STATUS_RESULT', id: 'a:1', running: true }]);
  });

  it('a stop ends only its own window search, with cancelled stopped', async () => {
    void start(START('a:1', 'win-a'), () => {}, meta(5));
    void start(START('b:1', 'win-b'), () => {}, meta(6));
    await flush();
    void stop({ type: 'CODE_SEARCH_STOP', id: 'a:1', windowId: 'win-a' }, () => {}, meta(5));
    expect(done()).toEqual([{ type: 'CODE_SEARCH_DONE', id: 'a:1', cancelled: 'stopped' }]);
    expect(pending[1].signal.aborted).toBe(false);
  });

  it('the status check says a finished or unknown search is not running', async () => {
    void start(START('a:1', 'win-a'), () => {}, meta(5));
    await flush();
    pending[0].finish();
    await flush();
    expect(done()).toHaveLength(1);
    const answers: Array<{ running: boolean }> = [];
    void status({ type: 'CODE_SEARCH_STATUS', id: 'a:1', windowId: 'win-a' }, r => answers.push(r as { running: boolean }), meta(5));
    void status({ type: 'CODE_SEARCH_STATUS', id: 'zz', windowId: 'other' }, r => answers.push(r as { running: boolean }), meta(5));
    expect(answers.map(a => a.running)).toEqual([false, false]);
  });
});
