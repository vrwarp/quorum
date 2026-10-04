import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 8799;
const dataDir = process.env.QUORUM_E2E_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'quorum-e2e-'));

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
  },
  webServer: {
    command: `node packages/server/dist/main.js`,
    cwd: path.resolve(import.meta.dirname, '..'),
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      PORT: String(PORT),
      QUORUM_DATA_DIR: dataDir,
      QUORUM_PASSWORD: 'e2e-password',
      QUORUM_RUNTIME: 'fake',
      QUORUM_DIGEST_ABSENCE_MS: '1500',
      QUORUM_REVIEW_WINDOW_MS: '4000',
      QUORUM_LISTENER_DEBOUNCE_MS: '200',
      ANTHROPIC_API_KEY: '',
    },
  },
});
