import { describe, expect, it } from 'vitest';
import { normalizeCode } from './api';

describe('normalizeCode', () => {
  it('gives code#state for a pasted address that carries both (the CLI wants exactly that)', () => {
    expect(
      normalizeCode('https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz789'),
    ).toBe('abc123#xyz789');
    // order does not matter, and other parameters are ignored
    expect(normalizeCode('https://example.test/cb?state=S&foo=1&code=C')).toBe('C#S');
  });

  it('decodes percent-encoding in both parts', () => {
    expect(normalizeCode('https://example.test/cb?code=a%2Fb%3D&state=c%2Bd%20e')).toBe(
      'a/b=#c+d e',
    );
  });

  it('keeps a malformed escape as written instead of throwing', () => {
    expect(normalizeCode('https://example.test/cb?code=100%&state=s')).toBe('100%#s');
  });

  it('gives the bare code for an address with a code and no state', () => {
    expect(normalizeCode('https://example.test/cb?code=abc123')).toBe('abc123');
    expect(normalizeCode('https://example.test/cb?foo=1&code=abc123#frag')).toBe('abc123');
  });

  it('reads parameters from a fragment too', () => {
    expect(normalizeCode('https://example.test/cb#code=c1&state=s1')).toBe('c1#s1');
  });

  it('passes anything else on as typed, trimmed', () => {
    expect(normalizeCode('abc123')).toBe('abc123');
    expect(normalizeCode('  abc123\n')).toBe('abc123');
    // the code the sign-in page itself shows is already code#state
    expect(normalizeCode('abc123#xyz789')).toBe('abc123#xyz789');
    // an address without a code is not rewritten
    expect(normalizeCode('https://example.test/cb?state=only')).toBe(
      'https://example.test/cb?state=only',
    );
    expect(normalizeCode('https://example.test/cb?error=access_denied&state=s')).toBe(
      'https://example.test/cb?error=access_denied&state=s',
    );
    expect(normalizeCode('')).toBe('');
  });

  it('ignores parameters that merely end in the name', () => {
    expect(normalizeCode('https://example.test/cb?mycode=x&mystate=y')).toBe(
      'https://example.test/cb?mycode=x&mystate=y',
    );
  });

  it('treats an empty code as absent', () => {
    expect(normalizeCode('https://example.test/cb?code=&state=s')).toBe(
      'https://example.test/cb?code=&state=s',
    );
  });
});
