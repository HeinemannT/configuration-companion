/**
 * parseInterceptorMessage — the shape guard at the `crev-interceptor`
 * CustomEvent boundary (plan 016). `document` is shared between the MAIN-
 * world interceptor and the page's own scripts, so a compromised/XSS'd BMP
 * page can dispatch a forged event on the same channel. This guard is an
 * ALLOWLIST: only the known message shapes survive; anything else — an
 * unknown `type`, a non-object `detail`, malformed fields — is dropped.
 */
import { describe, it, expect } from 'vitest';
import { parseInterceptorMessage, isRidShaped, sanitizePageObject, sanitizePageObjects, PAGE_OBJECTS_MAX, PAGE_TEXT_MAX } from '../validate-inbound';
import { mergeBmpObject } from '../merge';
import { ObjectCache } from '../object-cache';
import { hasCompleteIdentity } from '../enrichment';
import { mockChromeStorage } from './chrome-mock';
import type { BmpObject } from '../types';

const RID = '8639152947620';
const RID2 = '1234567890123';

function bmpObject(rid: string) {
  return { rid, source: 'fiber' as const, discoveredAt: 1, updatedAt: 1 };
}

describe('isRidShaped', () => {
  it('accepts long digit strings (BMP 64-bit longs)', () => {
    expect(isRidShaped(RID)).toBe(true);
    expect(isRidShaped('-1234567')).toBe(true);
  });

  it('rejects short numbers, non-strings, and non-numeric strings', () => {
    expect(isRidShaped('12345')).toBe(false); // 5 digits — below the 6-digit floor
    expect(isRidShaped(12345678)).toBe(false); // number, not string
    expect(isRidShaped('abc')).toBe(false);
    expect(isRidShaped(undefined)).toBe(false);
  });
});

describe('parseInterceptorMessage — OBJECTS_DISCOVERED', () => {
  // A page-reported object keeps its rid and page hints; timestamps are the receiver's.
  const page = (rid: string) => ({ rid, source: 'fiber', discoveredAt: expect.any(Number), updatedAt: expect.any(Number) });

  it('accepts a well-formed message', () => {
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [bmpObject(RID), bmpObject(RID2)] });
    expect(msg).toEqual({ type: 'OBJECTS_DISCOVERED', objects: [page(RID), page(RID2)] });
  });

  it('strips entries whose rid is not rid-shaped, keeping the real ones', () => {
    const forged = { rid: '1', name: 'forged' };
    const real = bmpObject(RID);
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [forged, real] });
    expect(msg).toEqual({ type: 'OBJECTS_DISCOVERED', objects: [page(RID)] });
  });

  it('drops non-object entries in the array', () => {
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [null, 'x', 42, bmpObject(RID)] });
    expect(msg).toEqual({ type: 'OBJECTS_DISCOVERED', objects: [page(RID)] });
  });

  it('returns null when objects is not an array', () => {
    expect(parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: 'not-an-array' })).toBeNull();
    expect(parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED' })).toBeNull();
  });
});

describe('page-detected objects carry page hints only', () => {
  it('keeps the whitelisted hints and drops every other field', () => {
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [{
      rid: RID, name: 'Risk', type: 'CeRisk', typename: 'Risk', businessId: 'r.1', webParentRid: RID2, hasChildren: true,
      identityEnriched: true, enrichedAt: 9e15, templateBusinessId: 'forged.template', source: 'server',
      cascade: { rid: RID2, name: 'forged' }, properties: { secret: 1 }, treePath: ['x'], pageName: 'forged',
    }] });
    const [object] = (msg as unknown as { objects: Record<string, unknown>[] }).objects;
    expect(Object.keys(object).sort()).toEqual(['businessId', 'discoveredAt', 'hasChildren', 'name', 'rid', 'source', 'type', 'typename', 'updatedAt', 'webParentRid']);
    expect(object.source).toBe('fiber');
    expect(object.identityEnriched).toBeUndefined();
    expect(object.enrichedAt).toBeUndefined();
  });

  it('drops over-long or non-string text instead of keeping it', () => {
    const long = 'x'.repeat(PAGE_TEXT_MAX + 1);
    const object = sanitizePageObject({ rid: RID, name: long, type: 42, businessId: '', webParentRid: 'not-a-rid', hasChildren: 'yes' }, 'dom');
    expect(object).toEqual({ rid: RID, source: 'dom', discoveredAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect(sanitizePageObject({ rid: RID, name: 'x'.repeat(PAGE_TEXT_MAX) }, 'dom')?.name).toHaveLength(PAGE_TEXT_MAX);
  });

  it('caps the size of one discovery batch', () => {
    const many = Array.from({ length: PAGE_OBJECTS_MAX + 50 }, (_, i) => ({ rid: String(10_000_000 + i) }));
    expect(sanitizePageObjects(many, 'dom')).toHaveLength(PAGE_OBJECTS_MAX);
  });
});

describe('a page cannot overwrite a server-read identity', () => {
  const server: BmpObject = {
    rid: RID, name: 'Real name', type: 'CeRisk', businessId: 'real.id', templateBusinessId: 'real.template',
    identityEnriched: true, enrichedAt: Date.now(), source: 'server', discoveredAt: 1, updatedAt: 1,
  };

  it('keeps every identity field of the server read, even ones it left empty', () => {
    const hostile = sanitizePageObject({ rid: RID, name: 'Forged', type: 'Forged', businessId: 'forged.id', typename: 'Forged' }, 'fiber')!;
    const merged = mergeBmpObject(server, hostile);
    expect(merged).toMatchObject({ name: 'Real name', type: 'CeRisk', businessId: 'real.id', templateBusinessId: 'real.template',
      identityEnriched: true, enrichedAt: server.enrichedAt, source: 'server' });
    expect(merged.typename).toBeUndefined();
  });

  it('ignores forged server markers on a raw page record', () => {
    const forged = { rid: RID2, name: 'Forged', identityEnriched: true, enrichedAt: 9e15, templateBusinessId: 't', source: 'dom', discoveredAt: Date.now(), updatedAt: 1 } as BmpObject;
    const cache = new ObjectCache('p');
    cache.put(forged);
    const stored = cache.get(RID2)!;
    expect(stored.identityEnriched).toBeUndefined();
    expect(stored.enrichedAt).toBeUndefined();
    expect(stored.templateBusinessId).toBeUndefined();
    expect(hasCompleteIdentity(stored)).toBe(false);
    // Merging the same forgery into a page record does not mark it enriched either.
    cache.put({ ...forged, name: 'Again' });
    expect(hasCompleteIdentity(cache.get(RID2))).toBe(false);
  });

  it('lets a later server read replace page hints', () => {
    const fromPage = sanitizePageObject({ rid: RID, name: 'Page name' }, 'dom')!;
    const merged = mergeBmpObject(fromPage, server);
    expect(merged).toMatchObject({ name: 'Real name', identityEnriched: true, source: 'server' });
  });

  it('the worker handler sanitizes a content-script batch the same way', async () => {
    mockChromeStorage();
    const cache = new ObjectCache('p');
    cache.put(server);
    const ctx = { cache, logActivity: () => {}, sendToPanel: () => {} };
    await import('../handlers/objects');
    const { getHandler } = await import('../handler-registry');
    await getHandler('OBJECTS_DISCOVERED')!({ type: 'OBJECTS_DISCOVERED', objects: [
      { rid: RID, name: 'Forged', businessId: 'forged', identityEnriched: true, source: 'server', discoveredAt: 1, updatedAt: 1 },
      { rid: RID2, name: 'y'.repeat(5_000), identityEnriched: true, enrichedAt: 9e15, source: 'server', discoveredAt: 1, updatedAt: 1 },
    ] } as never, () => {}, { isOneShot: false, ctx: ctx as never });
    expect(cache.get(RID)).toMatchObject({ name: 'Real name', businessId: 'real.id', source: 'server' });
    const second = cache.get(RID2)!;
    expect(second).toMatchObject({ rid: RID2, source: 'dom' });
    expect(second.name).toBeUndefined();
    expect(hasCompleteIdentity(second)).toBe(false);
  });
});

describe('parseInterceptorMessage — PAGE_CONTEXT', () => {
  it('accepts a well-formed message with both fields', () => {
    const msg = parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: RID, tabRid: RID2 });
    expect(msg).toEqual({ type: 'PAGE_CONTEXT', rid: RID, tabRid: RID2 });
  });

  it('accepts rid/tabRid absent (page with no bound object)', () => {
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT' })).toEqual({ type: 'PAGE_CONTEXT', rid: undefined, tabRid: undefined });
  });

  it('returns null for a non-rid-shaped rid', () => {
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: 'not-a-rid' })).toBeNull();
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: '123' })).toBeNull();
  });

  it('returns null for a non-rid-shaped tabRid even when rid is valid', () => {
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: RID, tabRid: 'forged' })).toBeNull();
  });
});

describe('parseInterceptorMessage — EDIT_PAGE_CONTEXT', () => {
  it('accepts a validated edit context and an explicit clear', () => {
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, parentRid: RID2, objectType: 'CeProcedure' },
    })).toEqual({
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        editPageRid: RID,
        initializerRid: undefined,
        templateRid: undefined,
        webParentRid: undefined,
        parentRid: RID2,
        objectRid: undefined,
        objectName: undefined,
        objectType: 'CeProcedure',
      },
    });
    expect(parseInterceptorMessage({ type: 'EDIT_PAGE_CONTEXT' })).toEqual({ type: 'EDIT_PAGE_CONTEXT' });
  });

  it('rejects forged edit-page RIDs', () => {
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, initializerRid: 'bad' },
    })).toBeNull();
  });

  it('validates rendered edit-field metadata without accepting arbitrary payloads', () => {
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        editPageRid: RID,
        fields: [{
          kind: 'info',
          key: 4,
          objectRef: '7808624541928645082',
          displayName: 'Obligation Text',
          pageIndex: 0,
          columnIndex: 0,
        }],
      },
    })).toMatchObject({
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        fields: [{
          kind: 'info',
          key: 4,
          objectRef: '7808624541928645082',
          displayName: 'Obligation Text',
        }],
      },
    });
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, fields: [{ key: -1 }] },
    })).toBeNull();
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, fields: [{ kind: 'info', objectRef: 'not-a-rid' }] },
    })).toBeNull();
  });
});

describe('parseInterceptorMessage — BMP_SIGNALS_RESULT', () => {
  it('accepts a well-formed message', () => {
    const msg = parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: ['window.Highcharts', '__CORPORATER__ global'] });
    expect(msg).toEqual({ type: 'BMP_SIGNALS_RESULT', signals: ['window.Highcharts', '__CORPORATER__ global'] });
  });

  it('accepts an empty signals array', () => {
    expect(parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: [] })).toEqual({ type: 'BMP_SIGNALS_RESULT', signals: [] });
  });

  it('returns null when signals is not an array of strings', () => {
    expect(parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: 'nope' })).toBeNull();
    expect(parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: [1, 2] })).toBeNull();
  });
});

describe('parseInterceptorMessage — allowlist boundary', () => {
  it('returns null for an unknown type', () => {
    expect(parseInterceptorMessage({ type: 'SOMETHING_FORGED', objects: [] })).toBeNull();
  });

  it('returns null for a non-object detail', () => {
    expect(parseInterceptorMessage(null)).toBeNull();
    expect(parseInterceptorMessage(undefined)).toBeNull();
    expect(parseInterceptorMessage('string')).toBeNull();
    expect(parseInterceptorMessage(42)).toBeNull();
  });

  it('returns null for an object with no type', () => {
    expect(parseInterceptorMessage({ objects: [] })).toBeNull();
  });
});
