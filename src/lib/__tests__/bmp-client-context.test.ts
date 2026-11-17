/**
 * Context-object support is checked, not assumed (BmpClient
 * ensureContextSupport): once per connection the client asks for the RID of
 * the configuration root, then for `this.object`'s RID with that root as the
 * command's context. A server that answers with that RID runs the constant
 * readers; one that ignores the context gets the small text form of a reader
 * (`lookup(<RID>)`, at most 1,200 characters) or a clear "not supported"; a
 * connection failure decides nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import { JavaEnum } from '../java-serial';
import { mockChromeStorage } from './chrome-mock';
import { CONTEXT_OBJECT } from '../ec-parser';
import { buildContextSummaryEc } from '../object-summaries';
import { buildObjectPaneEc } from '../ec-codegen';
import { PANE_PROPS } from '../bmp-client';

const LOG_TYPE = { name: 'com.corporater.bmp.dto.command.extended.LogType', uid: 0n, flags: 0x10, fields: [], parent: null };
const answer = (message: string) => [{
  $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
  entries: { $class: 'java.util.ArrayList', $elements: [{ logType: new JavaEnum(LOG_TYPE as never, 'SHOW_RESULT'), message, time: null }], size: 1, length: 1 },
}];
const ROOT = '9223372036854775801';

/** A client whose server runs scripts as `serve` says. */
function client(serve: (code: string, objectRid: string | null) => any[] | Error) {
  mockChromeStorage();
  const c = new BmpClient('https://bmp.test/', 'admin', 'pass', 'ctx-test');
  c.applyVersionFlags('5.6.17.6');
  const sent: Array<{ code: string; objectRid: string | null }> = [];
  const one = async (cmd: any) => {
    const rid = cmd.context?.objectRid?.identifier;
    const objectRid = rid && rid !== 0n ? String(rid) : null;
    sent.push({ code: cmd.function, objectRid });
    const r = serve(cmd.function, objectRid);
    if (r instanceof Error) throw r;
    return r;
  };
  (c as any).transport = {
    sendStreamingCommand: vi.fn(one),
    sendStreamingCommands: vi.fn(async (cmds: any[]) => (await Promise.all(cmds.map(one))).flat()),
    formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    governor: { noteOverload: vi.fn() },
  };
  (c as any).auth = { sessionEpoch: 0, assertAuthEpoch: vi.fn() };
  return { c, sent };
}

const ROOT2 = '9223372036854775802';
const anchor = (code: string) => (code.includes('CTXA=') ? answer(`CTXA=${ROOT}|${ROOT2}|`) : null);
const serverError = (message: string) => [{ $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message }];

describe('context-object support', () => {
  it('a server that answers with the context object\'s RID runs the constant readers', async () => {
    const { c, sent } = client((code, rid) => anchor(code) ?? (code.includes('CTX=') ? answer(`CTX=${rid}|`) : answer('ok')));
    expect(await c.ensureContextSupport()).toBe(true);
    expect(c.contextCheck).toBe('supported');
    expect(sent.map(s => s.objectRid)).toEqual([null, ROOT]);
    // The anchors are model roots, never the customer root (BMP refuses it as a context).
    expect(sent[0].code).toContain('root.portal.rid');
    expect(sent[0].code).not.toMatch(/str\(root\.rid/);
    const r = await c.executeEcOn(buildContextSummaryEc(), '42');
    expect(r.ok).toBe(true);
    expect(sent.at(-1)).toEqual({ code: buildContextSummaryEc(), objectRid: '42' });
    // Asked once per connection, again after a reconnect.
    await c.ensureContextSupport();
    expect(sent.filter(s => s.code.includes('CTX')).length).toBe(2);
    c.resetCapabilities();
    await c.ensureContextSupport();
    expect(sent.filter(s => s.code.includes('CTX')).length).toBe(4);
  });

  it('a server that ignores the context gets the small text form, or a clear "not supported", never an empty answer', async () => {
    const { c, sent } = client((code) => anchor(code) ?? (code.includes('CTX=') ? answer('CTX=|') : answer('text form')));
    expect(await c.ensureContextSupport()).toBe(false);
    expect(c.contextCheck).toBe('ignored');
    const small = await c.executeEcOn(buildContextSummaryEc(), '42');
    expect(small).toMatchObject({ ok: true });
    expect(sent.at(-1)!.objectRid).toBeNull();
    expect(sent.at(-1)!.code).toContain('lookup(42)');
    expect(sent.at(-1)!.code).not.toContain('this.object');
    const before = sent.length;
    const big = await c.executeEcOn(buildObjectPaneEc(CONTEXT_OBJECT, PANE_PROPS), '42', undefined, undefined, 'object-pane' as never);
    expect(big).toMatchObject({ ok: false, errorKind: 'server', error: expect.stringMatching(/server version is not supported for the object-pane read/) });
    expect(sent.length).toBe(before);
    // The batched paths fall back the same way, object by object.
    const each = await c.executeEcEach(buildContextSummaryEc(), ['42', '43']);
    expect([...each.values()].every(r => r.ok)).toBe(true);
    expect(sent.slice(-2).map(s => s.code.includes('lookup(4'))).toEqual([true, true]);
  });

  it('an error on the first root (like the customer root) is undecided: the second root decides', async () => {
    const { c, sent } = client((code, rid) => anchor(code) ?? (code.includes('CTX=') ? (rid === ROOT ? serverError('CustomerRootImpl cannot be cast to BusinessTreeObject') : answer(`CTX=${rid}|`)) : answer('ok')));
    expect(await c.ensureContextSupport()).toBe(true);
    expect(c.contextCheck).toBe('supported');
    expect(sent.filter(s => s.code.includes('CTX=')).map(s => s.objectRid)).toEqual([ROOT, ROOT2]);
  });

  it('an answer with another RID means the server ignores the context', async () => {
    const { c } = client((code) => anchor(code) ?? (code.includes('CTX=') ? answer('CTX=12345|') : answer('ok')));
    expect(await c.ensureContextSupport()).toBe(false);
    expect(c.contextCheck).toBe('ignored');
  });

  it('when every root errors the check is not possible: reads go by context, nothing is claimed', async () => {
    const { c, sent } = client((code) => anchor(code) ?? (code.includes('CTX=') ? serverError('no') : answer('read by context')));
    expect(await c.ensureContextSupport()).toBe(true);
    expect(c.contextCheck).toBe('unchecked');
    const r = await c.executeEcOn(buildContextSummaryEc(), '42');
    expect(r.ok).toBe(true);
    expect(sent.at(-1)).toEqual({ code: buildContextSummaryEc(), objectRid: '42' });
  });

  it('a connection failure decides nothing', async () => {
    let down = true;
    const flaky = client((code, rid) => (down ? Object.assign(new Error('Cannot reach BMP'), { name: 'BmpTransportError', kind: 'network' }) : anchor(code) ?? (code.includes('CTX=') ? answer(`CTX=${rid}|`) : answer('ok'))));
    await expect(flaky.c.ensureContextSupport()).rejects.toThrow();
    expect(flaky.c.contextSupport).toBeNull();
    down = false;
    expect(await flaky.c.ensureContextSupport()).toBe(true);
  });
});
