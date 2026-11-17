/**
 * Password encryption at rest — uses Web Crypto with a key derived from the extension ID.
 * Prevents plaintext passwords in chrome.storage.local exports/dumps.
 * Not a substitute for OS-level credential management — defense in depth.
 *
 * The session settings snapshot (snapshotSettings) strips passwords and the AI key
 * before it is written, so chrome.storage.session never holds them in plaintext.
 *
 * The key depends on `chrome.runtime.id`. An unpacked build loaded from another
 * folder gets another ID, so values encrypted by the previous build cannot be
 * decrypted. `decrypt` then throws `DecryptError`; callers must treat the value
 * as lost (ask the user to enter it again) and never use or re-save the ciphertext.
 */

const ALGO = 'AES-GCM';
const KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt'];

let cachedKey: CryptoKey | null = null;

/** The stored value cannot be decrypted with this installation's key. */
export class DecryptError extends Error {
  constructor() {
    super('The stored secret cannot be read in this browser. Enter it again.');
    this.name = 'DecryptError';
  }
}

/** Derive a stable AES key from the extension's ID (unique per install). */
async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const id = chrome.runtime.id;
  const raw = new TextEncoder().encode(id.padEnd(32, id).slice(0, 32));
  cachedKey = await crypto.subtle.importKey('raw', raw, ALGO, false, KEY_USAGE);
  return cachedKey;
}

/** Encrypt a string. Returns base64-encoded iv:ciphertext. */
export async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  // Combine iv + ciphertext, encode as base64
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

/** Decrypt a base64 iv:ciphertext string. Throws `DecryptError` when the value
 *  is not readable with this installation's key; it never returns the input. */
export async function decrypt(encoded: string): Promise<string> {
  if (!encoded) return '';
  const key = await getKey();
  try {
    const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new DecryptError();
  }
}
