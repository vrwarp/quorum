import { describe, expect, it } from 'vitest';
import { needsSignIn } from './agentStatus';
import { ApiError } from './api';
import { endsLogin } from './SettingsScreen';
import { shortRef } from './ui';

describe('needsSignIn', () => {
  it("is true for the server's no-credential wording and its variants", () => {
    expect(needsSignIn('Sign in to Claude in Settings')).toBe(true);
    expect(needsSignIn('The agent is not signed in')).toBe(true);
    expect(needsSignIn('please sign-in again')).toBe(true);
    expect(needsSignIn('Signing in is required')).toBe(true);
  });

  it('is false for other reasons and for none, which are shown as written', () => {
    expect(needsSignIn('The Claude account has a billing problem')).toBe(false);
    expect(needsSignIn('The agent has reached its spending limit')).toBe(false);
    expect(needsSignIn('The agent session keeps failing')).toBe(false);
    // "sign in" inside another word is not a sign-in prompt
    expect(needsSignIn('The design in the plan failed')).toBe(false);
    expect(needsSignIn(null)).toBe(false);
    expect(needsSignIn('')).toBe(false);
  });
});

describe('shortRef', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  it('shortens a sha and keeps the parent suffix of a revision expression', () => {
    expect(shortRef(sha)).toBe('a1b2c3d');
    expect(shortRef(`${sha}~1`)).toBe('a1b2c3d~1');
    expect(shortRef(`${sha}^`)).toBe('a1b2c3d^');
  });

  it('leaves other refs to the plain short form', () => {
    expect(shortRef('main')).toBe('main');
    expect(shortRef('plan/a-vs-b/a')).toBe('plan/a-');
  });
});

describe('endsLogin', () => {
  it('is true for a rejection of the code (the server ended that login), false for a rate limit or network trouble', () => {
    expect(endsLogin(new ApiError(400, 'The code was not accepted.'))).toBe(true);
    expect(endsLogin(new ApiError(404, 'gone'))).toBe(true);
    expect(endsLogin(new ApiError(429, 'Too many attempts.'))).toBe(false);
    expect(endsLogin(new ApiError(502, 'bad gateway'))).toBe(false);
    expect(endsLogin(new TypeError('Failed to fetch'))).toBe(false);
  });
});
