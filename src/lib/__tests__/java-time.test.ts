import { expect, it } from 'vitest';
import { JavaWriter, deserializeStream, SC_EXTERNALIZABLE, SC_BLOCK_DATA } from '../java-serial';
import { registerBmpTypes } from '../bmp-types';
registerBmpTypes();

function payload(seconds: bigint, nanos: number, tag = 1) {
  const value = new Uint8Array(13), view = new DataView(value.buffer);
  value[0] = tag; view.setBigInt64(1, seconds); view.setInt32(9, nanos);
  return value;
}
function stream(chunks: Uint8Array[]) {
  const writer = new JavaWriter(); writer.writeStreamHeader(); writer.writeByte(0x73);
  writer.writeClassDesc({name:'java.time.Ser',uid:-7683839454370182990n,flags:SC_EXTERNALIZABLE|SC_BLOCK_DATA,fields:[]});
  chunks.forEach(chunk => writer.writeBlockData(chunk)); writer.writeEndBlockData(); writer.writeObject('next object');
  const bytes = writer.toBytes();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
it.each([[0n,0,0],[0n,350,0.00035],[3n,125_500_000,3125.5]])('decodes Duration %s seconds + %s ns without losing stream alignment', (seconds,nanos,ms) => {
  expect(deserializeStream(stream([payload(seconds,nanos)]),true)).toEqual([{$class:'java.time.Ser',durationMs:ms},'next object']);
});
it('handles a duration split across primitive block boundaries', () => {
  const data=payload(1n,12_500_000);
  expect(deserializeStream(stream([data.slice(0,4),data.slice(4,9),data.slice(9)]),true)[0].durationMs).toBe(1012.5);
});
it('keeps Instant opaque and consumes its remaining external blocks', () => {
  const data=payload(1n,0,2);
  expect(deserializeStream(stream([data.slice(0,4),data.slice(4)]),true)).toEqual([{$class:'java.time.Ser'},'next object']);
});
it.each([payload(0n,-1),payload(0n,1_000_000_000),payload(0n,0).slice(0,7)])('rejects malformed duration data', data => {
  expect(()=>deserializeStream(stream([data]),true)).toThrow(/duration/i);
});
it.each([-1n,9223372036854775807n])('does not expose misleading trace time for %s seconds', seconds => {
  expect(deserializeStream(stream([payload(seconds,0)]),true)[0]).not.toHaveProperty('durationMs');
});
