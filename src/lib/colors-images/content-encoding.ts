/**
 * The base64 text a file's content is written as. BMP takes the content as
 * plain base64 or as gzip then base64 and serves the original bytes either
 * way (checked on a server); the smaller text is used, which lets an SVG
 * (text) fit a write about three times as large as its plain size. A picture
 * does not shrink, so it is written plain.
 */
import { bytesToBase64 } from './image-process';

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
}

export async function encodeContent(bytes: Uint8Array): Promise<string> {
  const plain = bytesToBase64(bytes);
  if (typeof CompressionStream !== 'function') return plain;
  try {
    const zipped = bytesToBase64(await gzipBytes(bytes));
    return zipped.length < plain.length ? zipped : plain;
  } catch {
    return plain;
  }
}
