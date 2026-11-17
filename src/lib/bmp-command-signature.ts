/** BMP CommandSignature: HMAC-SHA256 of the exact serialized body, keyed by
 * the UTF-8 LoginTicket. Older servers ignore these additional headers. */
export async function commandSignature(ticket: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(ticket), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, body);
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}
