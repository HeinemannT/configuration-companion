// @vitest-environment happy-dom
/**
 * Data-safety and silent-failure regressions in the server query layer:
 * a failed or cut-off read must be an error, never an empty success, and a
 * batched read must keep what it already read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './chrome-mock';
import { BmpTransport } from '../bmp-transport';
import { JavaWriter, deserializeStreamResult } from '../java-serial';
import { makeExtendedExecuteCommand, registerBmpTypes } from '../bmp-types';
import { EcQueryService } from '../ec-query-service';
import type { EcResult } from '../bmp-client';
import { createEcFrame, framedBlocks, parseSepBlocks, STATIC_EC_FRAME } from '../ec-parser';
import { isObjectLevelError, readIsolating } from '../batch-isolate';
import { BmpRequestError, errorKindOf } from '../error-kind';
import { openObjectRoot, readObjectsIsolating, ROOT_FALLBACK_NOTE, type ObjectReader, type FullObjectsRead } from '../object-window';
import { parseStructureRows, STRUCTURE_MAX_NODES } from '../object-structure';
import { fullObjectFromPane, type FullObject } from '../object-read';
import { copyWithFeedback } from '../copy-feedback';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const service = (result: EcResult | ((code: string) => EcResult)) => new EcQueryService(
  async code => (typeof result === 'function' ? result(code) : result),
  async rid => `lookup(${rid})`,
  [],
);

// ── Item 1: code reads ──────────────────────────────────────────────

describe('fetchCodeViaEc never reports a failed read as empty code', () => {
  it('throws on an EC failure (before: returned {} and STUDIO_FETCH_CODE said ok)', async () => {
    await expect(service({ ok: false, error: 'Server exploded' }).fetchCodeViaEc('1', ['html']))
      .rejects.toMatchObject({ message: 'Server exploded', kind: 'server' });
  });

  it('throws on a cut-off log without the completion marker', async () => {
    await expect(service({ ok: true, log: framedBlocks({ html: '<div>half' }, false) }).fetchCodeViaEc('1', ['html']))
      .rejects.toMatchObject({ kind: 'protocol' });
    await expect(service({ ok: true, log: '' }).fetchCodeViaEc('1', ['html'])).rejects.toThrow(/incomplete/i);
  });

  it('keeps the transport kind (not signed in) on the thrown error', async () => {
    await expect(service({ ok: false, error: 'BMP rejected portal-session authentication', errorKind: 'not-signed-in' }).fetchCodeViaEc('1', ['html']))
      .rejects.toMatchObject({ kind: 'not-signed-in' });
  });

  it('returns the stored code, including a leading blank line, when complete', async () => {
    const code = '\n<div>|||\nsecond</div>\n';
    const log = framedBlocks({ html: code });
    expect(await service({ ok: true, log }).fetchCodeViaEc('1', ['html'])).toEqual({ html: code });
  });

  it('fetchEditorContext throws on failure and on a cut-off answer instead of returning null', async () => {
    await expect(service({ ok: false, error: 'Timed out', errorKind: 'timeout' }).fetchEditorContext('1'))
      .rejects.toMatchObject({ kind: 'timeout' });
    await expect(service({ ok: true, log: framedBlocks({ instRid: '1', inst_expression: 'x := 1' }, false) }).fetchEditorContext('1'))
      .rejects.toThrow(/incomplete/i);
  });
});

describe('parseSepBlocks', () => {
  it('keeps leading and trailing line breaks that belong to the stored text', () => {
    expect(parseSepBlocks(framedBlocks({ a: '\nfirst\n\n' }))).toEqual({ a: '\nfirst\n\n' });
  });

  it('uses one constant frame, without angle brackets', () => {
    const a = createEcFrame();
    const b = createEcFrame();
    expect(a).toEqual(b);
    expect(a).toBe(STATIC_EC_FRAME);
    // No angle brackets: BMP treats such markers as HTML in a growing string.
    for (const marker of [a.row, a.done]) expect(marker).not.toMatch(/[<>]/);
    expect(a.row.includes(a.done) || a.done.includes(a.row)).toBe(false);
  });
});

// ── Item 2: truncated streams ───────────────────────────────────────

function truncatedStream(): Uint8Array {
  const w = new JavaWriter();
  w.writeStreamHeader();
  w.writeString('first-object');
  w.writeString('second-object-that-is-cut-off');
  const bytes = w.toBytes();
  return bytes.slice(0, bytes.length - 6);
}

describe('truncated EC streams', () => {
  it('deserializeStreamResult reports the decode failure', () => {
    const bytes = truncatedStream();
    const r = deserializeStreamResult(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(r.objects).toEqual(['first-object']);
    expect(r.error).toBeInstanceOf(Error);
  });

  it('sendStreamingCommand throws a protocol error instead of returning the first objects (before: ok with an empty log)', async () => {
    registerBmpTypes();
    const bytes = truncatedStream();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/x-java-serialized-object' } })));
    const auth = {
      sessionEpoch: 0,
      getLoginTicket: vi.fn().mockResolvedValue('t'),
      refreshLoginTicket: vi.fn(),
      rejectCommandAuthentication: vi.fn(),
      fetchCommand: vi.fn(async (_t: string, init: RequestInit, consume: (r: Response) => Promise<unknown>) => consume(await fetch('https://bmp.test/cs/command', init))),
    };
    const transport = new BmpTransport('https://bmp.test/', auth as never);
    await expect(transport.sendStreamingCommand(makeExtendedExecuteCommand('1'), 'read'))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/incomplete/i) });
  });
});

// ── Item 6: partial chunks and the connection-error pattern ────────

const obj = (rid: string, type = 'Scorecard'): FullObject => ({ rid, type, name: `N${rid}`, businessId: `b${rid}`, props: {}, references: {}, overridden: [] });

describe('readObjectsIsolating', () => {
  it('re-reads only the rejected chunk, not the chunks already read', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(1000 + i));
    const bad = ids[180];
    const calls: string[][] = [];
    // A reader that behaves like BmpClient.readFullObjects: 100 per chunk,
    // a chunk with the bad id is rejected whole.
    const reader: ObjectReader = {
      fetchStructureRows: vi.fn(),
      readFullObjects: async (rids): Promise<FullObjectsRead> => {
        calls.push([...rids]);
        const out: FullObjectsRead = { objects: {}, errors: {} };
        for (let i = 0; i < rids.length; i += 100) {
          const chunk = rids.slice(i, i + 100);
          if (chunk.includes(bad)) {
            (out.failedChunks ??= []).push({ rids: [...chunk], error: 'ClassCastException in session handler' });
            for (const r of chunk) out.errors[r] = 'ClassCastException in session handler';
          } else for (const r of chunk) out.objects[r] = obj(r);
        }
        return out;
      },
    };
    const r = await readObjectsIsolating(reader, ids);
    expect(Object.keys(r.objects)).toHaveLength(249);
    expect(r.errors).toEqual({ [bad]: 'ClassCastException in session handler' });
    // The first call reads everything; later calls only touch the bad chunk.
    const later = calls.slice(1).flat();
    expect(later.every(id => ids.indexOf(id) >= 100 && ids.indexOf(id) < 200)).toBe(true);
  });
});

describe('isObjectLevelError', () => {
  it('splits object errors that mention session, environment or login', () => {
    for (const m of [
      'ClassCastException: SessionScopedBean cannot be cast',
      'Object belongs to another environment configuration',
      'NullPointerException in LoginPageConfig',
    ]) expect(isObjectLevelError(new Error(m))).toBe(true);
  });

  it('still treats real connection errors as not splittable', () => {
    for (const m of [
      'Not connected to BMP',
      'The active BMP environment changed after this view was opened. Reload this view before saving.',
      'BMP at https://x/ timed out',
      'Cannot reach BMP at https://x/',
      'BMP rejected portal-session authentication at /cs/command (HTTP 401). The command was not retried.',
      'Permission denied (403)',
      'BMP connection changed. The previous request was cancelled.',
    ]) expect(isObjectLevelError(new Error(m))).toBe(false);
    expect(isObjectLevelError(new BmpRequestError('anything', 'network'))).toBe(false);
  });

  it('readIsolating halves on an object error that mentions "session"', async () => {
    const res = await readIsolating(['1', '2', '3', '4'], async batch => {
      if (batch.includes('3')) throw new Error('Session attribute cast failed');
      return batch;
    });
    expect(res.failed).toEqual({ 3: 'Session attribute cast failed' });
  });
});

// ── Item 7: error kinds ─────────────────────────────────────────────

describe('error kinds', () => {
  it('maps transport kinds to the user-facing kinds', () => {
    const e = Object.assign(new Error('x'), { name: 'BmpTransportError', kind: 'auth' });
    expect(errorKindOf(e)).toBe('not-signed-in');
    expect(errorKindOf(Object.assign(new Error('x'), { name: 'BmpTransportError', kind: 'http' }))).toBe('server');
    expect(errorKindOf(new DOMException('t', 'TimeoutError'))).toBe('timeout');
    expect(errorKindOf(new Error('plain'))).toBeUndefined();
  });
});

// ── Item 8: structure cap ──────────────────────────────────────────

describe('structure listing cap', () => {
  const log = (n: number) => Array.from({ length: n }, (_, i) => `${10_000 + i}|||1`).join('\n');

  it('reports the cut when the listing has more nodes than the cap', () => {
    const rows = parseStructureRows(log(STRUCTURE_MAX_NODES + 5));
    expect(rows).toHaveLength(STRUCTURE_MAX_NODES);
    expect(rows.truncated).toBe(true);
  });

  it('does not report a cut at exactly the cap', () => {
    expect(parseStructureRows(log(STRUCTURE_MAX_NODES)).truncated).toBeUndefined();
  });

  it('openObjectRoot passes the cut to the window and Browse', async () => {
    const rows = parseStructureRows(log(STRUCTURE_MAX_NODES + 1));
    const reader: ObjectReader = {
      readFullObjects: async rids => ({ objects: Object.fromEntries(rids.map(r => [r, obj(r, r === '1' ? 'InputView' : 'Scorecard')])), errors: {} }),
      fetchStructureRows: async () => rows,
    };
    const p = await openObjectRoot(reader, '1', 'InputView');
    expect(p.structureTruncatedAt).toBe(STRUCTURE_MAX_NODES);
  });
});

// ── Item 10: binary read fails on older servers ────────────────────

describe('openObjectRoot fallback for a failing binary root read', () => {
  const pane = {
    instance: { rid: '1', businessId: 'old_kpi', name: 'Old KPI', type: 'Scorecard' },
    parent: { rid: '9', businessId: 'p', name: 'Parent', type: 'Organisation' },
    template: null, card: null, isPropertyDefinition: false,
    instanceProps: { headerColor: 'blue', visible: 'true', width: '' }, templateProps: {}, instanceOverrideProps: [],
    siblings: [], siblingTotal: 0, codeFields: { expression: 'x := 1' }, references: {},
    indirectCode: {}, indirectCodeRids: {}, contextValues: {}, gateValues: {}, lists: {},
  };

  it('opens with identity and known properties when the server rejects the binary read', async () => {
    const readRootFallback = vi.fn(async () => fullObjectFromPane(pane as never));
    const reader: ObjectReader = {
      readFullObjects: async rids => ({
        objects: {},
        errors: Object.fromEntries(rids.map(r => [r, 'NullPointerException in IntegrationGetObjectCommand'])),
        failedChunks: [{ rids: [...rids], error: 'NullPointerException in IntegrationGetObjectCommand' }],
      }),
      fetchStructureRows: async () => [],
      readRootFallback,
    };
    const p = await openObjectRoot(reader, '1');
    expect(readRootFallback).toHaveBeenCalledWith('1', undefined);
    expect(p.root).toMatchObject({ rid: '1', name: 'Old KPI', businessId: 'old_kpi', type: 'Scorecard' });
    expect(p.root.props.headerColor.text).toBe('blue');
    expect(p.root.props.visible).toMatchObject({ kind: 'boolean', bool: true });
    expect(p.root.props.expression).toMatchObject({ kind: 'code', text: 'x := 1' });
    expect(p.root.props.width).toBeUndefined();
    expect(p.root.references.parent).toEqual(['9']);
    expect(p.rootFallback).toBe(ROOT_FALLBACK_NOTE);
  });

  it('also falls back when the type hint path reads the root in the batch', async () => {
    const reader: ObjectReader = {
      readFullObjects: async rids => ({
        objects: Object.fromEntries(rids.filter(r => r !== '1').map(r => [r, obj(r)])),
        errors: (rids.includes('1') ? { 1: 'NullPointerException' } : {}) as Record<string, string>,
      }),
      fetchStructureRows: async () => [{ rid: '2', parent: '1' }],
      readRootFallback: async () => fullObjectFromPane(pane as never),
    };
    const p = await openObjectRoot(reader, '1', 'InputView');
    expect(p.root.name).toBe('Old KPI');
    expect(p.nodes['2']).toBeDefined();
    expect(p.rootFallback).toBe(ROOT_FALLBACK_NOTE);
  });

  it('does not use the fallback for a connection error', async () => {
    const readRootFallback = vi.fn();
    const reader: ObjectReader = {
      readFullObjects: async () => { throw new BmpRequestError('Cannot reach BMP at https://x/', 'network'); },
      fetchStructureRows: async () => [],
      readRootFallback,
    };
    await expect(openObjectRoot(reader, '1')).rejects.toThrow(/Cannot reach/);
    expect(readRootFallback).not.toHaveBeenCalled();
  });

  it('does not use the fallback for an object that does not exist', async () => {
    const readRootFallback = vi.fn();
    const reader: ObjectReader = {
      readFullObjects: async () => ({ objects: {}, errors: {} }),
      fetchStructureRows: async () => [],
      readRootFallback,
    };
    await expect(openObjectRoot(reader, '1')).rejects.toThrow(/not found/i);
    expect(readRootFallback).not.toHaveBeenCalled();
  });
});

// ── Item 9: copy feedback ──────────────────────────────────────────

describe('copyWithFeedback', () => {
  it('shows "Copied" only after the write succeeded', async () => {
    vi.useFakeTimers();
    const target = document.createElement('span');
    target.textContent = 'abc';
    let resolveWrite!: (ok: boolean) => void;
    const pending = copyWithFeedback('abc', target, { textTarget: target, write: () => new Promise(r => { resolveWrite = r; }) });
    expect(target.textContent).toBe('abc'); // not yet
    resolveWrite(true);
    await pending;
    expect(target.textContent).toBe('Copied');
    vi.runAllTimers();
    expect(target.textContent).toBe('abc');
  });

  it('shows "Copy failed" when the write fails', async () => {
    vi.useFakeTimers();
    const button = document.createElement('button');
    const ok = await copyWithFeedback('abc', button, { okClass: 'copied', failClass: 'copy-failed', write: async () => false });
    expect(ok).toBe(false);
    expect(button.classList.contains('copy-failed')).toBe(true);
    expect(button.classList.contains('copied')).toBe(false);
    expect(button.getAttribute('title')).toBe('Copy failed: the browser blocked clipboard access.');
    vi.runAllTimers();
    expect(button.classList.contains('copy-failed')).toBe(false);
  });
});
