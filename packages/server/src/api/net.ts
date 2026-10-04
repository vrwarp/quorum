import type { IncomingMessage } from 'node:http';

/**
 * The address a request counts as coming from, for throttling. The socket's peer address, unless the server sits behind
 * a reverse proxy it trusts (`QUORUM_TRUST_PROXY=1`): then the first hop of X-Forwarded-For, which is the client as the
 * proxy saw it. Only turn that on behind a proxy that sets the header itself (Caddy's reverse_proxy does); with a
 * directly reachable server the header is whatever the client wrote.
 */
export function clientAddress(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** `https://Quorum.Example.com/` -> `https://quorum.example.com`; anything that is not an origin is returned trimmed. */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a request's Origin header may talk to this server. A browser attaches the Origin of the page that made the
 * request; the cookie alone says nothing about which page that was (SameSite=Lax still sends it from another port on the
 * same host, or a sibling subdomain). Same origin means the Origin's host equals the Host the request was sent to, which
 * holds behind Caddy and the Vite dev proxy alike. Other origins must be listed (`QUORUM_ALLOWED_ORIGINS`), as a full
 * origin (`https://app.example.com`) or a bare host (`app.example.com:8443`). No Origin header at all means a client that
 * is not a browser page (curl, a script, the tests), which cannot be tricked into carrying someone's cookie.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[] = [],
): boolean {
  if (origin === undefined) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false; // "null" (a sandboxed or file page) and garbage
  }
  if (host && originHost === host.toLowerCase()) return true;
  const normalized = normalizeOrigin(origin);
  return allowed.some((a) => {
    const entry = normalizeOrigin(a);
    return entry === normalized || entry === originHost;
  });
}
