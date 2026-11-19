import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<Record<string, unknown>> = [];
let answer: (m: Record<string, unknown>) => unknown = () => undefined;
const storage: Record<string, unknown> = {};

beforeEach(() => {
  sent.length = 0;
  for (const k of Object.keys(storage)) delete storage[k];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(async (m: Record<string, unknown>) => { sent.push(m); return answer(m); }) },
    storage: { local: {
      get: async (k: string) => ({ [k]: storage[k] }),
      set: async (v: Record<string, unknown>) => { Object.assign(storage, v); },
      remove: async (k: string) => { delete storage[k]; },
    } },
  };
});

const ENV = 'p@https://bmp.test/W/';

describe('the port to the server', () => {
  it('reads and writes with this server named', async () => {
    const { messageReplacePort } = await import('../code-replace-port');
    const port = messageReplacePort(ENV);
    answer = m => (m.type === 'STUDIO_FETCH_CODE' ? { type: 'STUDIO_CODE_DATA', ok: true, code: { expression: 'x' } } : { type: 'SAVE_RESULT', ok: true });
    expect(await port.fetch('9007199254740993', ['expression'])).toEqual({ ok: true, code: { expression: 'x' } });
    expect(await port.write('9007199254740993', { type: 'ExtendedExpression', name: 'N', businessId: 'n' }, 'expression', 'y')).toEqual({ type: 'SAVE_RESULT', ok: true });
    expect(sent).toEqual([
      { type: 'STUDIO_FETCH_CODE', rid: '9007199254740993', props: ['expression'], environment: ENV },
      { type: 'SAVE_PROPERTY', environment: ENV, rid: '9007199254740993', objectType: 'ExtendedExpression', property: 'expression', value: 'y', objectLabel: { name: 'N', businessId: 'n', type: 'ExtendedExpression' } },
    ]);
  });

  it('tells the server\'s refusal of a script from a check that failed', async () => {
    const { messageReplacePort } = await import('../code-replace-port');
    const port = messageReplacePort(ENV);
    answer = () => ({ type: 'EC_SYNTAX_RESULT', ok: false, verdict: true, message: 'Encountered " "ENDIF" "ENDIF "" at line 4, column 1.' });
    expect(await port.check('x')).toEqual({ ok: false, verdict: true, message: 'Unexpected "ENDIF" at line 3, column 1.' });
    answer = () => ({ type: 'EC_SYNTAX_RESULT', ok: false, message: 'Network error' });
    expect(await port.check('x')).toEqual({ ok: false, verdict: false, message: 'Could not check the script: Network error' });
    answer = () => undefined;
    expect(await port.check('x')).toMatchObject({ ok: false, verdict: false });
  });
});

describe('the record of the last replace', () => {
  it('is kept per server and read back', async () => {
    const { replaceRecords } = await import('../code-replace-port');
    const rec = { v: 1 as const, environment: ENV, at: '2026-11-19T12:00:00.000Z', find: 'a', replace: 'b', scripts: [{ rid: '1', prop: 'expression', type: 'T', name: 'N', businessId: 'n', before: 'a', edits: [[0, 1, 'b']] as Array<[number, number, string]> }] };
    await replaceRecords.save(rec);
    expect(await replaceRecords.load(ENV)).toEqual(rec);
    expect(await replaceRecords.load('other@https://bmp.test/W/')).toBeNull();
    await replaceRecords.clear(ENV);
    expect(await replaceRecords.load(ENV)).toBeNull();
  });
});

describe('the entry', () => {
  it('opens Code Search on the Replace tab with both texts', async () => {
    const { openCodeSearchReplace } = await import('../code-replace-port');
    openCodeSearchReplace('t.old_id', 't.new_id');
    expect(sent).toEqual([{ type: 'OPEN_CODE_SEARCH', mode: 'replace', query: 't.old_id', replace: 't.new_id' }]);
  });
});
