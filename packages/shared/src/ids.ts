/** Id and hash helpers that work in Node and the browser (no node: imports). */

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // fallback: not cryptographically strong, fine for ids in tests
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function newId(prefix: 'room' | 'user' | 'msg' | 'doc' | 'prop' | 'opt' | 'sess'): string {
  return `${prefix}_${uuid().replace(/-/g, '').slice(0, 20)}`;
}

/** FNV-1a 64-bit hash as 16 hex chars. Used for anchor staleness detection, not security. */
export function textHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
