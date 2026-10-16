import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { commandSignature } from '../bmp-command-signature';

describe('BMP command signature', () => {
  it('matches the HMAC-SHA256 known-answer vector in lowercase hex', async () => {
    expect(await commandSignature('key', new TextEncoder().encode('The quick brown fox jumps over the lazy dog').buffer))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('preserves UTF-8 identities, 64-bit ticket keys and every binary byte', async () => {
    const ticket = 'üser;STUDIO;9223372036854775707';
    const body = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(await commandSignature(ticket, body.buffer))
      .toBe(createHmac('sha256', ticket).update(body).digest('hex'));
    expect(await commandSignature(ticket.replace('5707', '5708'), body.buffer))
      .not.toBe(await commandSignature(ticket, body.buffer));
  });
});
