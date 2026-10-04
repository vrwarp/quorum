import {
  blockWith,
  canvas,
  chatCards,
  createDocument,
  createRoom,
  documentSource,
  expect,
  suggest,
  test,
} from './helpers.js';

/** Rich markdown on the canvas (tables, Mermaid diagrams, embedded images) and the folded diff. */

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
const filler = Array.from({ length: 12 }, (_, i) => `Filler paragraph ${i + 1}.`);
const RICH = [
  '# Plan',
  ...filler,
  '| Role | Count | When |',
  '| ---- | :---: | ---- |',
  '| **Game Master** | 1 | All day |',
  '| Courier | 1 | Phase 1 |',
  '```mermaid',
  'graph TD',
  '  Lunch --> Hotline',
  '  Hotline --> Dinner',
  '```',
  '![Red square][image1]',
  '[image1]: ' + PNG,
].join('\n');

test('tables, Mermaid diagrams and embedded images render on the canvas; a diff folds what did not change', async ({
  app,
}) => {
  const alice = await app.login('Alice');
  const roomId = await createRoom(alice.page, 'Rich room');
  await createDocument(alice.page, 'Plan');
  await suggest(alice.page, 'Plan', RICH);
  await expect(canvas(alice.page).getByText('Filler paragraph 12.')).toBeVisible({
    timeout: 20_000,
  });
  // the repository's formatter aligns the table on commit
  const source = await documentSource(alice.page, roomId, 'Plan');
  const tableSource = /^\| Role[^]*?\| Courier.*\|$/m.exec(source)?.[0];
  expect(tableSource?.split('\n')).toHaveLength(4);

  // the suggestion card in chat keeps its diff folded until asked
  const card = chatCards(alice.page, 'suggestion').first();
  const folded = card.getByTestId('suggestion-diff');
  await expect(folded).not.toHaveAttribute('open');
  await expect(folded.locator('summary')).toHaveText(/^Show changes \(\+\d+ −0 words\)$/);
  await expect(card.getByText('Filler paragraph 3.')).toBeHidden();
  await folded.locator('summary').click();
  await expect(card.getByTestId('word-diff')).toBeVisible();
  await expect(card.getByTestId('word-diff')).toContainText('Filler paragraph 3.');

  // the table is one block, rendered as a table
  const table = canvas(alice.page).locator('table');
  await expect(table).toBeVisible();
  await expect(table.locator('th')).toHaveText(['Role', 'Count', 'When']);
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('strong')).toHaveText('Game Master');
  await expect(canvas(alice.page).getByText('| ----')).toHaveCount(0);

  // the Mermaid fence is drawn
  const diagram = canvas(alice.page).getByTestId('mermaid');
  await expect(diagram.locator('svg')).toBeVisible({ timeout: 20_000 });
  await expect(diagram).toContainText('Hotline');

  // the image resolves through its reference definition, which shows as one short line
  const image = canvas(alice.page).locator('img[alt="Red square"]');
  await expect(image).toBeVisible();
  expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(8);
  await expect(canvas(alice.page).getByTestId('definition')).toHaveText(
    /\[image1\] image\/png embedded/,
  );

  if (process.env.SHOT) {
    await image.scrollIntoViewIfNeeded();
    await alice.page.screenshot({ path: process.env.SHOT + '/canvas.png' });
  }

  // a whole table can be suggested on: the editor opens with all of its rows
  await blockWith(alice.page, 'Courier').getByRole('button').first().click();
  await expect(alice.page.getByTestId('suggest-textarea')).toHaveValue(tableSource!);
  await alice.page.getByTestId('suggest-cancel').click();

  // a one-line edit in the middle: its diff shows the change and folds the rest
  await suggest(alice.page, 'Filler paragraph 6.', 'Filler paragraph six.');
  await expect(canvas(alice.page).getByText('Filler paragraph six.')).toBeVisible({
    timeout: 20_000,
  });
  await chatCards(alice.page, 'change').last().getByRole('button', { name: 'View diff' }).click();
  const diff = alice.page.getByTestId('diff-drawer').getByTestId('word-diff');
  await expect(diff.locator('del')).toHaveText('6');
  await expect(diff.locator('ins')).toHaveText('six');
  await expect(diff).toContainText('Filler paragraph 5.');
  await expect(diff).not.toContainText('Filler paragraph 1.');
  await expect(diff).not.toContainText('base64');
  if (process.env.SHOT)
    await alice.page
      .getByTestId('diff-drawer')
      .screenshot({ path: process.env.SHOT + '/diff.png' });
  const folds = alice.page.getByTestId('diff-fold');
  await expect(folds).toHaveCount(2);
  await folds.first().click();
  await expect(diff).toContainText('Filler paragraph 1.');
});
