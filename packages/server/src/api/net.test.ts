import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientAddress, normalizeOrigin, originAllowed } from './net.js';

const req = (headers: Record<string, string | string[]>, remoteAddress = '10.1.2.3') =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe('originAllowed (review F13)', () => {
  it('lets a request without an Origin through: it is not a browser page, so it cannot carry anyone else’s cookie', () => {
    expect(originAllowed(undefined, 'quorum.example.com')).toBe(true);
    expect(originAllowed(undefined, undefined)).toBe(true);
  });

  it('accepts the page this server served: the Origin host is the Host the request was sent to', () => {
    expect(originAllowed('https://quorum.example.com', 'quorum.example.com')).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(originAllowed('http://127.0.0.1:8787', '127.0.0.1:8787')).toBe(true);
    expect(originAllowed('http://[::1]:8787', '[::1]:8787')).toBe(true);
    expect(originAllowed('HTTPS://Quorum.Example.com', 'QUORUM.example.com')).toBe(true);
  });

  it('refuses another host, another port and an origin that is not one', () => {
    expect(originAllowed('https://evil.example', 'quorum.example.com')).toBe(false);
    expect(originAllowed('https://quorum.example.com.evil.example', 'quorum.example.com')).toBe(
      false,
    );
    expect(originAllowed('http://localhost:5174', 'localhost:5173')).toBe(false);
    expect(originAllowed('http://localhost', 'localhost:8787')).toBe(false);
    expect(originAllowed('null', 'localhost:8787')).toBe(false);
    expect(originAllowed('not a url', 'localhost:8787')).toBe(false);
    expect(originAllowed('https://quorum.example.com', undefined)).toBe(false);
  });

  it('accepts what the allow list names, as a full origin or a bare host, ignoring case and a trailing slash', () => {
    const allowed = ['https://quorum.example.com/', 'App.Example.com:8443'];
    expect(originAllowed('https://quorum.example.com', 'internal:8787', allowed)).toBe(true);
    expect(originAllowed('https://app.example.com:8443', 'internal:8787', allowed)).toBe(true);
    expect(originAllowed('http://quorum.example.com', 'internal:8787', allowed)).toBe(false);
    expect(originAllowed('https://other.example.com', 'internal:8787', allowed)).toBe(false);
    expect(originAllowed('https://evil.example', 'internal:8787', [])).toBe(false);
    expect(normalizeOrigin(' HTTPS://X.example/// ')).toBe('https://x.example');
  });
});

describe('clientAddress (review F12)', () => {
  it('is the socket’s peer address, and ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientAddress(req({}))).toBe('10.1.2.3');
    expect(clientAddress(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe('10.1.2.3');
    expect(clientAddress(req({ 'x-forwarded-for': '203.0.113.9' }), false)).toBe('10.1.2.3');
    expect(clientAddress({ headers: {}, socket: {} } as unknown as IncomingMessage)).toBe(
      'unknown',
    );
  });

  it('with a trusted proxy it is the first hop of X-Forwarded-For', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '203.0.113.9' }), true)).toBe('203.0.113.9');
    expect(
      clientAddress(req({ 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.1, 10.0.0.2' }), true),
    ).toBe('203.0.113.9');
    expect(clientAddress(req({ 'x-forwarded-for': ['198.51.100.4, 10.0.0.1', 'x'] }), true)).toBe(
      '198.51.100.4',
    );
    // no header, or an empty one: the proxy itself is all there is
    expect(clientAddress(req({}), true)).toBe('10.1.2.3');
    expect(clientAddress(req({ 'x-forwarded-for': '' }), true)).toBe('10.1.2.3');
    expect(clientAddress(req({ 'x-forwarded-for': ' , 10.0.0.1' }), true)).toBe('10.1.2.3');
  });

  it('keeps a hostile header short', () => {
    expect(clientAddress(req({ 'x-forwarded-for': 'a'.repeat(5_000) }), true)).toHaveLength(64);
  });
});
