// @vitest-environment happy-dom
/**
 * The code search window's local copy, as the owner meets it: a copy that
 * was held back says why, where the counted thing lives and offers what
 * helps right there; a running copy shows its progress with Stop; a refresh
 * that found nothing says so; the block says where the copy is kept, what it
 * holds and when it was made, and Remove copy leaves the none state; copies
 * of the same server for other profiles are shown and removable; a press the
 * worker does not answer says so.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Msg = { type: string; [k: string]: unknown };
const ENV = 'p1@https://bmp.test/W/';
const AT = new Date(2026, 10, 13, 14, 2).getTime();
const sent: Msg[] = [];
const listeners: Array<(m: Msg) => void> = [];
const status = (more: Record<string, unknown> = {}) => ({ environment: ENV, state: 'none', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 1, ...more });
let current: Record<string, unknown> = status();
/** What the worker answers each message with (undefined: no answer). */
let answer: (m: Msg) => unknown = m => (['CODE_INDEX_GET_STATUS', 'CODE_INDEX_SYNC', 'CODE_INDEX_REMOVE'].includes(m.type) ? { type: 'CODE_INDEX_STATUS', status: current } : undefined);

const deliver = (s: Record<string, unknown>) => { current = s; for (const l of listeners) l({ type: 'CODE_INDEX_STATUS', status: s }); };
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await frame(); } await new Promise(r => setTimeout(r, 0)); };
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const buttons = (root: Element | null) => [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
const button = (root: Element | null, text: string) => buttons(root).find(b => b.textContent === text);
const footerLinks = () => buttons($('.cs-status .facts'));

beforeAll(async () => {
  document.body.innerHTML = '<div id="search-root"></div>';
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { get: async (k: string) => ({ [k]: true }), set: async () => undefined } },
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      connect: () => ({ postMessage: () => {}, disconnect: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }),
      onMessage: { addListener: (fn: (m: Msg) => void) => { listeners.push(fn); } },
      sendMessage: vi.fn(async (m: Msg) => {
        sent.push(m);
        if (m.type === 'GET_CONNECTION_STATE') return { type: 'CONNECTION_STATE', state: { display: 'connected', environment: ENV } };
        if (m.type === 'CODE_SEARCH_ROOTS') return { type: 'CODE_SEARCH_ROOTS_RESULT', ok: true, roots: [], orgs: {} };
        return answer(m);
      }),
    },
  };
  await import('../codesearch');
  await settle();
});

describe('a copy that was held back', () => {
  it('the owner\'s case: a paused copy says where the counted scripts live, with no button: the note goes when the worker sees the server restart', async () => {
    deliver(status({
      state: 'paused', copy: true, objects: 1632, pending: 656, progress: { phase: 'reading', read: 976, toRead: 1632 },
      serverScripts: { entries: 213, bytes: 13_000_000, since: null, restartSeen: false },
    }));
    await settle();
    // Resume is right there; the script count no longer holds a copy back.
    expect(footerLinks().map(b => b.textContent)).toEqual(expect.arrayContaining(['Resume', 'Remove copy', 'Copy details']));
    expect($('.cs-cp-problem')).toBeNull();
    footerLinks().find(b => b.textContent === 'Copy details')!.click();
    await settle();
    const mem = $('.cs-cp-mem');
    expect(mem?.textContent).toMatch(/^Companion has left about 213 parsed scripts \(about 13 MB\) in this server's memory, not disk space on this computer, and starts the count again by itself when it sees the server restart\./);
    expect(mem?.querySelector('button')).toBeNull();
    // The stopped copy shows where it stopped, without motion.
    expect($('.crev-cp')?.getAttribute('data-run')).toBe('off');
    // The worker saw the restart and sends a status without the count.
    deliver(status({ state: 'paused', copy: true, objects: 1632, pending: 656, progress: { phase: 'reading', read: 976, toRead: 1632 } }));
    await settle();
    expect(sent.some(m => m.type === 'RESET_SCRIPT_COUNT')).toBe(false);
    expect($('.cs-cp-mem')).toBeNull();
    $<HTMLButtonElement>('.cs-cp button[aria-label="Close"]')!.click();
    await settle();
    expect($('.cs-cp')).toBeNull();
  });

  it('Resume shows at once that it was pressed, then the running copy with its progress and Stop', async () => {
    let release: (v: unknown) => void = () => {};
    answer = m => m.type === 'CODE_INDEX_SYNC' ? new Promise(r => { release = r; }) : { type: 'CODE_INDEX_STATUS', status: current };
    const resume = footerLinks().find(b => b.textContent === 'Resume')!;
    resume.click();
    await settle();
    // Not dead: disabled while the worker answers.
    expect(footerLinks().find(b => b.textContent === 'Resume')?.disabled).toBe(true);
    const running = status({ state: 'building', copy: true, objects: 1632, progress: { phase: 'reading', read: 1000, toRead: 1632, posts: 7, startedAt: Date.now() - 5_000 } });
    current = running;
    release({ type: 'CODE_INDEX_STATUS', status: running });
    await settle();
    const bar = $('.crev-cp');
    expect(bar?.hidden).toBe(false);
    expect(bar?.querySelector('.crev-cp-line')?.textContent).toBe('Reading the code: 1,000 of 1,632 objects.');
    bar!.querySelector<HTMLButtonElement>('.crev-cp-stop')!.click();
    expect(sent.at(-1)?.type).toBe('CODE_INDEX_CANCEL');
    answer = m => (['CODE_INDEX_GET_STATUS', 'CODE_INDEX_SYNC', 'CODE_INDEX_REMOVE'].includes(m.type) ? { type: 'CODE_INDEX_STATUS', status: current } : undefined);
  });

  it('a press the worker does not answer says so', async () => {
    deliver(status({ state: 'paused', copy: true, objects: 10, progress: { phase: 'reading', read: 1, toRead: 10 } }));
    await settle();
    answer = () => undefined;
    footerLinks().find(b => b.textContent === 'Resume')!.click();
    await settle();
    expect($('.cs-cp-problem')?.getAttribute('data-kind')).toBe('no-answer');
    answer = () => ({ type: 'CODE_INDEX_STATUS', status: current });
    $<HTMLButtonElement>('.cs-cp-problem button[aria-label="Hide this note"]')!.click();
    await settle();
    expect($('.cs-cp-problem')).toBeNull();
  });

  it('a Remove the worker does not answer offers Remove again, not a copy', async () => {
    deliver(status({ state: 'paused', copy: true, objects: 10, progress: { phase: 'reading', read: 1, toRead: 10 } }));
    await settle();
    answer = () => undefined;
    footerLinks().find(b => b.textContent === 'Remove copy')!.click();
    await settle();
    const notice = $('.cs-cp-problem')!;
    expect(notice.getAttribute('data-kind')).toBe('no-answer');
    expect(notice.textContent).not.toMatch(/Nothing was sent/);
    expect(buttons(notice).map(b => b.textContent)).toEqual(['', 'Remove copy']);
    answer = () => ({ type: 'CODE_INDEX_STATUS', status: status() });
    const before = sent.length;
    button(notice, 'Remove copy')!.click();
    await settle();
    expect(sent.slice(before).map(m => m.type)).toContain('CODE_INDEX_REMOVE');
    expect(sent.slice(before).map(m => m.type)).not.toContain('CODE_INDEX_SYNC');
    expect($('.cs-cp-problem')).toBeNull();
    answer = m => (['CODE_INDEX_GET_STATUS', 'CODE_INDEX_SYNC', 'CODE_INDEX_REMOVE'].includes(m.type) ? { type: 'CODE_INDEX_STATUS', status: current } : undefined);
  });

  it('an overloaded server: the retry waits for the cool-down and says until when', async () => {
    const until = Date.now() + 20 * 60_000;
    deliver(status({ state: 'failed', copy: true, objects: 10, progress: { phase: 'reading', read: 1, toRead: 10 }, problem: { kind: 'overload', until, detail: 'HTTP 503' } }));
    await settle();
    const notice = $('.cs-cp-problem')!;
    expect(notice.textContent).toMatch(/Companion sends it no background work until \d\d:\d\d/);
    const retry = buttons(notice).find(b => /^Try again after \d\d:\d\d$/.test(b.textContent ?? ''));
    expect(retry?.disabled).toBe(true);
    expect(notice.querySelector('details .ui-failed-detail')?.textContent).toBe('HTTP 503');
  });
});

describe('a refresh and the block', () => {
  it('a refresh that found nothing says so for a moment', async () => {
    deliver(status({ state: 'refreshing', copy: true, objects: 3, bytes: 90, builtAt: AT, syncedAt: AT }));
    await settle();
    deliver(status({ state: 'ready', copy: true, objects: 3, bytes: 90, builtAt: AT, syncedAt: AT + 60_000, last: { changed: 0, removed: 0, ms: 400, posts: 1, at: Date.now(), unchanged: true } }));
    await settle();
    expect($('.cs-cp-done')?.textContent).toBe('Refreshed. Nothing changed on the server (1 request, 0 s).');
  });

  it('the block: where it is kept, what it holds, when it was made; Remove copy leaves the none state', async () => {
    deliver(status({
      state: 'ready', copy: true, objects: 3573, bytes: 4_300_000, builtAt: AT, syncedAt: AT + 3_600_000,
      roots: [{ key: 'expression', name: 'Expressions', objects: 1200, done: true }, { key: 'organisation', name: 'Organisation', objects: 2373, done: true }],
      notCovered: ['2 objects that could not be read'],
      others: [{ environment: 'p2@https://bmp.test/W/', profile: 'Steadfast as admin', objects: 900, bytes: 1_000_000, syncedAt: AT, builtAt: AT }],
    }));
    await settle();
    footerLinks().find(b => b.textContent === 'Copy details')!.click();
    await settle();
    const block = $('.cs-cp')!;
    const text = block.textContent ?? '';
    expect(text).toMatch(/KeptIn this browser profile on this computer\./);
    expect(text).toMatch(/Holds3,573 objects with code, 4\.3 MB of code text\./);
    expect(text).toMatch(/Made13 Nov, 14:02\. Last refreshed 13 Nov, 15:02\./);
    expect(text).toMatch(/Missing2 objects that could not be read\./);
    expect(block.querySelector('details summary')?.textContent).toBe('By place');
    expect(text).toMatch(/a copy of this server for Steadfast as admin \(900 objects, 1\.0 MB/);
    // Another profile's copy: only that one goes.
    button(block, 'Remove')!.click();
    await settle();
    expect(sent.filter(m => m.type === 'CODE_INDEX_REMOVE').at(-1)).toEqual({ type: 'CODE_INDEX_REMOVE', environment: 'p2@https://bmp.test/W/' });
    // This window's copy: the block shows the none state.
    answer = m => m.type === 'CODE_INDEX_REMOVE' ? { type: 'CODE_INDEX_STATUS', status: status() } : { type: 'CODE_INDEX_STATUS', status: current };
    button($('.cs-cp'), 'Remove copy')!.click();
    await settle();
    expect(sent.filter(m => m.type === 'CODE_INDEX_REMOVE').at(-1)).toEqual({ type: 'CODE_INDEX_REMOVE' });
    const none = $('.cs-cp')!;
    expect(none.textContent).toMatch(/A copy keeps this server's Extended Code in this browser profile on this computer\./);
    expect(button(none, 'Make copy')).toBeDefined();
    // Nothing is listed on the server until the user asks what it costs.
    expect(sent.some(m => m.type === 'CODE_INDEX_ESTIMATE')).toBe(false);
    expect(button(none, 'What a copy costs')).toBeDefined();
  });
});
