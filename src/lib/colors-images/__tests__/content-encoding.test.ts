import { describe, expect, it } from 'vitest';
import { encodeContent } from '../content-encoding';
import { buildFileOps } from '../images-draft';
import { FILE_LIMIT_KB, tooLargeText } from '../write-ops';
import { base64ToBytes } from '../image-process';

describe('encodeContent', () => {
  it('compresses text that shrinks and round-trips', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">' + '<path d="M0 0h24v24H0z"/>'.repeat(200) + '</svg>');
    const text = await encodeContent(svg);
    expect(text.length).toBeLessThan(Math.ceil(svg.length * 4 / 3) / 3);
    const body = new Response(new Blob([base64ToBytes(text) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(svg);
  });

  it('keeps data that does not shrink as plain base64', async () => {
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 255);
    const text = await encodeContent(noise);
    expect(base64ToBytes(text)).toEqual(noise);
  });
});

describe('file size limit', () => {
  it('uses the content prepared by the page and names the limit', () => {
    const big = { bytes: new Uint8Array(1), mime: 'image/svg+xml', base64: 'A'.repeat(30_000) };
    const small = { bytes: new Uint8Array(3), mime: 'image/svg+xml', base64: 'AAAA' };
    const item = (id: string) => ({ key: id, fileName: `${id}.svg`, bytes: new Uint8Array(1), mime: 'image/svg+xml', id, idTouched: false, folderId: 'f', description: '' });
    const { ops, tooLarge } = buildFileOps([{ item: item('a'), out: big }, { item: item('b'), out: small }], [], () => 'x');
    expect(ops.map(o => o.kind === 'add' && o.base64)).toEqual(['AAAA']);
    expect(tooLarge).toEqual(['a.svg']);
    expect(tooLargeText(tooLarge)).toContain(`about ${FILE_LIMIT_KB} KB`);
  });
});
