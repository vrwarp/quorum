import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { ADMIN, PASSWORD } from './identity.js';

export { ADMIN, PASSWORD };

/** A logged-in browser user. `errors` collects uncaught page exceptions and console errors. */
export interface Session {
  name: string;
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

/** Console errors every session produces and nobody should worry about: the app asks /api/me before it has a login. */
function isExpected(msg: ConsoleMessage): boolean {
  return /status of 401/.test(msg.text()) && /\/api\/me$/.test(msg.location().url);
}

/**
 * The browsers of one test. Every context it opens is closed when the test ends, whether it passed or not, and a
 * test that passed still fails if any page logged an error it did not declare with `expectConsoleError`.
 */
export class App {
  private readonly sessions: Session[] = [];
  private readonly declared: RegExp[] = [];

  constructor(private readonly browser: Browser) {}

  /** A new browser context, logged in as `name` (any name is registered on first use) and parked on the rooms list. */
  async login(name: string, options: { viewport?: { width: number; height: number } } = {}) {
    const ctx = await this.browser.newContext(
      options.viewport ? { viewport: options.viewport } : {},
    );
    const page = await ctx.newPage();
    const session: Session = { name, ctx, page, errors: [] };
    this.sessions.push(session); // before anything that can fail: teardown closes it either way
    page.on('pageerror', (err) => session.errors.push(`${name}: uncaught ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isExpected(msg))
        session.errors.push(`${name}: console.error ${msg.text()}`);
    });
    await page.goto('/');
    await page.getByTestId('login-name').fill(name);
    await page.getByTestId('login-password').fill(PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('room-create-name')).toBeVisible();
    return session;
  }

  /** A test that provokes browser errors on purpose (a refused WebSocket, a 4xx it handles) declares them here. */
  expectConsoleError(pattern: RegExp): void {
    this.declared.push(pattern);
  }

  /** Errors logged by any page that no `expectConsoleError` pattern covers. */
  unexpectedErrors(): string[] {
    return this.sessions
      .flatMap((s) => s.errors)
      .filter((e) => !this.declared.some((pattern) => pattern.test(e)));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.sessions.map((s) => s.ctx.close().catch(() => undefined)));
  }
}

export const test = base.extend<{ app: App }>({
  app: async ({ browser }, use) => {
    const app = new App(browser);
    try {
      await use(app);
    } finally {
      await app.closeAll();
    }
    // reached only when the test body did not throw
    expect(app.unexpectedErrors(), 'errors logged by the pages').toEqual([]);
  },
});
export { expect };

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

/** Opens the inline editor on the block containing `text`, sets the textarea to `replacement` and submits it. */
export async function suggest(page: Page, blockText: string, replacement: string) {
  await blockWith(page, blockText).getByRole('button').click();
  await page.getByTestId('suggest-textarea').fill(replacement);
  await page.getByTestId('suggest-submit').click();
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

/** Control of what the server's events look like to one page: hold some back, rewrite them, make some up. */
export interface SocketTap {
  /** Hold back server events of these types (they are delivered, in order, by `release`). */
  hold(...types: string[]): void;
  release(): void;
  /** Change each server event on its way to the page: return the event to deliver, or null to drop it. */
  rewrite(fn: ((ev: Record<string, unknown>) => Record<string, unknown> | null) | null): void;
  /** Deliver an event as if the server had sent it. */
  inject(ev: Record<string, unknown>): void;
  /** Refuse (true) or accept (false) new connections; refusing also drops the current one. */
  outage(on: boolean): Promise<void>;
}

/**
 * Puts the page's room WebSocket under test control. Playwright installs the interception as an init script, so it
 * applies from the next document on: the page is reloaded once. Call it before going into a room.
 */
export async function tapSocket(page: Page): Promise<SocketTap> {
  type Rewrite = ((ev: Record<string, unknown>) => Record<string, unknown> | null) | null;
  let held = new Set<string>();
  const queue: string[] = [];
  let rewrite: Rewrite = null;
  let current: WebSocketRoute | null = null;
  let down = false;
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    if (down) {
      void ws.close();
      return;
    }
    current = ws;
    const server = ws.connectToServer();
    server.onMessage((frame) => {
      const text = typeof frame === 'string' ? frame : frame.toString();
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(text) as Record<string, unknown>;
      } catch {
        ws.send(frame);
        return;
      }
      if (typeof ev.type === 'string' && held.has(ev.type)) {
        queue.push(text);
        return;
      }
      const out = rewrite ? rewrite(ev) : ev;
      if (out) ws.send(JSON.stringify(out));
    });
  });
  await page.reload();
  return {
    hold(...types) {
      held = new Set(types);
    },
    release() {
      held = new Set();
      for (const text of queue.splice(0)) current?.send(text);
    },
    rewrite(fn) {
      rewrite = fn;
    },
    inject(ev) {
      current?.send(JSON.stringify(ev));
    },
    async outage(on) {
      down = on;
      if (on) await current?.close();
    },
  };
}

/** The markdown source of a document on main, read through the API as `page`'s user. */
export async function documentSource(page: Page, roomId: string, title: string): Promise<string> {
  const state = await apiGet<{ documents: Array<{ id: string; title: string }> }>(
    page,
    `/api/rooms/${roomId}/state`,
  );
  const doc = state.documents.find((d) => d.title === title);
  if (!doc) throw new Error(`no document titled ${title}`);
  const r = await apiGet<{ content: string }>(
    page,
    `/api/rooms/${roomId}/documents/${doc.id}?ref=main`,
  );
  return r.content;
}
