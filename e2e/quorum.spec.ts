import { test, expect } from '@playwright/test';
import { createDocument, createRoom, login, openRoom, say } from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('canonical scenario: direct request, divergence vote, suggestion, ask, revert, digest', async ({ browser }) => {
  const alice = await login(browser, 'Alice');
  const roomId = await createRoom(alice.page, 'Design review');
  await createDocument(alice.page, 'Architecture');

  const bob = await login(browser, 'Bob');
  await openRoom(bob.page, roomId);
  await expect(alice.page.getByTestId('presence-' + (await userIdOf(bob.page)))).toBeVisible();

  // 1. direct request -> Change card, document gains a section
  await say(alice.page, 'We should add a section on latency requirements');
  await expect(alice.page.getByTestId('card-change').first()).toBeVisible();
  await expect(alice.page.getByTestId('block-' + '3').or(alice.page.getByText('Latency requirements', { exact: false }).first())).toBeVisible();
  await expect(bob.page.getByText('Latency requirements', { exact: false }).first()).toBeVisible();

  // 2. divergence -> exploration -> quorum card -> unanimous vote -> merge
  await say(alice.page, "Let's use PostgreSQL for the storage layer");
  await say(bob.page, 'ClickHouse makes more sense for this write volume');
  const quorumCard = alice.page.getByTestId('card-quorum').first();
  await expect(quorumCard).toBeVisible({ timeout: 30_000 });
  const voteButtons = quorumCard.locator('[data-testid^="vote-"]');
  await expect(voteButtons).toHaveCount(3);
  const optionCId = (await voteButtons.nth(2).getAttribute('data-testid'))!.replace('vote-', '');
  await voteButtons.nth(2).click();
  await bob.page.getByTestId('card-quorum').first().getByTestId('vote-' + optionCId).click();
  await expect(alice.page.getByTestId('card-merge').first()).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.getByText('Decision:', { exact: false }).first()).toBeVisible();

  // 3. suggestion on a block -> applied
  const firstBlock = alice.page.locator('[data-testid^="block-"]').nth(1);
  await firstBlock.click();
  const textarea = alice.page.getByTestId('suggest-textarea');
  await expect(textarea).toBeVisible();
  const original = await textarea.inputValue();
  await textarea.fill(original + ' (edited by Alice)');
  await alice.page.getByTestId('suggest-submit').click();
  await expect(alice.page.getByTestId('card-suggestion').first()).toBeVisible();
  await expect(alice.page.getByTestId('card-suggestion').first()).toContainText(/applied/i, { timeout: 20_000 });
  await expect(bob.page.getByText('(edited by Alice)', { exact: false }).first()).toBeVisible();

  // 4. ask about a passage -> agent answers with history
  await alice.page.locator('[data-testid^="block-"]').nth(1).click();
  await alice.page.getByTestId('ask-button').click();
  await alice.page.getByTestId('ask-input').fill('Why does this paragraph say this?');
  await alice.page.getByTestId('ask-submit').click();
  await expect(alice.page.getByText(/commit|changed|introduced|history/i).last()).toBeVisible({ timeout: 20_000 });

  // 5. revert the latest change card
  const revertButtons = bob.page.locator('[data-testid^="revert-"]');
  const count = await revertButtons.count();
  expect(count).toBeGreaterThan(0);
  await revertButtons.last().click();
  await expect(bob.page.getByText(/revert/i).last()).toBeVisible({ timeout: 20_000 });

  // 6. rejoin digest: Bob leaves, things happen, Bob returns
  await bob.page.goto('about:blank');
  await alice.page.waitForTimeout(1800);
  await say(alice.page, 'add a section on deployment');
  await expect(alice.page.getByTestId('card-change').last()).toBeVisible({ timeout: 20_000 });
  await openRoom(bob.page, roomId);
  await expect(bob.page.getByTestId('card-digest').first()).toBeVisible({ timeout: 20_000 });
  await expect(alice.page.getByTestId('card-digest')).toHaveCount(0);

  await alice.ctx.close();
  await bob.ctx.close();
});

test('review proposal: large rewrite waits for the objection window, rejection archives it', async ({ browser }) => {
  const carol = await login(browser, 'Carol');
  const roomId = await createRoom(carol.page, 'Review room');
  await createDocument(carol.page, 'PRD');
  await say(carol.page, 'add a section on goals');
  await expect(carol.page.getByTestId('card-change').first()).toBeVisible({ timeout: 20_000 });
  await say(carol.page, 'Please rewrite the whole document from scratch');
  const review = carol.page.getByTestId('card-review').first();
  await expect(review).toBeVisible({ timeout: 20_000 });
  await review.getByTestId('review-reject').click();
  await expect(review).toContainText(/rejected/i, { timeout: 20_000 });
  await carol.page.getByTestId('rail-toggle').click();
  await expect(carol.page.locator('[data-testid^="rail-proposal-"]').first()).toBeVisible();
  await carol.ctx.close();
});

async function userIdOf(page: import('@playwright/test').Page): Promise<string> {
  const me = await page.evaluate(async () => (await fetch('/api/me', { credentials: 'include' })).json());
  return (me as { userId: string }).userId;
}
