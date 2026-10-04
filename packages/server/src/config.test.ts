import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DEFAULTS } from '@quorum/shared';
import { loadConfig, tunableEnvName } from './config.js';

const base = { QUORUM_PASSWORD: 'pw', QUORUM_DATA_DIR: '/tmp/quorum-config-test' };

describe('loadConfig', () => {
  it('reads the tunables from QUORUM_<UPPER_SNAKE_CASE> variables, the names e2e/playwright.config.ts sets', () => {
    expect(tunableEnvName('digestAbsenceMs')).toBe('QUORUM_DIGEST_ABSENCE_MS');
    expect(tunableEnvName('reviewWindowMs')).toBe('QUORUM_REVIEW_WINDOW_MS');
    expect(tunableEnvName('listenerDebounceMs')).toBe('QUORUM_LISTENER_DEBOUNCE_MS');
    const cfg = loadConfig({
      ...base,
      QUORUM_DIGEST_ABSENCE_MS: '1500',
      QUORUM_REVIEW_WINDOW_MS: '4000',
      QUORUM_LISTENER_DEBOUNCE_MS: '200',
    });
    expect(cfg.tunables).toEqual({
      digestAbsenceMs: 1500,
      reviewWindowMs: 4000,
      listenerDebounceMs: 200,
    });
  });

  it('accepts every DEFAULTS key as a variable, and ignores empty ones', () => {
    const env: Record<string, string> = { ...base };
    for (const key of Object.keys(DEFAULTS)) env[tunableEnvName(key)] = '7';
    expect(Object.keys(loadConfig(env).tunables).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(loadConfig({ ...base, QUORUM_REVIEW_WINDOW_MS: '' }).tunables).toEqual({});
  });

  it('rejects numbers that are not numbers', () => {
    expect(() => loadConfig({ ...base, QUORUM_REVIEW_WINDOW_MS: 'soon' })).toThrow(
      /QUORUM_REVIEW_WINDOW_MS/,
    );
    expect(() => loadConfig({ ...base, PORT: 'eighty' })).toThrow(/PORT/);
  });

  it('needs a password unless told otherwise', () => {
    expect(() => loadConfig({ QUORUM_DATA_DIR: base.QUORUM_DATA_DIR })).toThrow(/QUORUM_PASSWORD/);
    expect(
      loadConfig({ QUORUM_DATA_DIR: base.QUORUM_DATA_DIR, QUORUM_ALLOW_NO_PASSWORD: '1' }).password,
    ).toBeNull();
  });

  it('defaults to the real runtime, because a login can arrive later from Settings', () => {
    expect(loadConfig(base).runtime).toBe('claude');
    expect(loadConfig({ ...base, QUORUM_RUNTIME: 'fake' }).runtime).toBe('fake');
    expect(() => loadConfig({ ...base, QUORUM_RUNTIME: 'both' })).toThrow(/QUORUM_RUNTIME/);
  });

  it('keeps the Claude login inside the data dir unless CLAUDE_CONFIG_DIR says otherwise', () => {
    expect(loadConfig(base).claudeConfigDir).toBe(
      path.join(path.resolve(base.QUORUM_DATA_DIR), 'claude'),
    );
    expect(loadConfig({ ...base, CLAUDE_CONFIG_DIR: '/srv/claude' }).claudeConfigDir).toBe(
      '/srv/claude',
    );
  });

  it('uses the SDK-bundled Claude binary unless QUORUM_CLAUDE_BINARY names another', () => {
    expect(loadConfig(base).claudeBinary).toMatch(/claude(\.exe)?$/);
    expect(
      loadConfig({ ...base, QUORUM_CLAUDE_BINARY: '/opt/claude/bin/claude' }).claudeBinary,
    ).toBe('/opt/claude/bin/claude');
    expect(loadConfig({ ...base, QUORUM_CLAUDE_BINARY: 'e2e/fake-claude.mjs' }).claudeBinary).toBe(
      path.resolve('e2e/fake-claude.mjs'),
    );
    expect(loadConfig({ ...base, QUORUM_CLAUDE_BINARY: 'claude' }).claudeBinary).toBe('claude'); // looked up on the PATH
  });
  it('caps spend per agent session; the old per-room name is still read, with a warning', () => {
    expect(loadConfig(base).maxBudgetUsdPerSession).toBe(20);
    expect(loadConfig(base).warnings).toEqual([]);
    expect(
      loadConfig({ ...base, QUORUM_MAX_BUDGET_USD_PER_SESSION: '7.5' }).maxBudgetUsdPerSession,
    ).toBe(7.5);

    const old = loadConfig({ ...base, QUORUM_MAX_BUDGET_USD_PER_ROOM: '12' });
    expect(old.maxBudgetUsdPerSession).toBe(12);
    expect(old.warnings).toHaveLength(1);
    expect(old.warnings[0]).toMatch(/QUORUM_MAX_BUDGET_USD_PER_ROOM is deprecated.*PER_SESSION/);

    const both = loadConfig({
      ...base,
      QUORUM_MAX_BUDGET_USD_PER_ROOM: '12',
      QUORUM_MAX_BUDGET_USD_PER_SESSION: '3',
    });
    expect(both.maxBudgetUsdPerSession).toBe(3); // the new name wins
    expect(both.warnings[0]).toMatch(/ignored/);
    expect(() => loadConfig({ ...base, QUORUM_MAX_BUDGET_USD_PER_SESSION: 'lots' })).toThrow(
      /QUORUM_MAX_BUDGET_USD_PER_SESSION/,
    );
    expect(() => loadConfig({ ...base, QUORUM_MAX_BUDGET_USD_PER_ROOM: 'lots' })).toThrow(
      /QUORUM_MAX_BUDGET_USD_PER_ROOM/,
    );
  });

  it('trusts X-Forwarded-For only when told to, and lists the extra WebSocket origins', () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, QUORUM_TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, QUORUM_TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(loadConfig(base).allowedOrigins).toEqual([]);
    expect(
      loadConfig({
        ...base,
        QUORUM_ALLOWED_ORIGINS: ' https://quorum.example.com , app.example.com:8443,,',
      }).allowedOrigins,
    ).toEqual(['https://quorum.example.com', 'app.example.com:8443']);
  });
});
