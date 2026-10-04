import {
  blockWith,
  canvas,
  chatCards,
  createDocument,
  createRoom,
  documentSource,
  expect,
  openRoom,
  say,
  suggest,
  tapSocket,
  test,
} from './helpers.js';

/**
 * The document canvas: suggestion markers, the inline editor (Suggest and Ask), and what happens to an open editor
 * when the document changes underneath it. The fake runtime applies a suggestion the moment it arrives, so specs that
 * need one to stay pending hold back the server's `chat.updated` and `document.updated` events on the pages involved.
 */

test('pending marker: everyone sees it on the paragraph, whatever their view of the repository head', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const aliceSocket = await tapSocket(alice.page);
  const roomId = await createRoom(alice.page, 'Marker room');
  await createDocument(alice.page, 'Arch');
  await createDocument(alice.page, 'Spec');
  await alice.page.getByRole('tab', { name: 'Arch' }).click();

  const bob = await app.login('Bob');
  const bobSocket = await tapSocket(bob.page);
  await openRoom(bob.page, roomId);
  await bob.page.getByRole('tab', { name: 'Arch' }).click();

  // an unrelated change moves the repository head, which only Dave (who joins after it) sees as Arch's head
  await say(alice.page, 'add a section on storage to Spec');
  await expect(chatCards(alice.page, 'change')).toHaveCount(1, { timeout: 20_000 });
  await expect(chatCards(bob.page, 'change')).toHaveCount(1);
  const dave = await app.login('Dave');
  const daveSocket = await tapSocket(dave.page);
  await openRoom(dave.page, roomId);
  await dave.page.getByRole('tab', { name: 'Arch' }).click();
  const everyone = [alice, bob, dave];
  for (const s of everyone)
    await expect(canvas(s.page).getByRole('heading', { name: 'Arch' })).toBeVisible();

  // keep the suggestion pending on every page: the agent would apply it within milliseconds
  for (const tap of [aliceSocket, bobSocket, daveSocket])
    tap.hold('chat.updated', 'document.updated');
  await suggest(alice.page, 'Arch', '# Architecture');

  for (const s of everyone) {
    await expect(chatCards(s.page, 'suggestion')).toHaveCount(1);
    await expect(chatCards(s.page, 'suggestion')).toContainText('pending');
    await expect(s.page.getByTestId('pending-1'), `${s.name} sees the marker`).toBeVisible();
    await expect(s.page.getByTestId('block-1')).toHaveClass(/has-pending/);
  }

  // resolved: the marker goes for everyone and the paragraph reads as suggested
  for (const tap of [aliceSocket, bobSocket, daveSocket]) tap.release();
  for (const s of everyone) {
    await expect(chatCards(s.page, 'suggestion')).toContainText('applied');
    await expect(s.page.getByTestId('pending-1')).toHaveCount(0);
    await expect(canvas(s.page).getByRole('heading', { name: 'Architecture' })).toBeVisible();
  }
});

test('selecting text offers Ask, which posts a question about the paragraph', async ({ app }) => {
  const alice = await app.login('Alice');
  const roomId = await createRoom(alice.page, 'Ask room');
  await createDocument(alice.page, 'Notes');
  const bob = await app.login('Bob');
  await openRoom(bob.page, roomId);
  await say(alice.page, 'add a section on caching');
  await expect(canvas(alice.page)).toContainText('Placeholder text about Caching');

  const paragraph = blockWith(alice.page, 'Placeholder text about Caching').locator('p');
  await expect(alice.page.getByTestId('ask-button')).toHaveCount(0);
  await paragraph.selectText();
  const floating = alice.page.getByTestId('ask-button');
  await expect(floating).toBeVisible();
  await floating.click();

  // the editor is open with the question box ready, and the floating button has gone
  await expect(alice.page.getByTestId('ask-input')).toBeFocused();
  await expect(alice.page.getByTestId('suggest-textarea')).toBeVisible();
  await expect(alice.page.getByTestId('ask-button')).toHaveCount(0);
  await alice.page.getByTestId('ask-input').fill('Why is caching in scope?');
  await alice.page.keyboard.press('Enter');

  for (const page of [alice.page, bob.page]) {
    await expect(chatCards(page, 'ask')).toContainText('Why is caching in scope?');
    await expect(chatCards(page, 'ask')).toContainText('Placeholder text about Caching');
    await expect(
      page.locator('[data-testid^="message-"]', {
        hasText: /Here is the history of line \d+ of Notes/,
      }),
    ).toHaveCount(1, { timeout: 20_000 });
  }
  await expect(alice.page.getByTestId('suggest-textarea')).toHaveCount(0);
});

test('concurrent edit: a suggestion stays on the paragraph it was written on, never on a different one', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const roomId = await createRoom(alice.page, 'Concurrency room');
  await createDocument(alice.page, 'Arch');
  await say(alice.page, 'add a section on alpha');
  await expect(canvas(alice.page)).toContainText('Placeholder text about Alpha');
  await say(alice.page, 'add a section on beta');
  await expect(canvas(alice.page)).toContainText('Placeholder text about Beta');
  const bob = await app.login('Bob');
  await openRoom(bob.page, roomId);
  await expect(canvas(bob.page)).toContainText('Placeholder text about Beta');

  // Alice starts editing the Beta paragraph (line 9) and does not submit yet
  await blockWith(alice.page, 'Placeholder text about Beta').getByRole('button').click();
  const editor = alice.page.getByTestId('suggest-textarea');
  await editor.fill('Beta, as Alice wants it.');
  await expect(alice.page.getByTestId('editor-stale-notice')).toHaveCount(0);

  // meanwhile Bob turns the Alpha paragraph into two, which moves everything below it down by two lines
  await suggest(bob.page, 'Placeholder text about Alpha', 'Alpha one.\n\nAlpha two.');
  await expect(canvas(alice.page)).toContainText('Alpha two.', { timeout: 20_000 });

  // Alice's editor is still open on her text, says the paragraph changed under her, and moved with it
  await expect(alice.page.getByTestId('editor-stale-notice')).toBeVisible();
  await expect(editor).toHaveValue('Beta, as Alice wants it.');
  await expect(alice.page.locator('.block.editing')).toHaveCount(1);
  await expect(
    canvas(alice.page).getByRole('heading', { name: 'Beta', exact: true }),
  ).toBeVisible();

  await alice.page.getByTestId('suggest-submit').click();
  await expect(chatCards(alice.page, 'suggestion')).toHaveCount(2);
  const card = chatCards(alice.page, 'suggestion').nth(1);
  // her card is about the paragraph she edited (what the card quotes), not about whatever sits on its old line now
  await expect(card).toContainText('Placeholder text about Beta');
  await expect(card).toContainText('Alice wants it.');
  await expect(card).toContainText('line 9'); // the line it was written on, not where the paragraph is now
  await expect(card).not.toContainText('pending', { timeout: 20_000 });

  // nothing was overwritten: the heading is intact and Beta's text is either as it was or as Alice wrote it
  await expect(
    canvas(alice.page).getByRole('heading', { name: 'Beta', exact: true }),
  ).toBeVisible();
  const lines = (await documentSource(alice.page, roomId, 'Arch')).split('\n').filter(Boolean);
  const heading = lines.indexOf('## Beta');
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(lines[heading + 1]).toMatch(/^(Placeholder text about Beta|Beta, as Alice wants it\.)/);
  expect(lines).toContain('Alpha one.');
  expect(lines).toContain('Alpha two.');
});

test('an open editor does not follow the person to another document', async ({ app }) => {
  const alice = await app.login('Alice');
  await createRoom(alice.page, 'Tabs room');
  await createDocument(alice.page, 'One');
  await createDocument(alice.page, 'Two');
  await alice.page.getByRole('tab', { name: 'One' }).click();

  await blockWith(alice.page, 'One').getByRole('button').click();
  await expect(alice.page.getByTestId('suggest-textarea')).toBeVisible();
  await alice.page.getByRole('tab', { name: 'Two' }).click();
  await expect(canvas(alice.page).getByRole('heading', { name: 'Two' })).toBeVisible();
  await expect(alice.page.getByTestId('suggest-textarea')).toHaveCount(0);
  await alice.page.getByRole('tab', { name: 'One' }).click();
  await expect(canvas(alice.page).getByRole('heading', { name: 'One' })).toBeVisible();
  await expect(alice.page.getByTestId('suggest-textarea')).toHaveCount(0);
});

test('the keyboard stays where the person is: chat after Send, the editor, the diff drawer', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const roomId = await createRoom(alice.page, 'Focus room');
  await createDocument(alice.page, 'Notes');
  const bob = await app.login('Bob');
  await openRoom(bob.page, roomId);
  await say(alice.page, 'add a section on focus');
  await expect(canvas(alice.page)).toContainText('Placeholder text about Focus');

  await test.step('after Send the message box keeps the keyboard', async () => {
    await alice.page.getByTestId('chat-input').fill('hello there');
    await alice.page.getByTestId('chat-send').click();
    await expect(alice.page.getByTestId('chat-input')).toHaveValue('');
    await expect(alice.page.getByTestId('chat-input')).toBeFocused();
    await alice.page.keyboard.type('and one more');
    await expect(alice.page.getByTestId('chat-input')).toHaveValue('and one more');
    await alice.page.getByTestId('chat-input').fill('');
  });

  await test.step('the editor opens with the caret at the end, Ctrl+Enter suggests, focus returns to the paragraph', async () => {
    const block = blockWith(alice.page, 'Placeholder text about Focus');
    const blockId = (await block.getAttribute('data-testid'))!;
    await block.getByRole('button').click();
    const editor = alice.page.getByTestId('suggest-textarea');
    await expect(editor).toBeFocused();
    await alice.page.keyboard.type(' More words.');
    await expect(editor).toHaveValue(/^Placeholder text about Focus.* More words\.$/);
    await alice.page.keyboard.press('Control+Enter');
    await expect(chatCards(alice.page, 'suggestion')).toHaveCount(1);
    await expect(editor).toHaveCount(0);
    await expect(alice.page.getByTestId(blockId).locator('.block-view')).toBeFocused();
    await expect(chatCards(alice.page, 'suggestion')).toContainText('applied', { timeout: 20_000 });
  });

  await test.step('a room event does not pull focus around inside an open diff drawer', async () => {
    const viewDiff = chatCards(alice.page, 'change')
      .first()
      .getByRole('button', { name: 'View diff' });
    await viewDiff.click();
    await expect(alice.page.getByTestId('diff-close')).toBeFocused();
    await alice.page.getByTestId('diff-raw-toggle').click();
    await expect(alice.page.getByTestId('diff-raw-toggle')).toBeFocused();
    await say(bob.page, 'carry on');
    await expect(alice.page.getByText('carry on')).toBeVisible();
    await expect(alice.page.getByTestId('diff-raw-toggle')).toBeFocused();
    await alice.page.keyboard.press('Escape');
    await expect(alice.page.getByTestId('diff-drawer')).toHaveCount(0);
    await expect(viewDiff).toBeFocused(); // back on what opened it
  });
});

test('document links open in a new tab and do not open the editor', async ({ app }) => {
  const alice = await app.login('Alice');
  await createRoom(alice.page, 'Links room');
  await createDocument(alice.page, 'Links');
  await suggest(alice.page, 'Links', 'See [the docs](https://example.test/docs) for details.');
  const link = canvas(alice.page).getByRole('link', { name: 'the docs' });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('rel', /noreferrer/);

  await alice.ctx.route('https://example.test/**', (route) => route.fulfill({ body: 'external' }));
  const [popup] = await Promise.all([alice.ctx.waitForEvent('page'), link.click()]);
  expect(popup.url()).toBe('https://example.test/docs');
  await popup.close();
  // the room tab stayed where it was and no editor opened behind the click
  await expect(alice.page).toHaveURL(/\/rooms\/room_/);
  await expect(alice.page.getByTestId('suggest-textarea')).toHaveCount(0);
});
