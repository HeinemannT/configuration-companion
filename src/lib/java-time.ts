import { SC_BLOCK_DATA, SC_EXTERNALIZABLE, registerType, type JavaReader } from './java-serial';

const END_BLOCK_DATA = 0x78;

/** OpenJDK java.time.Ser: tag 1, signed seconds (long), nanoseconds (int).
 * Decode only Duration; other java.time proxies retain the previous opaque form.
 * https://github.com/openjdk/jdk21u/blob/master/src/java.base/share/classes/java/time/Ser.java
 */
function readDuration(reader: JavaReader): { durationMs?: number } {
  const bytes = new Uint8Array(13);
  let offset = 0;
  while (offset < bytes.length) {
    if (!reader.remaining || reader.peekByte() === END_BLOCK_DATA) throw new Error('Truncated Java duration');
    const block = reader.readObject();
    if (!block?.$blockData || !(block.view instanceof DataView)) throw new Error('Invalid Java duration block');
    const chunk = new Uint8Array(block.view.buffer, block.view.byteOffset, block.view.byteLength);
    if (!chunk.length) continue;
    if (!offset && chunk[0] !== 1) return {};
    if (chunk.length > bytes.length - offset) throw new Error('Invalid Java duration length');
    bytes.set(chunk, offset); offset += chunk.length;
  }
  const view = new DataView(bytes.buffer), seconds = view.getBigInt64(1), nanos = view.getInt32(9);
  if (nanos < 0 || nanos >= 1_000_000_000) throw new Error('Invalid Java duration nanoseconds');
  // Negative or unrepresentable durations are not meaningful trace measurements.
  if (seconds < 0n || seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) return {};
  return { durationMs: Number(seconds) * 1000 + nanos / 1_000_000 };
}

export function registerJavaTime(): void {
  registerType({
    desc: { name: 'java.time.Ser', uid: -7683839454370182990n, flags: SC_EXTERNALIZABLE | SC_BLOCK_DATA, fields: [] },
    extReader: readDuration,
  });
}
