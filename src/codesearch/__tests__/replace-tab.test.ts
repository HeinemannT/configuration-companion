// @vitest-environment happy-dom
/**
 * The Replace tab of the code search window: another window opens it with the
 * find and replace text filled in (nothing is sent), a reference find starts
 * with its string and comment matches unticked, one confirmation comes before
 * any write, each script is read again, parsed and saved, and Undo puts the
 * texts back from the record that stays in storage.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IndexedObject } from '../../lib/code-index-store';

type Msg = { type: string; [k: string]: unknown };
const ENV = 'p1@https://bmp.test/W/';
const AT = new Date(2026, 10, 13, 14, 2).getTime();
const sent: Msg[] = [];
const listeners: Array<(m: Msg) => void> = [];
const storage: Record<string, unknown> = {};
/** The server: what each script holds now. */
const server: Record<string, string> = {};
const BAD = 'X(';

const RIDS = { a: '9100000000000000001', b: '9100000000000000002', c: '9100000000000000003' };
const CODE = {
  a: '_v := t.old_rate.value\noutput("see t.old_rate")\n// t.old_rate\n_w := t.old_rate.value',
  b: '_x := t.old_rate.name',
  c: '_y := 1',
};

const status = {
  environment: ENV, state: 'ready', syncedAt: AT, builtAt: AT, objects: 3, bytes: 90, pending: 0, version: 4, copy: true,
  roots: [{ key: 'expression', name: 'Expressions', objects: 3, done: true }],
};

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await frame(); } await new Promise(r => setTimeout(r, 160)); await Promise.resolve(); await frame(); };
const reads = () => sent.filter(m => ['STUDIO_FETCH_CODE', 'EC_SYNTAX_CHECK', 'SAVE_PROPERTY'].includes(m.type));

beforeAll(async () => {
  Object.assign(server, { [RIDS.a]: CODE.a, [RIDS.b]: CODE.b, [RIDS.c]: CODE.c });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      connect: () => ({ postMessage: () => {}, disconnect: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }),
      lastError: undefined,
      onMessage: { addListener: (fn: (m: Msg) => void) => { listeners.push(fn); } },
      sendMessage: vi.fn(async (m: Msg) => {
        sent.push(m);
        if (m.type === 'CODE_INDEX_GET_STATUS' || m.type === 'CODE_INDEX_SYNC') return { type: 'CODE_INDEX_STATUS', status };
        if (m.type === 'GET_CONNECTION_STATE') return { type: 'CONNECTION_STATE', state: { display: 'connected', environment: ENV } };
        if (m.type === 'STUDIO_FETCH_CODE') return { type: 'STUDIO_CODE_DATA', ok: true, code: { [(m.props as string[])[0]]: server[m.rid as string] ?? '' } };
        if (m.type === 'EC_SYNTAX_CHECK') {
          return String(m.code).includes(BAD)
            ? { type: 'EC_SYNTAX_RESULT', ok: false, verdict: true, message: 'Encountered " "(" "( "" at line 3, column 4.' }
            : { type: 'EC_SYNTAX_RESULT', ok: true };
        }
        if (m.type === 'SAVE_PROPERTY') { server[m.rid as string] = m.value as string; return { type: 'SAVE_RESULT', ok: true }; }
        return undefined;
      }),
      },
    storage: {
      local: {
        get: async (k: string) => ({ [k]: storage[k] }),
        set: async (v: Record<string, unknown>) => { Object.assign(storage, v); },
        remove: async (k: string) => { delete storage[k]; },
      },
    },
  };
  document.body.innerHTML = '<div id="search-root"></div>';
  const { codeIndexStore } = await import('../../lib/code-index-store');
  const { refsOf } = await import('../../lib/code-index-sync');
  const obj = (rid: string, name: string, code: string): IndexedObject => ({
    env: ENV, rid, type: 'ExtendedExpression', name, businessId: name.toLowerCase().replace(/ /g, '_'), where: 'Expressions',
    stamp: 'Nov 1, 2026 10:00:00', len: code.length, code: { expression: code }, refs: refsOf({ expression: code }), root: 'expression',
  });
  // A linked copy of a: its code is a's (the copy keeps no text of its own).
  const instance: IndexedObject = { ...obj('9100000000000000004', 'Copy of a', ''), code: {}, refs: [], tmpl: RIDS.a, inherits: ['expression'] };
  await codeIndexStore().put([obj(RIDS.a, 'Uses a', CODE.a), obj(RIDS.b, 'Uses b', CODE.b), obj(RIDS.c, 'Uses c', CODE.c), instance]);
  await import('../codesearch');
  await settle();
});
afterAll(() => { vi.useRealTimers(); });

const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const findInput = () => q('.cs-q') as HTMLInputElement;
const replaceInput = () => q('.rp-fld .cs-q') as HTMLInputElement;
const activate = (a: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'CREV_FRAME_ACTIVATE', activation: { type: 'codesearch', ...a } } }));
const typeIn = async (input: HTMLInputElement, text: string) => { input.value = text; input.dispatchEvent(new Event('input')); await settle(); };
const click = async (el: Element | null) => { (el as HTMLElement).click(); await settle(); };
const button = (text: RegExp, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b => text.test(b.textContent ?? ''))!;
const rows = () => [...document.querySelectorAll('.rp-ml')].map(r => ({ on: !r.classList.contains('off'), tag: r.querySelector('.tag')?.textContent ?? '' }));
const summary = () => [...q('.cs-sum').children].map(c => c.textContent).join(' ').replace(/\s+/g, ' ').trim();

describe('the Replace tab', () => {
  it('opens pre-filled by another window and sends nothing to the server', async () => {
    activate({ mode: 'replace', query: 't.old_rate', replace: 't.new_rate' });
    await settle();
    expect(q('.cs-modes .on').textContent).toBe('Replace');
    expect(findInput().value).toBe('t.old_rate');
    expect(replaceInput().value).toBe('t.new_rate');
    // 5 matches of the reference in 2 objects: the string and the comment start unticked
    expect(summary()).toMatch(/^5 matches in 2 objects Change 3…$/);
    expect(rows()).toEqual([
      { on: true, tag: '' }, { on: false, tag: 'string' }, { on: false, tag: 'comment' }, { on: true, tag: '' }, { on: true, tag: '' },
    ]);
    expect(reads()).toEqual([]);
  });

  it('changes a template once: its linked copies are not listed or written', () => {
    expect(document.querySelectorAll('.rp-gh')).toHaveLength(2);
    expect(q('.rp-gh .nm').textContent).toContain('used by 1 instance');
    expect(document.querySelector('.cs-res')!.textContent).not.toContain('Copy of a');
  });

  it('asks once before writing, and Cancel writes nothing', async () => {
    await click(button(/^Change 3/));
    expect(q('.rp-dlg h2').textContent).toBe('Change 3 matches in 2 objects?');
    expect(q('.rp-chg').textContent).toContain('t.old_rate');
    expect(q('.rp-chg').textContent).toContain('t.new_rate');
    await click(button(/^Cancel$/, q('.rp-dlg')));
    expect(document.querySelector('.rp-dlg')).toBeNull();
    expect(reads()).toEqual([]);
  });

  it('ticking a string match changes the count', async () => {
    const off = [...document.querySelectorAll('.rp-ml.off')][0];
    await click(off);
    expect(summary()).toMatch(/Change 4…$/);
    await click([...document.querySelectorAll('.rp-ml')][1]);
    expect(summary()).toMatch(/Change 3…$/);
  });

  it('reads each script again, checks it, writes it, and keeps a record for Undo', async () => {
    await click(button(/^Change 3/));
    await click(button(/^Save$/, q('.rp-dlg')));
    await settle();
    expect(summary()).toMatch(/^2 saved Undo$/);
    // per script: read, check, write, read back
    const flow = reads().map(m => m.type);
    expect(flow.filter(t => t === 'EC_SYNTAX_CHECK')).toHaveLength(2);
    expect(flow.filter(t => t === 'SAVE_PROPERTY')).toHaveLength(2);
    expect(flow.slice(0, 3)).toEqual(['STUDIO_FETCH_CODE', 'EC_SYNTAX_CHECK', 'SAVE_PROPERTY']);
    expect(server[RIDS.a]).toBe('_v := t.new_rate.value\noutput("see t.old_rate")\n// t.old_rate\n_w := t.new_rate.value');
    expect(server[RIDS.b]).toBe('_x := t.new_rate.name');
    expect(Object.keys(storage)).toEqual([`crev_replace_undo:${ENV}`]);
    expect(q('.cs-status').textContent).toMatch(/^Saved /);
  });

  it('puts the texts back after a confirmation, where the server still holds what was written', async () => {
    // someone changes b on the server since
    server[RIDS.b] = '_x := t.new_rate.name + 1';
    await click(button(/^Undo$/, q('.cs-sum')));
    expect(q('.rp-dlg h2').textContent).toMatch(/^Undo the replace of /);
    await click(button(/^Undo$/, q('.rp-dlg')));
    await settle();
    expect(summary()).toBe('1 restored 1 left as it is');
    expect(server[RIDS.a]).toBe(CODE.a);
    expect(server[RIDS.b]).toBe('_x := t.new_rate.name + 1');
    expect(q('.cs-res').textContent).toMatch(/Changed on the server since the replace/);
    // what was not put back stays on record
    expect((storage[`crev_replace_undo:${ENV}`] as { scripts: unknown[] }).scripts).toHaveLength(1);
  });

  it('does not save a script the server cannot parse and says so', async () => {
    server[RIDS.c] = CODE.c;
    sent.length = 0;
    await click([...document.querySelectorAll('.cs-modes button')].find(b => b.textContent === 'Find text') ?? null);
    await click([...document.querySelectorAll('.cs-modes button')].find(b => b.textContent === 'Replace') ?? null);
    await typeIn(findInput(), '1');
    await typeIn(replaceInput(), BAD);
    await click(button(/^Change 1/));
    await click(button(/^Save$/, q('.rp-dlg')));
    await settle();
    expect(summary()).toBe('0 saved 1 not saved');
    expect(q('.cs-res').textContent).toContain('Not saved');
    expect(q('.cs-res .rp-err .msg').textContent).toMatch(/^Unexpected "\(" at line 2, column 4\.$/);
    expect(server[RIDS.c]).toBe(CODE.c);
    expect(sent.some(m => m.type === 'SAVE_PROPERTY')).toBe(false);
  });
});

