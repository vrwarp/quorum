import {
  apiGet,
  canvas,
  chatCards,
  createDocument,
  createRoom,
  expect,
  openRoom,
  say,
  tapSocket,
  test,
} from './helpers.js';

/** Proposals and votes: early approval, stale cards, and who counts toward a tally. */

test('review proposal: approving early merges before the window closes, and the merge says on behalf of whom', async ({
  app,
}) => {
  const carol = await app.login('Carol');
  const roomId = await createRoom(carol.page, 'Early room');
  await createDocument(carol.page, 'Plan');
  await say(carol.page, 'rewrite the entire document please');

  const review = chatCards(carol.page, 'review');
  await expect(review).toHaveCount(1, { timeout: 20_000 });
  await expect(review.getByTestId('review-countdown')).toBeVisible();
  await expect(chatCards(carol.page, 'merge')).toHaveCount(0);
  await review.getByTestId('review-approve').click();

  // everyone connected (here: Carol) has approved, so it merges without waiting for the window (4 s in e2e runs)
  await expect(chatCards(carol.page, 'merge')).toHaveCount(1, { timeout: 20_000 });
  await expect(review).toContainText('merged');
  await expect(canvas(carol.page)).toContainText('rewritten end to end for clarity');
  await expect(chatCards(carol.page, 'merge').getByTestId('change-triggers')).toContainText(
    'Carol: rewrite the entire document please',
  );
  const { proposals } = await apiGet<{
    proposals: Array<{ state: string; closedAt: string; windowClosesAt: string }>;
  }>(carol.page, `/api/rooms/${roomId}/state`);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.state).toBe('merged');
  expect(Date.parse(proposals[0]!.closedAt)).toBeLessThan(Date.parse(proposals[0]!.windowClosesAt));
});

test('a stale Quorum card is collapsed and labelled but can still be opened and voted on; the tally counts connected voters', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const aliceSocket = await tapSocket(alice.page);
  // the fake agent flags a proposal stale only when the room says "never mind" while it explores; here the page is
  // told so instead, which is all the card's rendering depends on
  aliceSocket.rewrite((ev) =>
    ev.type === 'proposal.updated'
      ? { ...ev, proposal: { ...(ev.proposal as object), stale: true } }
      : ev,
  );
  const roomId = await createRoom(alice.page, 'Stale room');
  await createDocument(alice.page, 'Arch');
  const bob = await app.login('Bob');
  await openRoom(bob.page, roomId);

  await say(alice.page, "Let's use PostgreSQL for the storage layer");
  await expect(bob.page.getByText("Let's use PostgreSQL for the storage layer")).toBeVisible();
  await say(bob.page, 'ClickHouse makes more sense for this write volume');
  await expect(chatCards(bob.page, 'quorum')).toHaveCount(1, { timeout: 30_000 });
  const stale = chatCards(alice.page, 'quorum');
  await expect(stale).toHaveCount(1, { timeout: 30_000 });

  await test.step('collapsed and labelled for Alice, in full for Bob, listed under Stale in her rail', async () => {
    await expect(stale.getByTestId('card-collapsed-label')).toContainText('Stale');
    await expect(stale.locator('[data-testid^="vote-"]')).toHaveCount(0);
    await expect(chatCards(bob.page, 'quorum').locator('[data-testid^="vote-"]')).toHaveCount(3);
    await expect(chatCards(bob.page, 'quorum').getByTestId('card-toggle')).toHaveCount(0);
    await expect(
      alice.page.getByTestId('rail').getByRole('heading', { name: /^Stale \(1\)/ }),
    ).toBeVisible();
  });

  await test.step('it expands on request and the vote goes through', async () => {
    await stale.getByTestId('card-toggle').click();
    await expect(stale.getByTestId('card-toggle')).toHaveAttribute('aria-expanded', 'true');
    const first = stale.locator('[data-testid^="vote-"]').first();
    await expect(first).toBeEnabled();
    const optionId = (await first.getAttribute('data-testid'))!.replace('vote-', '');
    await first.click();
    await expect(alice.page.getByTestId(`tally-${optionId}`)).toHaveText('1 vote');
    await expect(bob.page.getByTestId(`tally-${optionId}`)).toHaveText('1 vote');

    // Alice leaves: her vote no longer counts toward the rule, and the card says so instead of "1 vote"
    await alice.page.goto('about:blank');
    await expect(bob.page.getByTestId(`tally-${optionId}`)).toHaveText('0 votes');
    await expect(bob.page.getByTestId(`tally-away-${optionId}`)).toContainText('1 not connected');
    await openRoom(alice.page, roomId);
    await expect(bob.page.getByTestId(`tally-${optionId}`)).toHaveText('1 vote');
    await expect(bob.page.getByTestId(`tally-away-${optionId}`)).toHaveCount(0);
  });
});

test('a card whose proposal the page lacks fetches it, says so when it cannot, and a merge card still knows it was reverted', async ({
  app,
}) => {
  const carol = await app.login('Carol');
  const socket = await tapSocket(carol.page);
  // the snapshot and the proposal events leave proposals out, as when a proposal is older than the recent history
  socket.rewrite((ev) =>
    ev.type === 'proposal.updated'
      ? null
      : ev.type === 'hello'
        ? { ...ev, state: { ...(ev.state as object), proposals: [] } }
        : ev,
  );
  const roomId = await createRoom(carol.page, 'Lookup room');
  await createDocument(carol.page, 'Plan');

  await test.step('the card asks the server for the proposal and then shows it in full', async () => {
    await say(carol.page, 'rewrite the entire document please');
    const review = chatCards(carol.page, 'review');
    await expect(review).toContainText('Loading proposal');
    await expect(review.getByTestId('review-approve')).toBeVisible({ timeout: 20_000 });
    await expect(review).toContainText('Rewrite Plan');
  });

  await test.step('merge it, then load the room again with the server unable to say anything about proposals', async () => {
    await chatCards(carol.page, 'review').getByTestId('review-approve').click();
    await expect(chatCards(carol.page, 'merge')).toHaveCount(1, { timeout: 20_000 });
    await carol.page.route(`**/api/rooms/${roomId}/state`, async (route) => {
      const response = await route.fetch();
      const state = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...state, proposals: [] } });
    });
    await carol.page.reload();
    await expect(chatCards(carol.page, 'review')).toContainText('Loading proposal');
    await expect(chatCards(carol.page, 'review').getByTestId('card-proposal-missing')).toBeVisible({
      timeout: 20_000,
    });
    await expect(chatCards(carol.page, 'review')).not.toContainText('Loading proposal');
    await expect(chatCards(carol.page, 'merge')).toBeVisible();
  });

  await test.step('Revert on the merge card works, and the card learns it from the revert itself', async () => {
    const merge = chatCards(carol.page, 'merge');
    await merge.getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(merge.getByRole('button', { name: 'Reverted', exact: true })).toBeDisabled();
    await expect(chatCards(carol.page, 'change')).toHaveCount(1);
    await expect(canvas(carol.page)).not.toContainText('rewritten end to end');
  });
});
