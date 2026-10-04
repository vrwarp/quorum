import { type Page } from '@playwright/test';
import { ADMIN, apiGet, expect, test } from './helpers.js';

/**
 * The Claude sign-in screen. The first test talks to the real server (whose `claude` binary is e2e/fake-claude.mjs and
 * is never signed in). The others replace `/api/claude/**` in the browser, since a real sign-in needs Anthropic.
 */

const NOT_SIGNED_IN = { signedIn: false, method: 'none', account: null, pendingLogins: 0 };
const SIGNED_IN = {
  signedIn: true,
  method: 'oauth_login',
  account: { email: 'admin@example.test' },
  pendingLogins: 0,
};

test('the screen loads for the admin and reports not signed in', async ({ app }) => {
  const admin = await app.login(ADMIN);

  await admin.page.getByTestId('settings-link').click();
  await expect(admin.page).toHaveURL(/\/settings$/);
  await expect(admin.page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(admin.page.getByTestId('claude-status')).toHaveText('Not signed in', {
    timeout: 30_000,
  });
  await expect(admin.page.getByTestId('claude-signin')).toHaveText('Sign in with Claude');
  await expect(admin.page.getByTestId('claude-signout')).toHaveCount(0);

  // a direct load of /settings is served by the SPA fallback and keeps the session
  await admin.page.goto('/settings');
  await expect(admin.page.getByTestId('claude-status')).toHaveText('Not signed in', {
    timeout: 30_000,
  });
  await expect(admin.page.getByTestId('claude-signin')).toBeVisible();

  // the API agrees with the screen
  const status = await apiGet<{ signedIn: boolean; method: string }>(
    admin.page,
    '/api/claude/status',
  );
  expect(status).toMatchObject({ signedIn: false, method: 'none' });
  await admin.page.getByRole('link', { name: 'Back to rooms' }).click();
  await expect(admin.page.getByTestId('room-create-name')).toBeVisible();
});

test('anyone but the first registered user is told so and gets no sign-in controls', async ({
  app,
}) => {
  // The admin is the user the global setup registered; the server says so in /api/me, and the screen believes it.
  const dave = await app.login('Dave');
  const me = await apiGet<{ isAdmin?: boolean }>(dave.page, '/api/me');
  expect(me.isAdmin).toBe(false);
  await dave.page.goto('/settings');
  await expect(dave.page.getByTestId('claude-admin-note')).toContainText(
    'Only the first registered user can sign the agent in',
  );
  await expect(dave.page.getByTestId('claude-admin-note')).toContainText('not you');
  await expect(dave.page.getByTestId('claude-signin')).toHaveCount(0);
  await expect(dave.page.getByTestId('claude-signout')).toHaveCount(0);
  await expect(dave.page.getByTestId('claude-code')).toHaveCount(0);

  const admin = await app.login(ADMIN);
  expect((await apiGet<{ isAdmin?: boolean }>(admin.page, '/api/me')).isAdmin).toBe(true);
  await admin.page.goto('/settings');
  await expect(admin.page.getByTestId('claude-admin-note')).not.toContainText('not you');
  await expect(admin.page.getByTestId('claude-signin')).toBeVisible({ timeout: 30_000 });
});

interface Calls {
  start: number;
  codes: Array<{ loginId: string; code: string }>;
  cancels: string[];
  logouts: number;
}

/** A stand-in for /api/claude/**: logins numbered login_1, login_2, ...; only `good-code#good-state` is accepted. */
async function mockClaude(page: Page): Promise<Calls> {
  const calls: Calls = { start: 0, codes: [], cancels: [], logouts: 0 };
  let signedIn = false;
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/claude/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/claude/', '');
    const body =
      request.method() === 'POST' ? (request.postDataJSON() as Record<string, string>) : {};
    switch (path) {
      case 'status':
        return route.fulfill(json(signedIn ? SIGNED_IN : NOT_SIGNED_IN));
      case 'login/start': {
        calls.start += 1;
        return route.fulfill(
          json({
            loginId: `login_${calls.start}`,
            url: `https://claude.example.test/oauth/authorize?n=${calls.start}`,
          }),
        );
      }
      case 'login/code':
        calls.codes.push({ loginId: body.loginId!, code: body.code! });
        if (body.code === 'good-code#good-state') {
          signedIn = true;
          return route.fulfill(json(SIGNED_IN));
        }
        return route.fulfill(
          json({ error: 'claude_login_failed', message: 'That code was not accepted.' }, 400),
        );
      case 'login/cancel':
        calls.cancels.push(body.loginId!);
        return route.fulfill(json({ ok: true }));
      case 'logout':
        calls.logouts += 1;
        signedIn = false;
        return route.fulfill(json(NOT_SIGNED_IN));
      default:
        return route.fulfill(json({ error: 'not_found', message: 'unknown route' }, 404));
    }
  });
  return calls;
}

test('sign in: a rejected code leads back to a fresh start; a pasted address becomes code#state; sign out', async ({
  app,
}) => {
  app.expectConsoleError(/status of 400/); // the rejected code is a 400, which the screen handles
  const admin = await app.login(ADMIN);
  const calls = await mockClaude(admin.page);
  await admin.page.goto('/settings');
  await expect(admin.page.getByTestId('claude-status')).toHaveText('Not signed in');
  const signIn = admin.page.getByTestId('claude-signin');
  await expect(signIn).toHaveText('Sign in with Claude');

  await test.step('start: the link to Claude opens in a new tab, and Finish waits for a code', async () => {
    await signIn.click();
    const link = admin.page.getByTestId('claude-signin-link');
    await expect(link).toHaveAttribute('href', 'https://claude.example.test/oauth/authorize?n=1');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(admin.page.getByTestId('claude-code-submit')).toBeDisabled();
  });

  await test.step('a rejected code ends that sign-in: back to the start, with a way to begin again', async () => {
    await admin.page.getByTestId('claude-code').fill('wrong-code');
    await admin.page.getByTestId('claude-code-submit').click();
    await expect(admin.page.getByRole('alert')).toContainText('That code was not accepted.');
    await expect(admin.page.getByTestId('claude-code')).toHaveCount(0);
    await expect(admin.page.getByTestId('claude-signin-link')).toHaveCount(0);
    await expect(signIn).toHaveText('Start again');
    expect(calls.codes).toEqual([{ loginId: 'login_1', code: 'wrong-code' }]);
    expect(calls.cancels).toEqual([]); // the server already ended it; nothing to cancel
  });

  await test.step('starting again gives a new login; a pasted address is sent as code#state', async () => {
    await signIn.click();
    await expect(admin.page.getByTestId('claude-signin-link')).toHaveAttribute(
      'href',
      'https://claude.example.test/oauth/authorize?n=2',
    );
    await expect(admin.page.getByRole('alert')).toHaveCount(0);
    await admin.page
      .getByTestId('claude-code')
      .fill(
        'https://platform.claude.example.test/oauth/code/callback?code=good-code&state=good-state',
      );
    await admin.page.getByTestId('claude-code-submit').click();
    await expect(admin.page.getByTestId('claude-status')).toHaveText(
      'Signed in with a Claude subscription login (admin@example.test)',
    );
    expect(calls.codes.at(-1)).toEqual({ loginId: 'login_2', code: 'good-code#good-state' });
    await expect(signIn).toHaveCount(0);
    await expect(admin.page.getByTestId('claude-code')).toHaveCount(0);
  });

  await test.step('sign out', async () => {
    await admin.page.getByTestId('claude-signout').click();
    await expect(admin.page.getByTestId('claude-status')).toHaveText('Not signed in');
    expect(calls.logouts).toBe(1);
    await expect(signIn).toHaveText('Sign in with Claude');
  });
});

test('a sign-in left half done is cancelled: by Cancel, and by leaving the screen', async ({
  app,
}) => {
  const admin = await app.login(ADMIN);
  const calls = await mockClaude(admin.page);
  await admin.page.goto('/settings');
  await expect(admin.page.getByTestId('claude-signin')).toBeVisible();

  await admin.page.getByTestId('claude-signin').click();
  await expect(admin.page.getByTestId('claude-signin-link')).toBeVisible();
  await admin.page.getByTestId('claude-cancel').click();
  await expect(admin.page.getByTestId('claude-code')).toHaveCount(0);
  expect(calls.cancels).toEqual(['login_1']);

  await admin.page.getByTestId('claude-signin').click();
  await expect(admin.page.getByTestId('claude-signin-link')).toHaveAttribute('href', /n=2$/);
  await admin.page.getByRole('link', { name: 'Back to rooms' }).click();
  await expect(admin.page.getByTestId('room-create-name')).toBeVisible();
  await expect.poll(() => calls.cancels).toEqual(['login_1', 'login_2']);
});

test('Diagnostics: the admin downloads a compressed debug export; nobody else sees the card', async ({
  app,
}) => {
  const admin = await app.login(ADMIN);
  await admin.page.goto('/settings');
  await expect(admin.page.getByTestId('debug-status')).toContainText('Tracing on', {
    timeout: 30_000,
  });
  await admin.page.getByTestId('debug-window').selectOption({ label: 'Last 24 hours' });
  await admin.page.getByTestId('debug-repos').uncheck();
  await expect(admin.page.getByTestId('debug-export')).toHaveAttribute(
    'href',
    '/api/debug/export?sinceHours=24&repos=0',
  );
  const download = admin.page.waitForEvent('download');
  await admin.page.getByTestId('debug-export').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^quorum-debug-.*\.tar\.gz$/);
  const stream = await file.createReadStream();
  const head: Buffer = await new Promise((resolve, reject) => {
    stream.once('data', (c) => resolve(c as Buffer));
    stream.once('error', reject);
  });
  expect([head[0], head[1]]).toEqual([0x1f, 0x8b]); // gzip magic
  stream.destroy();

  const dave = await app.login('Dave');
  await dave.page.goto('/settings');
  await expect(dave.page.getByTestId('claude-admin-note')).toBeVisible();
  await expect(dave.page.getByTestId('debug-export')).toHaveCount(0);
});
