import { chromium, defineConfig } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.QUORUM_E2E_PORT ?? 8799);
const repoRoot = path.resolve(import.meta.dirname, '..');

// A fresh data directory per run, removed when the runner exits. Workers load this config too: they inherit the
// variable instead of creating (and leaking) a directory of their own.
let dataDir = process.env.QUORUM_E2E_DATA_DIR;
if (!dataDir) {
  const created = mkdtempSync(path.join(tmpdir(), 'quorum-e2e-'));
  dataDir = process.env.QUORUM_E2E_DATA_DIR = created;
  process.on('exit', () => rmSync(created, { recursive: true, force: true }));
}

for (const built of ['packages/server/dist/main.js', 'packages/client/dist/index.html']) {
  if (!existsSync(path.join(repoRoot, built))) {
    throw new Error(`${built} is missing: run "npm run build" before "npm run test:e2e"`);
  }
}

/**
 * Playwright wants the exact Chromium revision it shipped with. Machines that preinstall a different revision under
 * PLAYWRIGHT_BROWSERS_PATH and cannot download (the sandbox image this repo is developed in) would fail to launch, so
 * fall back to any Chromium found there. QUORUM_E2E_CHROMIUM pins an explicit executable.
 */
function fallbackChromium(): string | undefined {
  if (process.env.QUORUM_E2E_CHROMIUM) return process.env.QUORUM_E2E_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* no managed browser: look around */
  }
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const root =
    configured && configured !== '0' ? configured : path.join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
    .sort()
    .reverse()
    .flatMap((name) =>
      [
        'chrome-linux/chrome',
        'chrome-linux/headless_shell',
        'chrome-linux64/chrome',
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ].map((rel) => path.join(root, name, rel)),
    );
  return candidates.find((file) => existsSync(file));
}

const executablePath = fallbackChromium();

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: `node packages/server/dist/main.js`,
    cwd: repoRoot,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    // QUORUM_E2E_VERBOSE=1 shows the server's log in the test output.
    stdout: process.env.QUORUM_E2E_VERBOSE ? 'pipe' : 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      PORT: String(PORT),
      QUORUM_DATA_DIR: dataDir,
      QUORUM_PASSWORD: 'e2e-password',
      QUORUM_RUNTIME: 'fake',
      // Tunables are read by tunableEnvName() in packages/server/src/config.ts: QUORUM_ + SNAKE_CASE of the DEFAULTS key.
      QUORUM_DIGEST_ABSENCE_MS: '1500',
      QUORUM_REVIEW_WINDOW_MS: '4000',
      QUORUM_LISTENER_DEBOUNCE_MS: '200',
      // The Settings spec expects "not signed in", whatever credentials the machine happens to have: no keys from the
      // environment, and a stub in place of the real CLI (which can find host-provided credentials on its own).
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_AUTH_TOKEN: '',
      QUORUM_CLAUDE_BINARY: path.join(import.meta.dirname, 'fake-claude.mjs'),
    },
  },
});
