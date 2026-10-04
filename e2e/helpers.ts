import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-password';

export async function login(browser: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('login-name').fill(name);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('room-create-name')).toBeVisible();
  return { ctx, page };
}

export async function createRoom(page: Page, name: string): Promise<string> {
  await page.getByTestId('room-create-name').fill(name);
  await page.getByTestId('room-create-submit').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  const url = new URL(page.url());
  const roomId = url.pathname.split('/').filter(Boolean).pop()!;
  return roomId;
}

export async function openRoom(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

export async function say(page: Page, text: string) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}

export async function createDocument(page: Page, title: string) {
  await page.getByTestId('doc-create').click();
  await page.getByTestId('doc-create-title').fill(title);
  await page.getByTestId('doc-create-submit').click();
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
}
