/**
 * BMP's SearchCommand for the object-name search (search-command.ts,
 * object-name-command.ts, handlers/object-search.ts):
 *  - the request bytes, written out by hand from the record's definition
 *    (Java stream order: booleans, then fields, roots, searchFor, types);
 *  - a server-shaped answer written with JavaWriter, decoded through the
 *    real transport: hits with their TypeKey type and 64-bit RIDs intact,
 *    zero hits as only "END", a "local class incompatible" error;
 *  - the capability record: unknown → supported / unsupported / suspended,
 *    reset on reconnect, per server profile;
 *  - the handler: one command per query, the catalog path when the command
 *    is not supported (never both), the same rows and ranking on both paths,
 *    and no script text on the command path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaWriter, registerType, serializeCommands, SC_SERIALIZABLE, type JavaClassDesc } from '../java-serial';
import { BmpTransport } from '../bmp-transport';
import { makeTreeItemCommand } from '../bmp-types';
import {
  classifySearchFailure, CommandCapabilities, decodeSearchStream, makeSearchCommand, registerSearchCommand, ridLong,
  SEARCH_COMMAND_CLASS, SUSPEND_AFTER, SUSPEND_RETRY_MS, type SearchAnswer, type SearchCommandOptions,
} from '../search-command';
import { IDENTITY_SPARE_PER_TYPE, nameOfTreeText } from '../object-name-command';
import { CONFIG_TYPES, matchRank, mergeFound, SERVER_ROWS_PER_TYPE, type FoundObject } from '../object-search';
import { framedText } from '../ec-parser';
import { mockChromeStorage } from './chrome-mock';

// ── a byte builder for the expected request ─────────────────────

class Bytes {
  readonly b: number[] = [];
  u8(...xs: number[]) { this.b.push(...xs); return this; }
  u16(n: number) { return this.u8((n >> 8) & 0xff, n & 0xff); }
  u32(n: number) { return this.u8((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
  u64(n: bigint) { const v = BigInt.asUintN(64, n); return this.u32(Number(v >> 32n)).u32(Number(v & 0xffffffffn)); }
  utf(s: string) { const e = new TextEncoder().encode(s); return this.u16(e.length).u8(...e); }
  str(s: string) { return this.u8(0x74).utf(s); }
  ref(i: number) { return this.u8(0x71).u32(0x7e0000 + i); }
  desc(name: string, uid: bigint, flags: number, count: number, fields: (b: Bytes) => void, sup: (b: Bytes) => void = b => b.u8(0x70)) {
    this.u8(0x72).utf(name).u64(uid).u8(flags).u16(count);
    fields(this);
    this.u8(0x78);
    sup(this);
    return this;
  }
  field(type: string, name: string) { return this.u8(type.charCodeAt(0)).utf(name); }
}
const LONG_UID = 4290774380558885855n;
const NUMBER_UID = -8742448824652078965n;
const HASHSET_UID = -5024744406713321676n;

/** The hit class as the server writes it (descriptor for writing test answers). */
const HIT: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.command.repository.SearchResultElement', uid: 1n, flags: SC_SERIALIZABLE,
  fields: [
    { name: 'link', type: 'Z' },
    { name: 'parents', type: 'L', className: 'Ljava/util/List;' },
    { name: 'rid', type: 'L', className: 'Lcom/corporater/base/generation/system/Rid;' },
    { name: 'text', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'type', type: 'L', className: 'Lcom/corporater/base/generation/system/TypeKey;' },
  ],
  parent: null,
};
const SERVER_EXCEPTION: JavaClassDesc = {
  name: 'com.corporater.bmp.dto.ServerExceptionResponse', uid: 2n, flags: SC_SERIALIZABLE,
  fields: [{ name: 'message', type: 'L', className: 'Ljava/lang/String;' }], parent: null,
};
const rid = (r: string) => ({ $type: 'com.corporater.base.generation.system.Rid', identifier: BigInt(r) });
const typeKey = (t: string) => ({ $type: 'com.corporater.base.generation.system.TypeKey', typeId: t });
const hit = (r: string, text: string, type: string, parents: Array<{ r: string; text: string; type: string }> = []) => ({
  $type: HIT.name, link: false, rid: rid(r), text, type: typeKey(type),
  parents: { $type: 'java.util.ArrayList', $elements: parents.map(p => ({ $type: HIT.name, link: false, parents: null, rid: rid(p.r), text: p.text, type: typeKey(p.type) })) },
});

function answerBytes(objects: unknown[]): Uint8Array {
  const w = new JavaWriter();
  w.writeStreamHeader();
  for (const o of objects) {
    if (typeof o === 'string') w.writeString(o); else w.writeObject(o);
  }
  return w.toBytes();
}

function transportAnswering(bytes: () => Uint8Array) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes() as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/x-java-serialized-object' } })));
  const auth = {
    sessionEpoch: 0,
    getLoginTicket: vi.fn().mockResolvedValue('t'),
    refreshLoginTicket: vi.fn(),
    rejectCommandAuthentication: vi.fn(),
    fetchCommand: vi.fn(async (_t: string, init: RequestInit, consume: (r: Response) => Promise<unknown>) => consume(await fetch('https://bmp.search.test/cs/command', init))),
  };
  return new BmpTransport('https://bmp.search.test/', auth as never);
}

beforeAll(() => {
  registerSearchCommand();
  registerType({ desc: HIT });
  registerType({ desc: SERVER_EXCEPTION });
});
afterEach(() => vi.unstubAllGlobals());

const BIG = '9223372036854775807';
const ABOVE_2_53 = '9007199254740993';

describe('SearchCommand on the wire', () => {
  it('request bytes: a record, booleans first, then fields, roots, searchFor, types', () => {
    const e = new Bytes();
    e.u8(0xac, 0xed, 0x00, 0x05).u8(0x77, 0x04).u32(1);
    e.u8(0x73).desc(SEARCH_COMMAND_CLASS, 0n, 0x02, 7, b => {
      b.field('Z', 'exact').field('Z', 'links').field('Z', 'normal');
      b.field('L', 'fields').str('Ljava/util/Set;');
      b.field('L', 'roots').ref(1);
      b.field('L', 'searchFor').str('Ljava/lang/String;');
      b.field('L', 'types').ref(1);
    });
    e.u8(0x00, 0x01, 0x01);
    const set = (body: (b: Bytes) => void) => { e.u8(0x77, 12).u32(16).u8(0x3f, 0x40, 0x00, 0x00).u32(1); body(e); e.u8(0x78); };
    e.u8(0x73).desc('java.util.HashSet', HASHSET_UID, 0x03, 0, () => {});
    set(b => b.str('name'));
    e.u8(0x73).ref(4);
    // The root as a boxed long, written from its text: 2^63 - 1 exactly.
    set(b => b.u8(0x73).desc('java.lang.Long', LONG_UID, 0x02, 1, x => x.field('J', 'value'), x => x.desc('java.lang.Number', NUMBER_UID, 0x02, 0, () => {})).u64(BigInt(BIG)));
    e.str('risk');
    e.u8(0x73).ref(4);
    set(b => b.str('InputView'));
    expect([...serializeCommands([makeSearchCommand({ searchFor: 'risk', roots: [BIG], types: ['InputView'], fields: ['name'] })])]).toEqual(e.b);
  });

  it('refuses an empty type list, a bad type, and RIDs that are not 64-bit', () => {
    expect(() => makeSearchCommand({ searchFor: 'x', roots: ['1'], types: [], fields: ['name'] })).toThrow(/at least one type/);
    expect(() => makeSearchCommand({ searchFor: 'x', roots: ['1'], types: ['a b'], fields: ['name'] })).toThrow(/type name/);
    expect(() => ridLong('9223372036854775808')).toThrow(/out of range/);
    expect(ridLong(BIG)).toBe(9223372036854775807n);
  });

  it('round trip: hits with TypeKey types, parents and 64-bit RIDs, through the transport', async () => {
    const t = transportAnswering(() => answerBytes([
      hit(BIG, 'Risk view', 'InputView', [{ r: ABOVE_2_53, text: 'admin_area Administration', type: 'Area' }]),
      hit(ABOVE_2_53, 'Risk button', 'ButtonInput'),
      'END',
    ]));
    const objects = await t.sendStreamingCommand(makeSearchCommand({ searchFor: 'risk', roots: ['1'], types: ['InputView', 'ButtonInput'], fields: ['id', 'name'] }), 'read');
    const a = decodeSearchStream(objects);
    expect(a).toEqual({
      ok: true, complete: true, hits: [
        { rid: BIG, type: 'InputView', text: 'Risk view', link: false, parents: [{ rid: ABOVE_2_53, type: 'Area', text: 'admin_area Administration' }] },
        { rid: ABOVE_2_53, type: 'ButtonInput', text: 'Risk button', link: false, parents: [] },
      ],
    });
    // The gauge: SearchCommand and TreeItemCommand posts carry no script text.
    await t.sendCommands([makeTreeItemCommand(BIG)], 'read').catch(() => {});
    expect(t.governor.scriptLoad()).toMatchObject({ distinct: 0, distinctChars: 0 });
    expect(t.governor.recentPosts.map(p => p.op)).toEqual(expect.arrayContaining([expect.stringContaining('SearchCommand')]));
  });

  it('zero hits is a stream with only "END"; a cut stream is not complete', async () => {
    const t = transportAnswering(() => answerBytes(['END']));
    expect(decodeSearchStream(await t.sendStreamingCommand(makeSearchCommand({ searchFor: 'zz', roots: ['1'], types: ['InputView'], fields: ['id'] }), 'read'))).toEqual({ ok: true, hits: [], complete: true });
    expect(decodeSearchStream([{ $class: HIT.name, rid: { identifier: 5n }, text: 'x', type: { $class: 'com.corporater.base.generation.system.TypeKey', typeId: 'View' } }])).toMatchObject({ ok: true, complete: false });
  });

  it('a server that speaks another form of the command answers a recognisable error', async () => {
    const message = `${SEARCH_COMMAND_CLASS}; local class incompatible: stream classdesc serialVersionUID = 0, local class serialVersionUID = 77`;
    const t = transportAnswering(() => answerBytes([{ $type: SERVER_EXCEPTION.name, message }]));
    const a = decodeSearchStream(await t.sendStreamingCommand(makeSearchCommand({ searchFor: 'x', roots: ['1'], types: ['View'], fields: ['id'] }), 'read'));
    expect(a).toMatchObject({ ok: false, message });
    expect(classifySearchFailure(message)).toBe('unsupported');
    expect(classifySearchFailure(SEARCH_COMMAND_CLASS)).toBe('unsupported');
    expect(classifySearchFailure('java.lang.NullPointerException')).toBe('failed');
  });

  it('decodes the type from any TypeKey field of the hit, and an ID the hit may carry', () => {
    const a = decodeSearchStream([{ $class: HIT.name, rid: { identifier: 5n }, text: 'x', typeKey: { $class: 'com.corporater.base.generation.system.TypeKey', typeId: 'View' }, id: 'v1' }, 'END']);
    expect(a).toMatchObject({ ok: true, hits: [{ rid: '5', type: 'View', businessId: 'v1' }] });
    expect(nameOfTreeText('admin_area Administration', 'admin_area')).toBe('Administration');
    expect(nameOfTreeText('Risk view', 'risk_view')).toBe('Risk view');
  });
});

describe('capability record', () => {
  it('unknown → supported; unsupported stays for the connection; reset on reconnect', () => {
    const c = new CommandCapabilities();
    expect(c.get('p1', 's1', 'search')).toBe('unknown');
    expect(c.usable('p1', 's1', 'search')).toBe(true);
    c.record('p1', 's1', 'search', 'answered');
    expect(c.get('p1', 's1', 'search')).toBe('supported');
    c.record('p1', 's1', 'search', 'unsupported', 'local class incompatible');
    expect(c.usable('p1', 's1', 'search')).toBe(false);
    // Another profile is not touched; a new connection starts again.
    expect(c.get('p2', 's1', 'search')).toBe('unknown');
    expect(c.get('p1', 's2', 'search')).toBe('unknown');
  });

  it('suspended after repeated failures; one trial after 5 minutes; reset on reconnect', () => {
    const c = new CommandCapabilities();
    const t0 = 1_000_000;
    for (let i = 0; i < SUSPEND_AFTER - 1; i++) expect(c.record('p', 's', 'search', 'failed', undefined, t0)).toBe('unknown');
    expect(c.record('p', 's', 'search', 'failed', undefined, t0)).toBe('suspended');
    expect(c.usable('p', 's', 'search', t0 + 1)).toBe(false);
    // After SUSPEND_RETRY_MS one query may try; the next one waits again.
    expect(c.usable('p', 's', 'search', t0 + SUSPEND_RETRY_MS)).toBe(true);
    expect(c.usable('p', 's', 'search', t0 + SUSPEND_RETRY_MS + 1)).toBe(false);
    // The trial fails: suspended again for as long.
    expect(c.record('p', 's', 'search', 'failed', undefined, t0 + SUSPEND_RETRY_MS + 2)).toBe('suspended');
    expect(c.usable('p', 's', 'search', t0 + 2 * SUSPEND_RETRY_MS)).toBe(false);
    expect(c.usable('p', 's', 'search', t0 + 2 * SUSPEND_RETRY_MS + 2)).toBe(true);
    // The trial answers: supported.
    expect(c.record('p', 's', 'search', 'answered', undefined, t0 + 2 * SUSPEND_RETRY_MS + 3)).toBe('supported');
    // A new connection of the profile starts from unknown.
    c.record('p', 's', 'search', 'unsupported');
    expect(c.usable('p', 's+1', 'search')).toBe(true);
    // An answer between failures starts the count again.
    c.record('q', 's', 'search', 'failed');
    c.record('q', 's', 'search', 'answered');
    expect(c.record('q', 's', 'search', 'failed')).toBe('supported');
  });

  it('only a recognisable unknown or incompatible class is "unsupported"', () => {
    expect(classifySearchFailure(`${SEARCH_COMMAND_CLASS}; local class incompatible: stream classdesc serialVersionUID = 0`)).toBe('unsupported');
    expect(classifySearchFailure(SEARCH_COMMAND_CLASS)).toBe('unsupported');
    for (const m of ['HTTP 500', 'java.lang.NullPointerException', 'BMP returned an incomplete response', 'timed out']) expect(classifySearchFailure(m)).toBe('failed');
  });
});

describe('portal quick search keeps 64-bit RIDs', () => {
  it('reads the quick-search RID keys as exact text, by their whole name, arrays too', async () => {
    const { parseJsonKeepingRids, BmpClient } = await import('../bmp-client');
    expect(parseJsonKeepingRids(`{"rid":${ABOVE_2_53},"name":"x \\"rid\\": 1","n":12,"grid":${ABOVE_2_53},"tabRid":${BIG}}`))
      .toEqual({ rid: ABOVE_2_53, name: 'x "rid": 1', n: 12, grid: 9007199254740992, tabRid: BIG });
    expect(parseJsonKeepingRids(`{"rid":[${BIG}, ${ABOVE_2_53}],"webParentRid":null}`)).toEqual({ rid: [BIG, ABOVE_2_53], webParentRid: null });
    mockChromeStorage();
    // The payload as quickSearch's GraphQL answers it (QuickSearchHit).
    const body = `{"data":{"quickSearch":{"totalHits":1,"hits":[{"epmObject":{"rid":${ABOVE_2_53},"name":"Risk","type":"CeRisk","webParentRid":${BIG},"webParentName":"Area","hasChildren":false,"tabRid":null},"pageLocationInfo":{"rid":9007199254740995,"name":"Page"}}]}}}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
    const client = new BmpClient('https://bmp.quick.test/W/', 'u', 'p', 'profile-q', 'stored', '');
    const { objects, totalHits } = await client.quickSearch('risk');
    expect(totalHits).toBe(1);
    expect(objects[0]).toMatchObject({ rid: ABOVE_2_53, webParentRid: BIG, pageRid: '9007199254740995' });
  });
});

describe('the BmpClient reads of the command path, on a fake transport', () => {
  const treeItem = (rid: string, id: string, type: string, text: string) => ({
    $class: 'com.corporater.bmp.dto.integration.IntegrationObjectResponse',
    response: { $class: 'com.corporater.bmp.dto.TreeNodeInformationDto', rid: { identifier: BigInt(rid) }, id, type: { typeId: type }, text },
  });
  async function clientOn(transport: Record<string, unknown>) {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.fake.test/W/', 'u', 'p', 'profile-f', 'stored', '');
    (client as unknown as { transport: unknown }).transport = transport;
    return client;
  }

  it('runSearchCommands: two commands in one post, one answer each', async () => {
    const sent: unknown[][] = [];
    const client = await clientOn({
      sendStreamingCommands: vi.fn(async (commands: unknown[]) => {
        sent.push(commands);
        return [
          { $class: HIT.name, rid: { identifier: BigInt(BIG) }, text: 'Risk view', type: { $class: 'com.corporater.base.generation.system.TypeKey', typeId: 'InputView' } }, 'END',
          'END',
        ];
      }),
    });
    const base = { searchFor: 'risk', roots: ['1'], types: ['InputView'] };
    const answers = await client.runSearchCommands([{ ...base, fields: ['id'] }, { ...base, fields: ['name'] }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect((sent[0][0] as { fields: { $elements: string[] } }).fields.$elements).toEqual(['id']);
    expect(answers).toEqual([
      { ok: true, complete: true, hits: [{ rid: BIG, type: 'InputView', text: 'Risk view', link: false, parents: [] }] },
      { ok: true, complete: true, hits: [] },
    ]);
  });

  it('readTreeIdentities: TreeItemCommands, at most 200 a post; "-1" is no ID', async () => {
    const posts: number[] = [];
    const client = await clientOn({
      sendCommands: vi.fn(async (commands: Array<{ rid: { value: bigint } }>) => { posts.push(commands.length); return commands; }),
      deserializeStream: (commands: Array<{ rid: { value: bigint } }>) => [{ $class: 'java.util.ArrayList', $elements: commands.map(c => {
        const rid = String(c.rid.value);
        return rid === '7' ? treeItem(rid, '-1', 'Report', 'Some report') : treeItem(rid, `id_${rid}`, 'InputView', `id_${rid} Name ${rid}`);
      }) }],
    });
    const rids = [BIG, ...Array.from({ length: 250 }, (_, i) => String(i + 1))];
    const ids = await client.readTreeIdentities(rids);
    expect(posts).toEqual([200, 51]);
    expect(ids.get(BIG)).toEqual({ businessId: `id_${BIG}`, type: 'InputView', name: `id_${BIG} Name ${BIG}` });
    expect(ids.get('7')).toEqual({ type: 'Report', name: 'Some report' });
  });

  it('rootRidsById: GetPropertiesByIdCommand in the ROOT id space; a missing root is left out', async () => {
    const asked: Array<{ id: string; space: { name: string } }> = [];
    const client = await clientOn({
      sendCommands: vi.fn(async (commands: Array<{ id: string; space: { name: string } }>) => { asked.push(...commands); return commands; }),
      deserializeStream: (commands: Array<{ id: string }>) => [{ $class: 'java.util.ArrayList', $elements: commands.map((c, i) => ({
        $class: 'com.corporater.bmp.dto.integration.IntegrationObjectResponse',
        response: c.id === 'risk' ? null : { $entries: [['getRid', { identifier: 9_000_000_000_000_000_000n + BigInt(i) }], ['getTypeKey', { typeId: 'PortalRoot' }], ['getModel', { name: c.id.toUpperCase() }]] },
      })) }],
    });
    const { roots, complete } = await client.rootRidsById(['portal', 'page', 'risk']);
    expect(asked.map(c => [c.id, c.space.name])).toEqual([['portal', 'ROOT'], ['page', 'ROOT'], ['risk', 'ROOT']]);
    expect([...roots]).toEqual([['portal', { rid: '9000000000000000000', model: 'PORTAL' }], ['page', { rid: '9000000000000000001', model: 'PAGE' }]]);
    expect(complete).toBe(true);
  });
});

// ── the handler, on a fixture ──────────────────────────────────

interface Fx { rid: string; id: string; name: string; type: string }
const FIXTURE: Fx[] = [
  { rid: BIG, id: 'risk_view', name: 'Risk view', type: 'InputView' },
  { rid: ABOVE_2_53, id: 'x_risk', name: 'Other view', type: 'InputView' },
  { rid: '3', id: 'issue', name: 'Issue', type: 'InputView' },
  { rid: '4', id: 'btn_ok', name: 'Approve risk', type: 'ButtonInput' },
  { rid: '5', id: 'risk', name: 'Exact', type: 'ButtonInput' },
  { rid: '6', id: 'area_x', name: 'Risk area', type: 'Area' },
  // A type of a model the command's roots do not hold: the catalogs search it.
  { rid: '8', id: 'risk_report', name: 'Risk report', type: 'Report' },
  // Literal special characters, found only by the literal test.
  { rid: '9', id: 'a_star', name: 'a*b "q" c\\d e?f', type: 'InputView' },
];
const matches = (o: Fx, q: string) => o.name.toLowerCase().includes(q.toLowerCase()) || o.id.toLowerCase().includes(q.toLowerCase());
const ROOT_MODELS = ['PORTAL', 'PAGE', 'TEMPLATECATEGORY'];

function fakeClient(opts: { command?: 'ok' | 'unsupported' | 'failing' | 'http'; treeTextWithId?: boolean; identities?: 'ok' | 'fail'; extraHits?: number; partialRoots?: boolean } = {}) {
  const calls = { search: [] as SearchCommandOptions[][], ec: 0, identities: 0, roots: 0, identityRids: [] as string[] };
  const typeModels: Record<string, string[]> = Object.fromEntries([...CONFIG_TYPES, 'Area'].map(t => [t, ['PORTAL']]));
  typeModels.Report = ['DATA'];
  const extra = Array.from({ length: opts.extraHits ?? 0 }, (_, i) => ({ rid: String(1000 + i), id: `risk_${i}`, name: `Risk ${i}`, type: 'InputView' }));
  const all = [...FIXTURE, ...extra];
  const text = (x: Fx) => (opts.treeTextWithId ? `${x.id} ${x.name}` : x.name);
  const client = {
    serverUrl: 'https://bmp.fixture.test/W/',
    sessionEpoch: 0,
    onWrite: () => () => {},
    async executeEcBatch(codes: readonly string[]) {
      calls.ec += codes.length;
      return codes.map(code => {
        const rows: string[][] = [];
        for (const m of code.matchAll(/SELECT (\w+) FROM root/g)) {
          const list = all.filter(o => o.type === m[1]);
          rows.push(['#', m[1]], ...list.map(o => [o.rid, o.type, o.id, o.name]), ['N', String(list.length)]);
        }
        return { ok: true, log: framedText(rows) };
      });
    },
    async rootRidsById(keys: readonly string[]) {
      calls.roots++;
      const roots = new Map(keys.slice(0, 3).map((k, i) => [k, { rid: String(9_000_000_000_000_000_000n + BigInt(i)), model: ROOT_MODELS[i] }]));
      return { roots, complete: !opts.partialRoots };
    },
    async fetchTypeCatalogue() { return { types: {}, models: typeModels }; },
    async runSearchCommands(cmds: SearchCommandOptions[]): Promise<SearchAnswer[]> {
      calls.search.push(cmds);
      if (opts.command === 'http') throw new Error('quickSearch HTTP 502');
      if (opts.command === 'unsupported') return cmds.map(() => ({ ok: false, message: `${SEARCH_COMMAND_CLASS}; local class incompatible: stream classdesc serialVersionUID = 0` }));
      if (opts.command === 'failing') return cmds.map(() => ({ ok: false, message: 'java.lang.IllegalStateException: index closed' }));
      return cmds.map(o => {
        const types = new Set(o.types);
        const field = o.fields[0];
        // The index: substring per field; `*`/`?` would be wildcards there
        // (here: a hit that does not contain the query, which the literal
        // test must drop).
        const q = o.searchFor.toLowerCase();
        const hits = all.filter(x => types.has(x.type) && (field === 'id' ? x.id.includes(q) : x.name.toLowerCase().includes(q)));
        if (field === 'name') hits.push(FIXTURE[2]); // "Issue": the server's noise
        return { ok: true as const, complete: true, hits: hits.map(x => ({ rid: x.rid, type: x.type, text: text(x), link: false, parents: [] })) };
      });
    },
    async readTreeIdentities(rids: readonly string[]) {
      calls.identities++;
      calls.identityRids.push(...rids);
      if (opts.identities === 'fail') throw new Error('HTTP 500');
      return new Map(rids.map(r => { const x = all.find(o => o.rid === r)!; return [r, { businessId: x.id, type: x.type, name: text(x) }] as const; }));
    },
  };
  return { client, calls };
}

describe('object-name search: command first, catalogs as the fallback', () => {
  let getHandler: (type: string) => any;
  let caps: CommandCapabilities;
  const ask = async (client: unknown, query: string) => {
    const { setSwContext } = await import('../sw-context');
    setSwContext({ client, settings: { activeProfileId: 'profile-a' }, profileId: 'profile-a', settingsReady: Promise.resolve() } as never);
    let reply: any;
    await getHandler('OBJECT_SEARCH')({ type: 'OBJECT_SEARCH', query, channel: 't' }, (r: unknown) => { reply = r; }, { isOneShot: true });
    return reply as { ok: boolean; objects: FoundObject[]; via?: string; notice?: string };
  };

  beforeEach(async () => {
    vi.resetModules();
    mockChromeStorage();
    await import('../handlers/object-search');
    ({ getHandler } = await import('../handler-registry'));
    caps = (await import('../handlers/object-search')).searchCapabilities;
    caps.clear();
  });

  it('one post of two commands (id, name), types it covers, same rows and ranking as the catalogs', async () => {
    const cmd = fakeClient({ command: 'ok' });
    const viaCommand = await ask(cmd.client, 'risk');
    expect(viaCommand).toMatchObject({ ok: true, via: 'command' });
    expect(cmd.calls.search).toHaveLength(1);
    expect(cmd.calls.search[0].map(c => c.fields)).toEqual([['id'], ['name']]);
    expect(cmd.calls.identities).toBe(1);
    expect(cmd.calls.search[0][0].roots).toHaveLength(3);
    // Report's model is not under the command's roots: the catalogs search it.
    expect(cmd.calls.search[0][0].types).not.toContain('Report');
    // Organisation is a data type: left to the portal's search and the exact ID lookup.
    expect(cmd.calls.search[0][0].types).toEqual(expect.arrayContaining(CONFIG_TYPES.filter(t => t !== 'Report' && t !== 'Organisation')));
    expect(cmd.calls.search[0][0].types).not.toContain('Organisation');
    expect(cmd.calls.ec).toBeGreaterThan(0);
    // The catalog path on the same fixture.
    const cat = fakeClient({ command: 'unsupported' });
    const viaCatalog = await ask(cat.client, 'risk');
    expect(viaCatalog).toMatchObject({ ok: true, via: 'catalog' });
    // The same rows. Within a type each path keeps its server's order (the
    // index's, or SELECT's), so only rows of equal rank may change places.
    const byRid = (l: FoundObject[]) => [...l].sort((x, y) => x.rid.localeCompare(y.rid));
    expect(byRid(viaCommand.objects)).toEqual(byRid(viaCatalog.objects));
    const rankOf = (l: FoundObject[]) => mergeFound([], l, 'risk').map(o => matchRank(o, 'risk'));
    expect(rankOf(viaCommand.objects)).toEqual(rankOf(viaCatalog.objects));
    // Exact ID first, then prefixes, then contains; the server's noise is gone.
    const ranked = mergeFound([], viaCommand.objects, 'risk').map(o => o.rid);
    expect(ranked.slice(0, 3)).toEqual(['5', BIG, '8']);
    expect(new Set(ranked.slice(3))).toEqual(new Set([ABOVE_2_53, '4']));
    expect(viaCommand.objects.some(o => o.rid === '3' || o.type === 'Area')).toBe(false);
    expect(viaCommand.objects.map(o => o.rid)).toEqual(expect.arrayContaining([BIG, ABOVE_2_53]));
  });

  it('wildcards, quotes and backslashes: both paths give the same, literal answer', async () => {
    for (const q of ['a*b', 'e?f', '"q"', 'c\\d', 'ris*']) {
      const a = await ask(fakeClient({ command: 'ok' }).client, q);
      const b = await ask(fakeClient({ command: 'unsupported' }).client, q);
      expect(a.objects, q).toEqual(b.objects);
      for (const o of a.objects) expect(matches(o as unknown as Fx, q), q).toBe(true);
    }
    expect((await ask(fakeClient({ command: 'ok' }).client, 'a*b')).objects.map(o => o.rid)).toEqual(['9']);
  });

  it('a tree text with the ID in front gives the plain name', async () => {
    const r = await ask(fakeClient({ command: 'ok', treeTextWithId: true }).client, 'risk');
    expect(r.objects.find(o => o.rid === BIG)).toEqual({ rid: BIG, type: 'InputView', businessId: 'risk_view', name: 'Risk view' });
  });

  it('a cut is said: per type and in all; an ID-only hit is never cut for a name hit', async () => {
    const f = fakeClient({ command: 'ok', extraHits: 40 });
    const r = await ask(f.client, 'risk');
    // The command's rows are counted; the catalogs add Report's.
    expect(r.notice).toBe(`Showing the first ${r.objects.filter(o => o.type !== 'Report').length}. Type more to narrow.`);
    expect(r.objects.filter(o => o.type === 'InputView')).toHaveLength(25);
    // "x_risk" matches only by ID and is ranked with the name prefixes.
    expect(r.objects.map(o => o.rid)).toContain(ABOVE_2_53);
    // Only hits that can be shown are read: 25 rows of a type and a few spare.
    const inputViews = f.calls.identityRids.filter(rid => Number(rid) >= 1000 && Number(rid) < 2000);
    expect(inputViews.length).toBeLessThanOrEqual(SERVER_ROWS_PER_TYPE + IDENTITY_SPARE_PER_TYPE);
    expect(f.calls.identityRids).toContain(ABOVE_2_53);
  });

  it('the identity post fails: rows without an ID prefix in the name, a note, the failure counted', async () => {
    const f = fakeClient({ command: 'ok', identities: 'fail', treeTextWithId: true });
    const r = await ask(f.client, 'risk');
    expect(r.via).toBe('command');
    expect(r.notice).toContain('IDs could not be read');
    // "x_risk Other view" matched by ID only: the first word is its ID.
    expect(r.objects.find(o => o.rid === ABOVE_2_53)).toMatchObject({ businessId: 'x_risk', name: 'Other view' });
    expect(caps.failures('profile-a', '1|0', 'identity')).toBe(1);
  });

  it('any failure of the post: the catalogs answer the query, and it counts toward suspension', async () => {
    const f = fakeClient({ command: 'http' });
    const r = await ask(f.client, 'risk');
    expect(r).toMatchObject({ ok: true, via: 'catalog' });
    expect(r.objects.length).toBeGreaterThan(0);
    expect(caps.get('profile-a', '1|0', 'search')).toBe('unknown');
    await ask(f.client, 'risk2');
    expect(caps.get('profile-a', '1|0', 'search')).toBe('suspended');
  });

  it('unsupported: later queries go straight to the catalogs', async () => {
    const f = fakeClient({ command: 'unsupported' });
    expect((await ask(f.client, 'risk')).via).toBe('catalog');
    expect(caps.get('profile-a', '1|0', 'search')).toBe('unsupported');
    expect((await ask(f.client, 'issue')).via).toBe('catalog');
    expect(f.calls.search).toHaveLength(1);
  });

  it('repeated failures suspend the command until the profile reconnects', async () => {
    const f = fakeClient({ command: 'failing' });
    for (let i = 0; i < SUSPEND_AFTER; i++) expect((await ask(f.client, `risk${i}`)).via).toBe('catalog');
    await ask(f.client, 'risk9');
    expect(f.calls.search).toHaveLength(SUSPEND_AFTER);
    f.client.sessionEpoch = 1;
    await ask(f.client, 'risk10');
    expect(f.calls.search).toHaveLength(SUSPEND_AFTER + 1);
  });

  it('a partial root list is not kept: the next query asks again', async () => {
    const f = fakeClient({ command: 'ok', partialRoots: true });
    await ask(f.client, 'risk');
    await ask(f.client, 'risk2');
    expect(f.calls.roots).toBe(2);
    const g = fakeClient({ command: 'ok' });
    await ask(g.client, 'risk');
    await ask(g.client, 'risk2');
    expect(g.calls.roots).toBe(1);
  });

  it('a typical picker query is a small request', () => {
    const roots = Array.from({ length: 13 }, (_, i) => String(9_000_000_000_000_000_000n + BigInt(i)));
    const one = { searchFor: 'risk', roots, types: [...CONFIG_TYPES] };
    const bytes = serializeCommands([makeSearchCommand({ ...one, fields: ['id'] }), makeSearchCommand({ ...one, fields: ['name'] })]);
    expect(bytes.length).toBeLessThan(4_000);
  });
});
