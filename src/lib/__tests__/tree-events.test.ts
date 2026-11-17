/**
 * The change feed's command on the wire (tree-events.ts):
 *  - the request bytes, written out by hand from the record's definition
 *    (one primitive long, serialVersionUID 0);
 *  - server-shaped answers written with the repo's JavaWriter and decoded
 *    through the real transport: packs with 64-bit pack ids and RIDs intact
 *    (above 2^53), every event kind, the empty answer, an error;
 *  - the capability record of the feed (unknown → supported / unsupported /
 *    suspended), per server profile and connection.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JavaWriter, registerType, serializeCommands, SC_SERIALIZABLE, type JavaClassDesc } from '../java-serial';
import { BmpTransport } from '../bmp-transport';
import { classifyTreeEventFailure, decodeTreeEvents, makeTreeEventCommand, registerTreeEventCommand, TREE_EVENT_COMMAND_CLASS } from '../tree-events';
import { CommandCapabilities, SUSPEND_AFTER, SUSPEND_RETRY_MS } from '../search-command';

class Bytes {
  readonly b: number[] = [];
  u8(...xs: number[]) { this.b.push(...xs); return this; }
  u16(n: number) { return this.u8((n >> 8) & 0xff, n & 0xff); }
  u32(n: number) { return this.u8((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
  u64(n: bigint) { const v = BigInt.asUintN(64, n); return this.u32(Number(v >> 32n)).u32(Number(v & 0xffffffffn)); }
  utf(s: string) { const e = new TextEncoder().encode(s); return this.u16(e.length).u8(...e); }
}

const EV = 'com.corporater.bmp.dto.command.tree.events';
const LONG = (name: string) => ({ name, type: 'L' as const, className: 'Ljava/lang/Long;' });
const LIST = (name: string) => ({ name, type: 'L' as const, className: 'Ljava/util/List;' });
const PACK: JavaClassDesc = {
  name: `${EV}.TreeEventPack`, uid: -9207469078851816763n, flags: SC_SERIALIZABLE,
  fields: [{ name: 'packId', type: 'J' }, { name: 'propertiesChanged', type: 'Z' }, LIST('addEvents'), LIST('deleteEvents'), LIST('relocateEvents'), LIST('reorderEvents'), LIST('updateEvents')],
  parent: null,
};
const UPDATE: JavaClassDesc = { name: `${EV}.TreeNodeUpdateEvent`, uid: 0n, flags: SC_SERIALIZABLE, fields: [LONG('rid')], parent: null };
const DELETE: JavaClassDesc = { name: `${EV}.TreeNodeDeleteEvent`, uid: 0n, flags: SC_SERIALIZABLE, fields: [LONG('rid')], parent: null };
const ADDED: JavaClassDesc = { name: `${EV}.TreeNodeAddedEvent`, uid: 0n, flags: SC_SERIALIZABLE, fields: [LONG('parentRid'), LONG('rid')], parent: null };
const RELOCATE: JavaClassDesc = { name: `${EV}.TreeNodeRelocateEvent`, uid: 0n, flags: SC_SERIALIZABLE, fields: [LONG('oldParentId'), LONG('parentRid'), LONG('rid')], parent: null };
const REORDER: JavaClassDesc = { name: `${EV}.TreeNodeReorderEvent`, uid: 0n, flags: SC_SERIALIZABLE, fields: [{ name: 'childRids', type: 'L', className: 'Ljava/util/List;' }, LONG('parentRid')], parent: null };
const RESPONSE: JavaClassDesc = { name: 'com.corporater.bmp.dto.response.IntegrationObjectResponse', uid: 1698316271062164157n, flags: SC_SERIALIZABLE, fields: [{ name: 'response', type: 'L', className: 'Ljava/lang/Object;' }], parent: null };
const SERVER_EXCEPTION: JavaClassDesc = { name: 'com.corporater.bmp.dto.ServerExceptionResponse', uid: 2n, flags: SC_SERIALIZABLE, fields: [{ name: 'message', type: 'L', className: 'Ljava/lang/String;' }], parent: null };

const long = (v: string) => ({ $type: 'java.lang.Long', value: BigInt(v) });
const list = (xs: unknown[]) => ({ $type: 'java.util.ArrayList', $elements: xs });
const pack = (id: string, o: { update?: string[]; del?: string[]; add?: Array<[string, string]>; move?: Array<[string, string, string]>; reorder?: string[]; props?: boolean } = {}) => ({
  $type: PACK.name, packId: BigInt(id), propertiesChanged: !!o.props,
  addEvents: list((o.add ?? []).map(([parent, rid]) => ({ $type: ADDED.name, parentRid: long(parent), rid: long(rid) }))),
  deleteEvents: list((o.del ?? []).map(r => ({ $type: DELETE.name, rid: long(r) }))),
  relocateEvents: list((o.move ?? []).map(([rid, parent, old]) => ({ $type: RELOCATE.name, oldParentId: long(old), parentRid: long(parent), rid: long(rid) }))),
  reorderEvents: list((o.reorder ?? []).map(p => ({ $type: REORDER.name, childRids: list([]), parentRid: long(p) }))),
  updateEvents: list((o.update ?? []).map(r => ({ $type: UPDATE.name, rid: long(r) }))),
});
/** The answer as the server writes it: an ArrayList of one response that
 *  holds the list of packs. */
export function feedAnswerBytes(packs: unknown[]): Uint8Array {
  const w = new JavaWriter();
  w.writeStreamHeader();
  w.writeObject(list([{ $type: RESPONSE.name, response: list(packs) }]));
  return w.toBytes();
}

function transportAnswering(bytes: () => Uint8Array) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes() as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/x-java-serialized-object' } })));
  const auth = {
    sessionEpoch: 0,
    getLoginTicket: vi.fn().mockResolvedValue('t'),
    refreshLoginTicket: vi.fn(),
    rejectCommandAuthentication: vi.fn(),
    fetchCommand: vi.fn(async (_t: string, init: RequestInit, consume: (r: Response) => Promise<unknown>) => consume(await fetch('https://bmp.feed.test/cs/command', init))),
  };
  return new BmpTransport('https://bmp.feed.test/', auth as never);
}

beforeAll(() => {
  registerTreeEventCommand();
  for (const d of [PACK, UPDATE, DELETE, ADDED, RELOCATE, REORDER, RESPONSE, SERVER_EXCEPTION]) registerType({ desc: d });
});
afterEach(() => vi.unstubAllGlobals());

const ABOVE_2_53 = '9007199254740993';
const BIG = '9223372036854775807';

describe('TreeEventCommand on the wire', () => {
  it('request bytes: a record with one primitive long', () => {
    const e = new Bytes();
    e.u8(0xac, 0xed, 0x00, 0x05).u8(0x77, 0x04).u32(1);
    e.u8(0x73, 0x72).utf(TREE_EVENT_COMMAND_CLASS).u64(0n).u8(0x02).u16(1);
    e.u8('J'.charCodeAt(0)).utf('lastEventPackId');
    e.u8(0x78, 0x70);
    e.u64(BigInt(ABOVE_2_53));
    expect([...serializeCommands([makeTreeEventCommand(ABOVE_2_53)])]).toEqual(e.b);
    // -1: a fresh watermark.
    expect([...serializeCommands([makeTreeEventCommand('-1')])].slice(-8)).toEqual(new Array(8).fill(0xff));
    expect(() => makeTreeEventCommand('1.5')).toThrow();
    expect(() => makeTreeEventCommand('9223372036854775808')).toThrow(/range/);
  });

  it('an answer with every event kind decodes with 64-bit ids intact, through the real transport', async () => {
    const t = transportAnswering(() => feedAnswerBytes([
      pack(BIG, { update: [ABOVE_2_53] }),
      pack('8', { add: [[ABOVE_2_53, '9007199254740995']], del: ['9007199254740997'], move: [['9007199254740999', '11', '12']], reorder: ['13'] }),
    ]));
    const objects = await t.sendStreamingCommands([makeTreeEventCommand('7')], 'read');
    const a = decodeTreeEvents(objects);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // Sorted by pack id, as longs.
    expect(a.packs.map(p => p.packId)).toEqual(['8', BIG]);
    expect(a.packs[1].updated).toEqual([ABOVE_2_53]);
    expect(a.packs[0]).toMatchObject({
      propertiesChanged: false,
      added: [{ rid: '9007199254740995', parent: ABOVE_2_53 }],
      deleted: ['9007199254740997'],
      relocated: [{ rid: '9007199254740999', parent: '11', oldParent: '12' }],
      reordered: ['13'],
      updated: [],
    });
  });

  it('the empty answer (an idle server), a watermark pack, and type definition changes', async () => {
    const t = transportAnswering(() => feedAnswerBytes([]));
    expect(decodeTreeEvents(await t.sendStreamingCommands([makeTreeEventCommand('7')], 'read'))).toEqual({ ok: true, packs: [] });
    const w = transportAnswering(() => feedAnswerBytes([pack('10'), pack('11', { props: true })]));
    const a = decodeTreeEvents(await w.sendStreamingCommands([makeTreeEventCommand('-1')], 'read'));
    expect(a.ok && a.packs.map(p => [p.packId, p.propertiesChanged, p.updated.length])).toEqual([['10', false, 0], ['11', true, 0]]);
  });

  it('a server that does not know the class answers with an error: unsupported', async () => {
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeObject({ $type: SERVER_EXCEPTION.name, message: `${TREE_EVENT_COMMAND_CLASS}; local class incompatible: stream classdesc serialVersionUID = 1` });
    const bytes = w.toBytes();
    const t = transportAnswering(() => bytes);
    const a = decodeTreeEvents(await t.sendStreamingCommands([makeTreeEventCommand('-1')], 'read'));
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(classifyTreeEventFailure(a.message)).toBe('unsupported');
    expect(classifyTreeEventFailure(TREE_EVENT_COMMAND_CLASS)).toBe('unsupported');
    expect(classifyTreeEventFailure('java.lang.NullPointerException')).toBe('failed');
  });
});

describe('the feed\'s capability record', () => {
  it('unknown → supported; failures suspend it with a timed trial; unsupported lasts for the connection; a reconnect starts again', () => {
    const caps = new CommandCapabilities();
    expect(caps.get('p', 's1', 'feed')).toBe('unknown');
    caps.record('p', 's1', 'feed', 'answered');
    expect(caps.get('p', 's1', 'feed')).toBe('supported');
    for (let i = 0; i < SUSPEND_AFTER; i++) caps.record('p', 's1', 'feed', 'failed', 'HTTP 500', 1_000);
    expect(caps.get('p', 's1', 'feed')).toBe('suspended');
    expect(caps.usable('p', 's1', 'feed', 1_000 + SUSPEND_RETRY_MS - 1)).toBe(false);
    expect(caps.usable('p', 's1', 'feed', 1_000 + SUSPEND_RETRY_MS)).toBe(true);
    // The name search's record is separate.
    expect(caps.get('p', 's1', 'search')).toBe('unknown');
    caps.record('p', 's1', 'feed', 'unsupported');
    expect(caps.usable('p', 's1', 'feed', 10 * SUSPEND_RETRY_MS)).toBe(false);
    expect(caps.get('p', 's2', 'feed')).toBe('unknown');
    expect(caps.get('q', 's2', 'feed')).toBe('unknown');
  });
});

describe('the pack counter and the script gauge', () => {
  it('the client hands the largest pack id of each answer to the load governor (a restart shows as one going back)', async () => {
    const { BmpClient } = await import('../bmp-client');
    const t = transportAnswering(() => feedAnswerBytes([pack('10'), pack('11')]));
    const noted = vi.spyOn(t.governor, 'noteServerCounter').mockResolvedValue();
    const client = new BmpClient('https://bmp.feed.test/', 'qa', 'qa');
    (client as unknown as { transport: BmpTransport }).transport = t;
    await client.readTreeEvents('-1');
    expect(noted).toHaveBeenCalledWith('11');
  });
});
