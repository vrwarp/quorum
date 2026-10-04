import { expect, test, type WebSocketRoute } from '@playwright/test';
import {
  apiGet,
  blockWith,
  canvas,
  chatCards,
  createDocument,
  createRoom,
  login,
  openRoom,
  say,
  userIdOf,
} from './helpers.js';

/**
 * These specs drive the real server (built, QUORUM_RUNTIME=fake) through the real client in Chromium. The fake runtime
 * is deterministic: it reacts to the phrases below (all of its behaviors: packages/server/src/agents/fake/README.md):
 *   "add a section on <topic>"            -> immediate change on main (Change card)
 *   "let's use X" + "Y makes more sense"  -> exploration of X vs Y -> Quorum proposal with options A (X), B (Y), C (X with Y fallback)
 *   "rewrite the whole document"          -> Review proposal
 * Suggestions are applied at once, asks are answered from `git log -L`, and the rejoin digest lists notable events.
 * Server tunables (e2e/playwright.config.ts): digest absence 1.5 s, review window 4 s, listener debounce 200 ms.
 */

test('canonical scenario: direct request, divergence vote, suggestion, ask, revert, rejoin digest', async ({
  browser,
}) => {
  const alice = await login(browser, 'Alice');
  const roomId = await createRoom(alice.page, 'Design review');
  await createDocument(alice.page, 'Architecture');

  const bob = await login(browser, 'Bob');
  await openRoom(bob.page, roomId);
  const [aliceId, bobId] = [await userIdOf(alice.page), await userIdOf(bob.page)];
  const both = [alice.page, bob.page];

  await test.step('presence: both see each other and the document', async () => {
    await expect(alice.page.getByTestId(`presence-${bobId}`)).toBeVisible();
    await expect(bob.page.getByTestId(`presence-${aliceId}`)).toBeVisible();
    await expect(canvas(bob.page)).toContainText('Architecture');
  });

  await test.step('1. a direct request lands on main as a Change card, visible to both', async () => {
    await say(alice.page, 'We should add a section on latency requirements');
    for (const page of both) {
      await expect(chatCards(page, 'change')).toHaveCount(1);
      await expect(chatCards(page, 'change').first()).toContainText('Latency Requirements');
      await expect(
        canvas(page).getByRole('heading', { name: 'Latency Requirements' }),
      ).toBeVisible();
    }
    // the card links the diff: word-level by default, raw git diff on request
    await chatCards(bob.page, 'change').first().getByRole('button', { name: 'View diff' }).click();
    const drawer = bob.page.getByTestId('diff-drawer');
    await expect(drawer.getByTestId('word-diff')).toContainText('Latency Requirements');
    await expect(drawer.locator('ins').first()).toBeVisible();
    await drawer.getByTestId('diff-raw-toggle').click();
    await expect(drawer).toContainText('+## Latency Requirements');
    await bob.page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  await test.step('2. divergence: exploration, Quorum card with three options, both vote C, merge', async () => {
    await say(alice.page, "Let's use PostgreSQL for the storage layer");
    await expect(bob.page.getByText("Let's use PostgreSQL for the storage layer")).toBeVisible();
    await say(bob.page, 'ClickHouse makes more sense for this write volume');

    await expect(chatCards(alice.page, 'exploration')).toContainText('PostgreSQL vs ClickHouse');
    const quorum = chatCards(alice.page, 'quorum');
    await expect(quorum).toHaveCount(1, { timeout: 30_000 });
    await expect(quorum.locator('[data-testid^="vote-"]')).toHaveCount(3);

    await expect(quorum.locator('[data-testid^="option-"]')).toHaveCount(3);
    const optionC = quorum.locator('[data-testid^="option-"]', { hasText: 'Option C' });
    await expect(optionC).toContainText('PostgreSQL');
    await expect(optionC).toContainText('ClickHouse');
    const optionCId = (await optionC.getAttribute('data-testid'))!.replace('option-', '');
    // the chat follows the new card to its end: the last option's vote button is on screen without scrolling
    await expect(alice.page.getByTestId(`vote-${optionCId}`)).toBeInViewport();
    await expect(quorum).toContainText(/Rule: unanimous/i);

    // each option links its diff against main ...
    await quorum.getByTestId(`diff-${optionCId}`).click();
    const drawer = alice.page.getByTestId('diff-drawer');
    await expect(drawer.getByTestId('word-diff')).toContainText(
      'Decision: PostgreSQL with ClickHouse fallback',
    );
    await alice.page.getByTestId('diff-close').click();
    await expect(drawer).toHaveCount(0);
    // ... and the rail shows any branch read-only while main stays as it was
    await expect(
      alice.page.getByTestId('rail').getByRole('heading', { name: /^Open \(1\)/ }),
    ).toBeVisible();
    await alice.page.locator('[data-testid^="rail-option-"]').nth(1).click();
    await expect(alice.page.getByTestId('branch-banner')).toContainText('option B');
    await expect(
      canvas(alice.page).getByRole('heading', { name: 'Decision: ClickHouse', exact: true }),
    ).toBeVisible();
    await expect(
      blockWith(alice.page, 'Latency Requirements').first().getByRole('button'),
    ).toHaveCount(0); // read-only
    await alice.page.getByTestId('branch-exit').click();
    await expect(alice.page.getByTestId('branch-banner')).toHaveCount(0);
    await expect(canvas(alice.page)).not.toContainText('Decision:');

    // Alice votes: one vote on the tally for everyone, but unanimity needs Bob too
    await alice.page.getByTestId(`vote-${optionCId}`).click();
    for (const page of both)
      await expect(page.getByTestId(`tally-${optionCId}`)).toHaveText('1 vote');
    await expect(chatCards(alice.page, 'merge')).toHaveCount(0);
    await expect(chatCards(bob.page, 'quorum').getByTestId(`vote-${optionCId}`)).toBeEnabled();

    await chatCards(bob.page, 'quorum').getByTestId(`vote-${optionCId}`).click();
    for (const page of both) {
      await expect(chatCards(page, 'merge')).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByTestId(`tally-${optionCId}`)).toHaveText('2 votes');
      await expect(chatCards(page, 'quorum')).toContainText('merged');
      // the merged content is option C only; the losing options never reach main
      await expect(
        canvas(page).getByRole('heading', {
          name: 'Decision: PostgreSQL with ClickHouse fallback',
        }),
      ).toBeVisible();
      await expect(
        canvas(page).getByRole('heading', { name: 'Decision: PostgreSQL', exact: true }),
      ).toHaveCount(0);
      await expect(
        canvas(page).getByRole('heading', { name: 'Decision: ClickHouse', exact: true }),
      ).toHaveCount(0);
      await expect(page.locator('[data-testid^="rail-proposal-"].state-merged')).toHaveCount(1);
    }
    await expect(alice.page.getByText(/\(option C\)/)).toBeVisible();
  });

  await test.step('3. a suggestion on a paragraph is applied and shows as a Change card', async () => {
    await blockWith(alice.page, 'Placeholder text about Latency Requirements')
      .getByRole('button')
      .click();
    const textarea = alice.page.getByTestId('suggest-textarea');
    await expect(textarea).toBeVisible();
    const original = await textarea.inputValue();
    await textarea.fill(original.replace('Placeholder', 'Draft'));
    await alice.page.getByTestId('suggest-submit').click();

    for (const page of both) {
      await expect(chatCards(page, 'suggestion')).toHaveCount(1);
      await expect(chatCards(page, 'suggestion')).toContainText(/applied/i, { timeout: 20_000 });
      await expect(canvas(page)).toContainText('Draft text about Latency Requirements');
      await expect(canvas(page)).not.toContainText('Placeholder text');
      await expect(chatCards(page, 'change')).toHaveCount(2);
      await expect(chatCards(page, 'change').last()).toContainText('Alice');
    }
  });

  await test.step('4. asking about a passage gets an answer from its history', async () => {
    await blockWith(alice.page, 'Draft text about Latency Requirements')
      .getByRole('button')
      .click();
    await alice.page.getByTestId('ask-button').click();
    await alice.page.getByTestId('ask-input').fill('Why does this paragraph say this?');
    await alice.page.getByTestId('ask-submit').click();

    for (const page of both) {
      await expect(chatCards(page, 'ask')).toContainText('Why does this paragraph say this?');
      const answer = page.locator('[data-testid^="message-"]', {
        hasText: /Here is the history of line \d+ of Architecture/,
      });
      await expect(answer).toHaveCount(1, { timeout: 20_000 });
      // it quotes the chat message that caused the paragraph in the first place
      await expect(answer).toContainText('We should add a section on latency requirements');
    }
  });

  await test.step('5. a participant reverts the latest change', async () => {
    const suggestionChange = chatCards(bob.page, 'change').last();
    await suggestionChange.getByRole('button', { name: 'Revert' }).click();

    for (const page of both) {
      await expect(chatCards(page, 'change')).toHaveCount(3);
      await expect(chatCards(page, 'change').nth(1)).toContainText('reverted');
      await expect(chatCards(page, 'change').last()).toContainText('Reverted');
      await expect(chatCards(page, 'change').last()).toContainText('Bob');
      await expect(canvas(page)).toContainText('Placeholder text about Latency Requirements');
      await expect(canvas(page)).not.toContainText('Draft text');
    }
  });

  await test.step('6. a returning participant gets a digest that only they can see', async () => {
    await bob.page.goto('about:blank');
    await expect(alice.page.getByTestId(`presence-${bobId}`)).toHaveCount(0);
    await alice.page.waitForTimeout(1800); // longer than QUORUM_DIGEST_ABSENCE_MS (1500)
    await say(alice.page, 'add a section on deployment');
    await expect(chatCards(alice.page, 'change')).toHaveCount(4, { timeout: 20_000 });

    await openRoom(bob.page, roomId);
    const digest = chatCards(bob.page, 'digest');
    await expect(digest).toHaveCount(1, { timeout: 20_000 });
    await expect(digest).toContainText('While you were away');
    await expect(digest).toContainText('Deployment');
    await expect(bob.page.getByTestId('private-marker')).toHaveCount(1);
    await expect(alice.page.getByTestId(`presence-${bobId}`)).toBeVisible();

    // never broadcast to Alice and never part of the shared transcript
    await expect(chatCards(alice.page, 'digest')).toHaveCount(0);
    const roomMessages = (page: typeof alice.page) =>
      apiGet<Array<{ card: { type: string } | null; privateTo: string | null }>>(
        page,
        `/api/rooms/${roomId}/messages?limit=200`,
      );
    expect((await roomMessages(alice.page)).filter((m) => m.card?.type === 'digest')).toHaveLength(
      0,
    );
    expect(
      (await roomMessages(bob.page)).filter(
        (m) => m.card?.type === 'digest' && m.privateTo === bobId,
      ),
    ).toHaveLength(1);
    await alice.page.reload();
    await expect(alice.page.getByTestId('chat-input')).toBeVisible();
    await expect(chatCards(alice.page, 'digest')).toHaveCount(0);
  });

  for (const page of both) await expect(page.getByTestId('agent-status')).toContainText('idle');
  expect([...alice.errors, ...bob.errors]).toEqual([]);
  await alice.ctx.close();
  await bob.ctx.close();
});

test('review proposal: a rejection archives it, the rail lists it and can show its branch', async ({
  browser,
}) => {
  const carol = await login(browser, 'Carol');
  await createRoom(carol.page, 'Review room');
  await createDocument(carol.page, 'PRD');
  await say(carol.page, 'add a section on goals');
  await expect(chatCards(carol.page, 'change')).toHaveCount(1, { timeout: 20_000 });

  await say(carol.page, 'Please rewrite the whole document from scratch');
  const review = chatCards(carol.page, 'review');
  await expect(review).toHaveCount(1, { timeout: 20_000 });
  await expect(review).toContainText('Rewrite PRD');
  await expect(review.getByTestId('review-countdown')).toBeVisible();
  await expect(review.getByTestId('review-reject')).toBeInViewport(); // the chat followed the card to its end
  const rail = carol.page.getByTestId('rail');
  await expect(rail.getByRole('heading', { name: /^Open \(1\)/ })).toBeVisible();

  await review.getByTestId('review-reject').click();
  await expect(review).toContainText(/rejected/i, { timeout: 20_000 });
  await expect(review.getByTestId('review-approve')).toBeDisabled();
  await expect(review.getByTestId('review-reject')).toBeDisabled();
  await expect(carol.page.getByText(/was rejected/).first()).toBeVisible();

  // the rail is open by default; the rejected proposal is listed under Archived and main is untouched
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('heading', { name: /^Archived \(1\)/ })).toBeVisible();
  await expect(rail.getByRole('heading', { name: /^Open \(0\)/ })).toBeVisible();
  await expect(rail.locator('[data-testid^="rail-proposal-"].state-rejected')).toHaveCount(1);
  await expect(canvas(carol.page)).not.toContainText('rewritten end to end');

  // the rail collapses and expands
  await carol.page.getByTestId('rail-toggle').click();
  await expect(rail).toBeHidden();
  await carol.page.getByTestId('rail-toggle').click();
  await expect(rail).toBeVisible();

  // the archived branch can still be inspected from the rail, read-only, and the view returns to main
  await rail.locator('[data-testid^="rail-option-"]').first().click();
  await expect(carol.page.getByTestId('branch-banner')).toBeVisible();
  await expect(canvas(carol.page)).toContainText('rewritten end to end for clarity');
  await carol.page.getByTestId('branch-exit').click();
  await expect(carol.page.getByTestId('branch-banner')).toHaveCount(0);
  await expect(canvas(carol.page)).not.toContainText('rewritten end to end');

  expect(carol.errors).toEqual([]);
  await carol.ctx.close();
});

test('review proposal: with no objection it merges when the window closes', async ({ browser }) => {
  const erin = await login(browser, 'Erin');
  await createRoom(erin.page, 'Window room');
  await createDocument(erin.page, 'Plan');
  await say(erin.page, 'rewrite the entire document please');

  const review = chatCards(erin.page, 'review');
  await expect(review).toHaveCount(1, { timeout: 20_000 });
  await expect(review.getByTestId('review-countdown')).toBeVisible();
  await expect(chatCards(erin.page, 'merge')).toHaveCount(0);

  // QUORUM_REVIEW_WINDOW_MS is 4 s: the proposal merges on its own
  await expect(chatCards(erin.page, 'merge')).toHaveCount(1, { timeout: 20_000 });
  await expect(review).toContainText('merged');
  await expect(canvas(erin.page)).toContainText('rewritten end to end for clarity');
  await expect(erin.page.locator('[data-testid^="rail-proposal-"].state-merged')).toHaveCount(1);

  // a merged proposal is reverted from its merge card: main returns to the earlier text, the proposal is marked
  await chatCards(erin.page, 'merge').getByRole('button', { name: 'Revert' }).click();
  await expect(chatCards(erin.page, 'merge')).toContainText('reverted');
  await expect(
    chatCards(erin.page, 'merge').getByRole('button', { name: 'Reverted' }),
  ).toBeDisabled();
  await expect(review).toContainText('reverted');
  await expect(canvas(erin.page)).not.toContainText('rewritten end to end');
  await expect(canvas(erin.page).getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(chatCards(erin.page, 'change')).toHaveCount(1); // the revert, as a Change card of its own
  await expect(chatCards(erin.page, 'change')).toContainText('Reverted');

  expect(erin.errors).toEqual([]);
  await erin.ctx.close();
});

test('documents and rules: rename, create and archive reach everyone; only the owner sets the voting rule', async ({
  browser,
}) => {
  const owner = await login(browser, 'Olga');
  const roomId = await createRoom(owner.page, 'Docs room');
  await createDocument(owner.page, 'Notes');
  const guest = await login(browser, 'Gus');
  await openRoom(guest.page, roomId);
  const both = [owner.page, guest.page];

  await test.step('rename: the new title replaces the old one in place for both, content kept', async () => {
    await owner.page.getByTestId('doc-menu').click();
    await expect(owner.page.getByTestId('doc-rename-input')).toHaveValue('Notes');
    await owner.page.getByTestId('doc-rename-input').fill('Journal');
    await owner.page.getByTestId('doc-rename-submit').click();
    for (const page of both) {
      await expect(page.getByRole('tab', { name: 'Journal' })).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(1);
      await expect(canvas(page)).toContainText('Notes'); // the H1 inside the file is not rewritten
      await expect(page.getByText(/renamed Notes\.md to Journal\.md/)).toBeVisible();
    }
  });

  await test.step('a second document: the creator opens it, others keep their tab and can switch', async () => {
    await createDocument(owner.page, 'Scratch');
    await expect(guest.page.getByRole('tab', { name: 'Scratch' })).toBeVisible();
    await expect(guest.page.getByRole('tab', { name: 'Journal', selected: true })).toBeVisible();
    await guest.page.getByRole('tab', { name: 'Scratch' }).click();
    await expect(canvas(guest.page)).toContainText('Scratch');
  });

  await test.step('archive: the tab disappears for everyone, even for someone looking at it', async () => {
    await owner.page.getByTestId('doc-menu').click();
    await owner.page.getByTestId('doc-archive').click();
    for (const page of both) {
      await expect(page.getByRole('tab', { name: 'Scratch' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Journal' })).toBeVisible();
      await expect(canvas(page)).toContainText('Notes');
    }
  });

  await test.step('voting rule: a select for the owner, a label for everyone else', async () => {
    await expect(owner.page.getByTestId('rule-select')).toHaveValue('unanimous');
    await expect(owner.page.getByTestId('rule-label')).toHaveCount(0);
    await expect(guest.page.getByTestId('rule-select')).toHaveCount(0);
    await expect(guest.page.getByTestId('rule-label')).toContainText('unanimous');
    await owner.page.getByTestId('rule-select').selectOption('majority');
    await expect(guest.page.getByTestId('rule-label')).toContainText('majority');
    await expect(guest.page.getByText(/changed the voting rule to majority/)).toBeVisible();
  });

  expect([...owner.errors, ...guest.errors]).toEqual([]);
  await owner.ctx.close();
  await guest.ctx.close();
});

test('reconnect: a dropped socket comes back, catches up, and the time away earns a private digest', async ({
  browser,
}) => {
  const fay = await login(browser, 'Fay');
  // Pass the page's WebSocket through to the server; during an "outage" refuse it instead. Playwright installs the
  // interception as an init script, so it applies from the next document on: reload once.
  let outage = false;
  const live: WebSocketRoute[] = [];
  await fay.page.routeWebSocket(/\/ws\?/, (ws) => {
    if (outage) {
      void ws.close();
      return;
    }
    live.push(ws);
    ws.connectToServer();
  });
  await fay.page.reload();
  const roomId = await createRoom(fay.page, 'Flaky network');
  await createDocument(fay.page, 'Notes');
  const gus = await login(browser, 'Gus');
  await openRoom(gus.page, roomId);
  const fayId = await userIdOf(fay.page);
  await expect(gus.page.getByTestId(`presence-${fayId}`)).toBeVisible();

  await test.step('the network drops: Fay sees it, Gus sees her leave, nothing she types is lost silently', async () => {
    outage = true;
    await Promise.all(live.splice(0).map((ws) => ws.close()));
    await expect(fay.page.getByText('Reconnecting…')).toBeVisible();
    await expect(gus.page.getByTestId(`presence-${fayId}`)).toHaveCount(0);
    await fay.page.getByTestId('chat-input').fill('anyone there?');
    await fay.page.getByTestId('chat-send').click();
    await expect(fay.page.getByRole('alert')).toContainText('Not connected');
    await expect(fay.page.getByTestId('chat-input')).toHaveValue('anyone there?');
  });

  await test.step('meanwhile the room moves on', async () => {
    await fay.page.waitForTimeout(1800); // longer than QUORUM_DIGEST_ABSENCE_MS (1500)
    await say(gus.page, 'add a section on resilience');
    await expect(chatCards(gus.page, 'change')).toHaveCount(1, { timeout: 20_000 });
  });

  await test.step('the network returns: Fay catches up from the snapshot and gets a digest only she can see', async () => {
    outage = false;
    await expect(chatCards(fay.page, 'change')).toHaveCount(1, { timeout: 20_000 });
    await expect(canvas(fay.page).getByRole('heading', { name: 'Resilience' })).toBeVisible();
    await expect(fay.page.getByText('Reconnecting…')).toHaveCount(0);
    await expect(fay.page.getByRole('alert')).toHaveCount(0); // the "Not connected" notice cleared itself
    await expect(gus.page.getByTestId(`presence-${fayId}`)).toBeVisible();
    await expect(chatCards(fay.page, 'digest')).toHaveCount(1, { timeout: 20_000 });
    await expect(chatCards(fay.page, 'digest')).toContainText('Resilience');
    await expect(chatCards(gus.page, 'digest')).toHaveCount(0);
    // the transcript was not duplicated or reordered by the snapshot: the Gus message precedes its change card
    const bodies = await fay.page.locator('[data-testid^="message-"]').allTextContents();
    const request = (t: string) => t.startsWith('Gus') && t.includes('add a section on resilience');
    const change = (t: string) => t.startsWith('Quorum (orchestrator)') && t.includes('Resilience');
    expect(bodies.filter(request)).toHaveLength(1);
    expect(bodies.filter(change)).toHaveLength(1);
    expect(bodies.findIndex(request)).toBeLessThan(bodies.findIndex(change));
  });

  await test.step('and she is back in the conversation', async () => {
    await fay.page.getByTestId('chat-send').click(); // her unsent message was kept
    await expect(gus.page.getByText('anyone there?')).toBeVisible();
    await say(fay.page, 'add a section on retries');
    await expect(canvas(gus.page).getByRole('heading', { name: 'Retries' })).toBeVisible();
  });

  expect([...fay.errors, ...gus.errors]).toEqual([]);
  await fay.ctx.close();
  await gus.ctx.close();
});

test('settings: the Claude sign-in screen loads and reports not signed in', async ({ browser }) => {
  const dave = await login(browser, 'Dave');

  await dave.page.getByTestId('settings-link').click();
  await expect(dave.page).toHaveURL(/\/settings$/);
  await expect(dave.page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(dave.page.getByTestId('claude-status')).toHaveText('Not signed in', {
    timeout: 30_000,
  });
  await expect(dave.page.getByTestId('claude-signin')).toBeVisible();
  await expect(dave.page.getByTestId('claude-signout')).toHaveCount(0);

  // a direct load of /settings is served by the SPA fallback and keeps the session
  await dave.page.goto('/settings');
  await expect(dave.page.getByTestId('claude-status')).toHaveText('Not signed in', {
    timeout: 30_000,
  });
  await expect(dave.page.getByTestId('claude-signin')).toBeVisible();

  // the API agrees with the screen
  const status = await apiGet<{ signedIn: boolean; method: string }>(
    dave.page,
    '/api/claude/status',
  );
  expect(status).toMatchObject({ signedIn: false, method: 'none' });
  await dave.page.getByRole('link', { name: 'Back to rooms' }).click();
  await expect(dave.page.getByTestId('room-create-name')).toBeVisible();

  expect(dave.errors).toEqual([]);
  await dave.ctx.close();
});
