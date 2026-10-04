import {
  canvas,
  chatCards,
  createDocument,
  createRoom,
  expect,
  openRoom,
  PASSWORD,
  say,
  tapSocket,
  test,
} from './helpers.js';

/** The room as a whole: archiving, rejected commands, the agent banner, odd server behaviour, layout, long absences. */

test('archiving the room: the owner confirms, then everyone has a read-only room that leaves the list', async ({
  app,
}) => {
  const olga = await app.login('Olga');
  const roomId = await createRoom(olga.page, 'Archive me');
  await createDocument(olga.page, 'Notes');
  const gus = await app.login('Gus');
  await openRoom(gus.page, roomId);
  await expect(canvas(gus.page)).toContainText('Notes');

  await test.step('only the owner has the action, and it asks first', async () => {
    await expect(gus.page.getByTestId('room-archive')).toHaveCount(0);
    await olga.page.getByTestId('room-archive').click();
    await expect(olga.page.getByTestId('room-archive-confirm')).toContainText('Archive this room?');
    await olga.page.getByTestId('room-archive-cancel').click();
    await expect(olga.page.getByTestId('room-archive-confirm')).toHaveCount(0);
    await expect(olga.page.getByTestId('room-archived-banner')).toHaveCount(0);
    await expect(olga.page.getByTestId('chat-input')).toBeEnabled();
  });

  await test.step('confirming archives it for both: banner, nothing editable, a note in the chat', async () => {
    await olga.page.getByTestId('room-archive').click();
    await olga.page.getByTestId('room-archive-yes').click();
    for (const page of [olga.page, gus.page]) {
      await expect(page.getByTestId('room-archived-banner')).toContainText(
        'archived and read-only',
      );
      await expect(page.getByText('Olga archived the room.')).toBeVisible();
      await expect(page.getByTestId('chat-input')).toBeDisabled();
      await expect(page.getByTestId('chat-send')).toBeDisabled();
      await expect(page.getByTestId('doc-create')).toBeDisabled();
      await expect(page.getByTestId('doc-menu')).toBeDisabled();
      // paragraphs are text now, not buttons that open an editor
      await expect(page.getByTestId('block-1').getByRole('button')).toHaveCount(0);
    }
    await expect(olga.page.getByTestId('rule-select')).toBeDisabled();
    await expect(olga.page.getByTestId('room-archive')).toHaveCount(0);
  });

  await test.step('it cannot be joined again, says so, and the rooms list no longer offers it', async () => {
    await gus.page.reload();
    await expect(gus.page.getByTestId('room-archived-notice')).toContainText(
      'archived and can no longer be joined',
    );
    await expect(gus.page.getByText('Connecting…')).toHaveCount(0);
    await expect(gus.page.getByTestId('chat-input')).toHaveCount(0);
    await gus.page.getByRole('link', { name: 'Back to rooms' }).click();
    await expect(gus.page.getByTestId('room-create-name')).toBeVisible();
    await expect(gus.page.getByTestId(`room-link-${roomId}`)).toHaveCount(0);
  });
});

test('commands the server rejects give the input back with the reason next to it', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const aliceSocket = await tapSocket(alice.page);
  const roomId = await createRoom(alice.page, 'Rejections');
  await createDocument(alice.page, 'Notes');
  const bob = await app.login('Bob');
  await openRoom(bob.page, roomId);

  await test.step('a message over the limit comes back, and the next one goes through', async () => {
    const tooLong = 'x'.repeat(20_001);
    await alice.page.getByTestId('chat-input').fill(tooLong);
    await alice.page.getByTestId('chat-send').click();
    await expect(alice.page.getByTestId('chat-error')).toContainText('20000');
    await expect(alice.page.getByTestId('chat-input')).toHaveValue(tooLong);
    await expect(alice.page.locator('.banner.error')).toHaveCount(0); // it is not a room-wide matter
    await alice.page.getByTestId('chat-input').fill('short and fine');
    await expect(alice.page.getByTestId('chat-error')).toHaveCount(0);
    await alice.page.getByTestId('chat-send').click();
    await expect(bob.page.getByText('short and fine')).toBeVisible();
  });

  await test.step('a title over the limit brings the form back, and a document made by someone else does not steal the tab', async () => {
    await alice.page.getByTestId('doc-create').click();
    const title = 'T'.repeat(81);
    await alice.page.getByTestId('doc-create-title').fill(title);
    await alice.page.getByTestId('doc-create-submit').click();
    await expect(alice.page.getByTestId('doc-error')).toContainText('1-80');
    await expect(alice.page.getByTestId('doc-create-title')).toHaveValue(title);
    await createDocument(bob.page, 'Bobs notes');
    await expect(alice.page.getByRole('tab', { name: 'Bobs notes' })).toBeVisible();
    await expect(alice.page.getByRole('tab', { name: 'Notes', selected: true })).toBeVisible();
  });

  await test.step('Revert on a card that is out of date says so each time and never sticks', async () => {
    await say(alice.page, 'add a section on caching');
    await expect(chatCards(alice.page, 'change')).toHaveCount(1, { timeout: 20_000 });
    await expect(chatCards(bob.page, 'change')).toHaveCount(1);
    // Alice's view of the card stays as it was while Bob reverts the change
    aliceSocket.hold('chat.updated');
    await chatCards(bob.page, 'change').first().getByRole('button', { name: 'Revert' }).click();
    await expect(chatCards(bob.page, 'change').first()).toContainText('reverted');
    await expect(chatCards(alice.page, 'change')).toHaveCount(2);

    const stale = chatCards(alice.page, 'change').first();
    const revert = stale.getByRole('button', { name: 'Revert', exact: true });
    for (const attempt of [1, 2]) {
      await revert.click();
      await expect(stale.getByTestId('card-error'), `attempt ${attempt}`).toContainText(
        'already reverted',
      );
      await expect(revert).toBeEnabled();
      await alice.page.getByTestId('chat-input').click(); // the message is dismissed only by the next try
    }
    aliceSocket.release();
    await expect(stale.getByRole('button', { name: 'Reverted', exact: true })).toBeDisabled();
  });
});

test('the agent banner says why it is unavailable, and links to Settings only when signing in would help', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const socket = await tapSocket(alice.page);
  const signIn = 'Sign in to Claude in Settings';
  // the reason arrives with the room snapshot ...
  socket.rewrite((ev) =>
    ev.type === 'hello'
      ? {
          ...ev,
          state: { ...(ev.state as object), agentStatus: 'unavailable', agentDetail: signIn },
        }
      : ev,
  );
  await createRoom(alice.page, 'Banner room');
  const banner = alice.page.getByTestId('agent-unavailable-banner');
  await expect(banner).toContainText('The agent is not signed in');
  await expect(alice.page.getByTestId('agent-status')).toHaveAttribute('title', signIn);
  await expect(alice.page.getByTestId('agent-banner-settings')).toBeVisible();

  // ... and with later status events; anything but a missing sign-in is shown as the server wrote it, with no link
  socket.inject({
    type: 'agent.status',
    status: 'unavailable',
    detail: 'The Claude account has a billing problem',
  });
  await expect(banner).toContainText(
    'The agent is unavailable: The Claude account has a billing problem',
  );
  await expect(alice.page.getByTestId('agent-banner-settings')).toHaveCount(0);
  socket.inject({ type: 'agent.status', status: 'unavailable', detail: null });
  await expect(banner).toHaveText('The agent is unavailable.');

  socket.inject({ type: 'agent.status', status: 'idle', detail: null });
  await expect(banner).toHaveCount(0);

  // the link goes to Settings
  socket.inject({ type: 'agent.status', status: 'unavailable', detail: signIn });
  await alice.page.getByTestId('agent-banner-settings').click();
  await expect(alice.page).toHaveURL(/\/settings$/);
});

test('an event type the client does not know is ignored; a broken one shows a way back instead of a blank page', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const socket = await tapSocket(alice.page);
  await createRoom(alice.page, 'Odd events');
  await createDocument(alice.page, 'Notes');

  socket.inject({ type: 'quorum.future.thing', payload: { a: 1 } });
  await say(alice.page, 'still here');
  await expect(alice.page.getByText('still here')).toBeVisible();
  await expect(canvas(alice.page)).toContainText('Notes');

  // a known event with a malformed body breaks rendering: the screen says so and Reload brings the room back
  // React reports the TypeError it caught, and the boundary says which screen failed: those two, nothing else
  app.expectConsoleError(/TypeError: Cannot read properties of null \(reading 'filter'\)/);
  app.expectConsoleError(/Quorum could not render this screen/);
  socket.inject({ type: 'presence.update', presence: null });
  await expect(alice.page.getByTestId('error-boundary')).toBeVisible();
  await expect(alice.page.getByTestId('chat-input')).toHaveCount(0);
  await alice.page.getByRole('button', { name: 'Reload' }).click();
  await expect(alice.page.getByTestId('chat-input')).toBeVisible();
  await expect(alice.page.getByText('still here')).toBeVisible();
});

test('an unknown room says so instead of connecting forever', async ({ app }) => {
  app.expectConsoleError(/WebSocket connection to .* failed|status of 404/);
  const alice = await app.login('Alice');
  let sockets = 0;
  alice.page.on('websocket', () => (sockets += 1));
  await alice.page.goto('/rooms/room_doesnotexist');
  await expect(alice.page.getByTestId('room-not-found')).toBeVisible();
  await expect(alice.page.getByText('Connecting…')).toHaveCount(0);
  // a client that kept retrying would have opened two or three more sockets by now (0.5 s, 1 s, 2 s ...)
  await alice.page.waitForTimeout(2500);
  expect(sockets).toBe(1);
  await alice.page.getByRole('link', { name: 'Back to rooms' }).click();
  await expect(alice.page.getByTestId('room-create-name')).toBeVisible();
});

test('a revoked session ends the room with a way back to the login, not an endless reconnect', async ({
  app,
}) => {
  app.expectConsoleError(/WebSocket connection to .* failed|status of 401/);
  const alice = await app.login('Alice');
  const socket = await tapSocket(alice.page);
  const roomId = await createRoom(alice.page, 'Session room');
  await say(alice.page, 'before the logout');

  // the session is revoked elsewhere and the connection drops; the next connection is refused with a 401
  await alice.page.evaluate(() => fetch('/api/logout', { method: 'POST', credentials: 'include' }));
  await socket.outage(true);
  await socket.outage(false);
  await expect(alice.page.getByTestId('room-session-ended')).toBeVisible();
  await expect(alice.page.getByText('Reconnecting…')).toHaveCount(0);

  await alice.page.getByRole('button', { name: 'Log in again' }).click();
  await alice.page.getByTestId('login-name').fill('Alice');
  await alice.page.getByTestId('login-password').fill(PASSWORD);
  await alice.page.getByTestId('login-submit').click();
  // back where she was, with the history
  await expect(alice.page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await expect(alice.page.getByText('before the logout')).toBeVisible();
});

test('a narrow window stacks chat, document and rail without overlap, and the page scrolls', async ({
  app,
}) => {
  const pat = await app.login('Pat', { viewport: { width: 683, height: 768 } });
  await createRoom(pat.page, 'Narrow room');
  await createDocument(pat.page, 'Spec');
  for (const topic of ['alpha', 'beta', 'gamma']) {
    await say(pat.page, `add a section on ${topic}`);
    await expect(canvas(pat.page)).toContainText(
      `Placeholder text about ${topic[0]!.toUpperCase()}${topic.slice(1)}`,
    );
  }

  const box = async (selector: string) => {
    const b = await pat.page.locator(selector).boundingBox();
    expect(b, selector).not.toBeNull();
    return b!;
  };
  const chat = await box('section[aria-label="Chat"]');
  const paper = await box('section[aria-label="Document"]');
  const rail = await box('aside[aria-label="Branch rail"]');
  expect(chat.y + chat.height).toBeLessThanOrEqual(paper.y + 1);
  expect(paper.y + paper.height).toBeLessThanOrEqual(rail.y + 1);
  // every pane is usable: tall enough to show something, not squeezed to a sliver
  expect(chat.height).toBeGreaterThan(250);
  expect(paper.height).toBeGreaterThan(250);

  // nothing sticks out sideways, and the usage footer at the bottom can be scrolled to
  expect(
    await pat.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await pat.page.getByTestId('usage').scrollIntoViewIfNeeded();
  await expect(pat.page.getByTestId('usage')).toBeInViewport();
});

test('a long absence: messages missed beyond what a snapshot carries are fetched in order', async ({
  app,
}) => {
  const fay = await app.login('Fay');
  const socket = await tapSocket(fay.page);
  const roomId = await createRoom(fay.page, 'Long absence');
  await say(fay.page, 'before the outage');
  const gus = await app.login('Gus');
  await openRoom(gus.page, roomId);

  await socket.outage(true);
  await expect(fay.page.getByText('Reconnecting…')).toBeVisible();
  // Gus says 210 things in a burst, more than the 200 messages a snapshot holds
  await gus.page.evaluate(async (id) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?roomId=${id}`);
    const last = new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data)) as { type: string; message?: { body: string } };
        if (ev.type === 'chat.message' && ev.message?.body === 'bulk 210') resolve();
      };
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('could not open the socket'));
    });
    for (let i = 1; i <= 210; i++)
      ws.send(JSON.stringify({ type: 'chat.send', body: `bulk ${i}` }));
    await last;
    ws.close();
  }, roomId);

  await socket.outage(false);
  const bulk = fay.page.getByText(/^bulk \d+$/);
  await expect(bulk).toHaveCount(210, { timeout: 30_000 });
  await expect(fay.page.getByText('Reconnecting…')).toHaveCount(0);
  // the transcript is whole and in order: what she had, then every missed message, nothing twice
  const texts = await fay.page.locator('[data-testid^="message-"]').allInnerTexts();
  const numbers = texts
    .map((t) => /\bbulk (\d+)\s*$/.exec(t.trim())?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  expect(numbers).toEqual(Array.from({ length: 210 }, (_, i) => i + 1));
  expect(texts.findIndex((t) => t.includes('before the outage'))).toBeLessThan(
    texts.findIndex((t) => /\bbulk 1\s*$/.test(t.trim())),
  );
});
