import { afterEach, describe, expect, it, vi } from 'vitest';
import { BmpClient, type EcResult } from '../bmp-client';
import { mockChromeStorage } from './chrome-mock';

const supported: EcResult = { ok: true, log: 'CREV_LOOKUP_SUPPORTED\nDuration : 1ms' };
// JavaCC reports an unknown built-in at the following method token, without
// mentioning lookup itself. Shape verified with an unknown function on BMP.
const syntaxMessage = 'Encountered " .WHENMISSING( " at line 1, column 10.\nWas expecting one of: <EOF>';
const unsupported: EcResult = {
  ok: false, hasError: true, log: syntaxMessage,
  outputEntries: [{ logType: 'ERROR', message: syntaxMessage, result: false }],
};

function makeClient() {
  mockChromeStorage();
  return new BmpClient('https://bmp.test/', 'admin', 'pass');
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('BMP lookup capability detection', () => {
  it.each([['Organisation', 'o'], ['User', 'u'], ['AccessPolicy', 'acpol'], ['ClassConfig', 'c']])(
    'guards legacy %s references against same-ID namespace collisions', async (type, prefix) => {
      const client = makeClient();
      client.assumeOldBmp();
      client.cache = { get: () => ({ businessId: '100', type }) };
      const ref = await client.resolveRef('9007199254740993');
      expect(ref).toContain(`LIST(${prefix}.get("100")).filter(str(rid) = "9007199254740993").first().whenMissing(error(`);
      expect(ref).not.toContain('lookup(');
    },
  );

  it('quotes legacy business IDs as data instead of EC source', async () => {
    const client = makeClient();
    client.assumeOldBmp();
    client.cache = { get: () => ({ businessId: 'id"with\\characters', type: 'User' }) };
    expect(await client.resolveRef('42')).toContain('u.get("id\\"with\\\\characters")');
  });

  it('cancels in-flight native identity reads and does not start the rest of a legacy batch', async () => {
    const client = makeClient();
    client.assumeOldBmp();
    const controller = new AbortController();
    const transport = (client as unknown as { transport: {
      sendCommands(commands: unknown[], operation: string, signal?: AbortSignal): Promise<ArrayBuffer>;
    } }).transport;
    const native = vi.spyOn(transport, 'sendCommands').mockImplementation(
      (...args: unknown[]) => new Promise((_resolve, reject) => {
        const signal = args[2] as AbortSignal;
        expect(signal).toBe(controller.signal);
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    );
    const execute = vi.spyOn(client, 'executeEc');
    const batch = client.batchEnrich(Array.from({ length: 25 }, (_, i) => String(i + 1)), controller.signal);
    const rejected = expect(batch).rejects.toThrow('Aborted');
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await rejected;
    expect(native).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute user code when its organisation context cannot be verified', async () => {
    const client = makeClient();
    client.assumeOldBmp();
    client.cache = { get: () => ({ businessId: '100', type: 'Organisation' }) };
    const send = vi.spyOn((client as any).transport, 'sendStreamingCommand').mockResolvedValue([
      { $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Identity mismatch' },
    ]);
    expect(await client.executeEc('this.org.change(name := "Changed")', '42', true))
      .toMatchObject({ ok: false, error: 'Identity mismatch' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('read');
  });

  it('shares one read-only probe across many simultaneous RID requests and caches success', async () => {
    const client = makeClient();
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValue(supported);
    const rids = Array.from({ length: 50 }, (_, i) => String(9007199254740993n + BigInt(i)));
    expect(await Promise.all(rids.map(rid => client.resolveRef(rid))))
      .toEqual(rids.map(rid => `lookup(${rid})`));
    await client.resolveRef('0');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2]).toBe(false);
  });

  it('uses the legacy identity path after a parser rejection, without a second probe', async () => {
    const client = makeClient();
    client.cache = { get: () => ({ businessId: 'form', type: 'InputView' }) };
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValue(unsupported);
    await expect(client.resolveRef('9007199254740993')).resolves.toContain('LIST(t.get("form")).filter(str(rid) = "9007199254740993").first()');
    await expect(client.resolveRef('42')).resolves.toContain('LIST(t.get("form")).filter(str(rid) = "42").first()');
    expect(client.supportsLookup).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not send lookup to known 5.5.4.9 engines', async () => {
    const client = makeClient();
    client.applyVersionFlags('5.5.4.9');
    client.cache = { get: () => ({ businessId: 'form', type: 'InputView' }) };
    const execute = vi.spyOn(client, 'executeEc');
    await expect(client.resolveRef('42')).resolves.toContain('LIST(t.get("form")).filter(str(rid) = "42").first()');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: 'BMP command authentication expired' },
    { ok: false, error: 'EC execution timed out (10s)' },
    { ok: false, hasError: true, error: 'Server unavailable' },
    { ok: true, log: '' },
    { ...supported, hasWarning: true },
  ] satisfies EcResult[])('does not misclassify a failed/ambiguous probe as an old engine: %j', async result => {
    vi.useFakeTimers();
    const client = makeClient();
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValue(result);
    await expect(client.resolveRef('42')).rejects.toThrow();
    await expect(client.resolveRef('43')).rejects.toThrow();
    expect(client.supportsLookup).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    execute.mockResolvedValue(supported);
    await expect(client.resolveRef('42')).resolves.toBe('lookup(42)');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale probe change the client after reconnect/reset', async () => {
    const client = makeClient();
    let finish!: (result: EcResult) => void;
    vi.spyOn(client, 'executeEc').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(unsupported);
    const pending = client.ensureLookupSupport();
    client.resetCapabilities();
    await expect(client.ensureLookupSupport()).resolves.toBe(false);
    finish(supported);
    await expect(pending).rejects.toThrow('reset');
    expect(client.supportsLookup).toBe(false);
  });

  it('honours a known version that arrives during the probe', async () => {
    const client = makeClient();
    let finish!: (result: EcResult) => void;
    vi.spyOn(client, 'executeEc').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = client.ensureLookupSupport();
    client.applyVersionFlags('5.5.4.9');
    finish(supported);
    await expect(pending).resolves.toBe(false);
  });

  it('reports native identity errors instead of replacing them with object not found', async () => {
    const client = makeClient();
    client.applyVersionFlags('5.5.4.9');
    const transport = (client as any).transport;
    vi.spyOn(transport, 'sendCommands').mockRejectedValue(new Error('BMP command authentication expired'));
    const result = await client.batchEnrich(['42', '43']);
    expect(result.results).toEqual({});
    expect(result.error).toContain('BMP command authentication expired');
    expect(result.error).not.toContain('not found');
  });

  it('does not hide a probe failure when version metadata arrives concurrently', async () => {
    const client = makeClient();
    let finish!: (result: EcResult) => void;
    vi.spyOn(client, 'executeEc').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = client.ensureLookupSupport();
    client.applyVersionFlags('5.5.4.9');
    finish({ ok: false, error: 'BMP command authentication expired' });
    await expect(pending).rejects.toThrow('authentication expired');
  });

  it('lets explicit reconnect retry an indeterminate probe immediately', async () => {
    const client = makeClient();
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValueOnce({ ok: false, error: 'Network failure' })
      .mockResolvedValue(supported);
    vi.spyOn(client.auth, 'retryAuthentication').mockResolvedValue();
    await expect(client.ensureLookupSupport()).rejects.toThrow('Network failure');
    await client.retryAuthentication();
    await expect(client.ensureLookupSupport()).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reads native identity from the binary response before generating legacy EC', async () => {
    const client = makeClient();
    client.applyVersionFlags('5.5.4.9');
    const transport = (client as any).transport;
    vi.spyOn(transport, 'sendCommands').mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(transport, 'deserializeStream').mockReturnValue([{
      $class: 'java.util.ArrayList', $elements: [{ response: {
        $class: 'com.corporater.bmp.dto.TreeNodeInformationDto',
        rid: { identifier: 9007199254740993n }, id: '121',
        type: { typeId: 'TextElement' }, text: 'Header',
      } }],
    }]);
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValue({
      ok: true, log: '9007199254740993|||121|||TextElement|||Header|||template_header',
    });
    const result = await client.batchEnrich(['9007199254740993']);
    expect(result.error).toBeUndefined();
    expect(result.results['9007199254740993']).toMatchObject({ businessId: '121', templateBusinessId: 'template_header' });
    expect(execute.mock.calls[0][0]).toContain('_o := LIST(t.get("121")).filter(str(rid) = "9007199254740993").first()');
    expect(execute.mock.calls[0][0]).not.toContain('lookup(');
  });

  it('keeps EC parser errors in enrichment diagnostics', async () => {
    const client = makeClient();
    client.applyVersionFlags('5.6.7.2');
    vi.spyOn(client, 'executeEc').mockResolvedValue(unsupported);
    expect((await client.batchEnrich(['42'])).error).toBe(syntaxMessage);
  });

  it('resolves the organisation context through the legacy path too', async () => {
    const client = makeClient();
    client.applyVersionFlags('5.5.4.9');
    client.cache = { get: () => ({ businessId: 'form', type: 'InputView' }) };
    const send = vi.spyOn((client as any).transport, 'sendStreamingCommand')
      .mockResolvedValueOnce(['ORG=9007199254740993']).mockResolvedValueOnce(['1']);
    await client.executeEc('1', '42');
    const [orgCommand, userCommand] = send.mock.calls.map(call => call[0] as any);
    expect(JSON.stringify(orgCommand, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value))
      .toContain(')).organisation.rid');
    expect(JSON.stringify(orgCommand, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value))
      .not.toContain('lookup(');
    expect(userCommand.context.orgRid.identifier).toBe(9007199254740993n);
  });
});
