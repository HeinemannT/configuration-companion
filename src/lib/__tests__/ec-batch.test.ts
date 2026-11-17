/** Several read-only EC scripts in one post (shape captured from a BMP server:
 *  [ProgressCancelKey, ExtendedExecuteResult] per command, in order). */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { BmpClient, splitEcResults } from '../bmp-client';
import { JavaEnum } from '../java-serial';

const KEY = { $class: 'com.corporater.bmp.base.system.progress.ProgressCancelKey' };
const entry = (type: string, message: string) => ({ $class: 'com.corporater.bmp.dto.command.extended.LogEntry', logType: new JavaEnum({} as never, type), message });
const result = (...entries: unknown[]) => ({
  $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
  entries: { $class: 'com.corporater.seq.SeqListImpl', delegate: { $class: 'java.util.ArrayList', $elements: entries } },
});

describe('splitEcResults', () => {
  it('gives every command its own result, a failing one included', () => {
    const [a, b] = splitEcResults([
      KEY, result(entry('ERROR', 'boom'), entry('MESSAGE', 'Result : ')),
      KEY, result(entry('MESSAGE', 'Result : B2')),
    ], 2);
    expect(a).toMatchObject({ ok: false, hasError: true });
    expect(b).toMatchObject({ ok: true, log: 'B2' });
  });

  it('trusts no command when the answer count does not match', () => {
    expect(splitEcResults([KEY, result(entry('MESSAGE', 'Result : A'))], 2))
      .toEqual([expect.objectContaining({ ok: false, errorKind: 'protocol' }), expect.objectContaining({ ok: false })]);
    expect(splitEcResults([{ $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'denied' }], 3)
      .map(r => r.error)).toEqual(['denied', 'denied', 'denied']);
  });
});

describe('BmpClient.executeEcBatch', () => {
  it('sends the scripts as one read-only post', async () => {
    mockChromeStorage();
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');
    const send = vi.fn(async () => [KEY, result(entry('MESSAGE', 'Result : 1')), KEY, result(entry('MESSAGE', 'Result : 2'))]);
    (client as unknown as { transport: { sendStreamingCommands: typeof send } }).transport.sendStreamingCommands = send;
    const results = await client.executeEcBatch(['1', '2']);
    expect(send).toHaveBeenCalledTimes(1);
    const [commands, intent] = send.mock.calls[0] as unknown as [Array<{ function: string; transactional: boolean }>, string];
    expect(commands.map(c => [c.function, c.transactional])).toEqual([['1', false], ['2', false]]);
    expect(intent).toBe('read');
    expect(results.map(r => r.log)).toEqual(['1', '2']);
  });

  it('reports a transport failure for every script', async () => {
    mockChromeStorage();
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');
    (client as unknown as { transport: { sendStreamingCommands(): Promise<never> } }).transport.sendStreamingCommands =
      async () => { throw new Error('Cannot reach BMP at https://bmp.test/'); };
    const results = await client.executeEcBatch(['1', '2']);
    expect(results.map(r => [r.ok, r.error])).toEqual([[false, 'Cannot reach BMP at https://bmp.test/'], [false, 'Cannot reach BMP at https://bmp.test/']]);
  });
});
