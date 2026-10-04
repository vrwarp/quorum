import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

export const PASSWORD = 'e2e-password';

/** A logged-in browser user. `errors` collects uncaught page exceptions so a spec can assert there were none. */
export interface Session {
  name: string;
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

export async function login(browser: Browser, name: string): Promise<Session> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
  await page.goto('/');
  await page.getByTestId('login-name').fill(name);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('room-create-name')).toBeVisible();
  return { name, ctx, page, errors };
}

export async function createRoom(page: Page, name: string): Promise<string> {
  await page.getByTestId('room-create-name').fill(name);
  await page.getByTestId('room-create-submit').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(page.getByTestId('room-name')).toHaveText(name);
  return new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;
}

export async function openRoom(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

export async function say(page: Page, text: string) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
  // the input clears once the command went out on the socket
  await expect(page.getByTestId('chat-input')).toHaveValue('');
}

/** Creates a document through the UI and waits until it is the open tab with its (initial) content rendered. */
export async function createDocument(page: Page, title: string) {
  await page.getByTestId('doc-create').click();
  await page.getByTestId('doc-create-title').fill(title);
  await page.getByTestId('doc-create-submit').click();
  await expect(page.getByRole('tab', { name: title, selected: true })).toBeVisible();
  await expect(canvas(page)).toContainText(title);
}

/** The rendered document on the canvas (blocks are rendered markdown, one per source line). */
export function canvas(page: Page): Locator {
  return page.getByTestId('doc-content');
}

/** The canvas block (`block-<line>`) whose rendered text contains `text`. */
export function blockWith(page: Page, text: string): Locator {
  return page.locator('[data-testid^="block-"]', { hasText: text });
}

export function chatCards(
  page: Page,
  kind: 'change' | 'suggestion' | 'ask' | 'review' | 'quorum' | 'digest' | 'merge' | 'exploration',
): Locator {
  return page.getByTestId(`card-${kind}`);
}

export async function userIdOf(page: Page): Promise<string> {
  const me = await page.evaluate(async () =>
    (await fetch('/api/me', { credentials: 'include' })).json(),
  );
  return (me as { userId: string }).userId;
}

/** GET a JSON API route with the page's own session cookie. */
export async function apiGet<T>(page: Page, path: string): Promise<T> {
  return (await page.evaluate(
    async (p) => (await fetch(p, { credentials: 'include' })).json(),
    path,
  )) as T;
}
