import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { format } from 'prettier';

export type MarkdownFormatter = (markdown: string) => Promise<string> | string;

/** Prettier with proseWrap=preserve and no config lookup: deterministic regardless of the data dir. */
export const prettierFormatter: MarkdownFormatter = (markdown) =>
  format(markdown, { parser: 'markdown', proseWrap: 'preserve' });

/** Absolute path of the prettier CLI inside the project's node_modules (written into the pre-commit hook). */
export function resolvePrettierBin(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('prettier/bin/prettier.cjs');
  } catch {
    return join(dirname(require.resolve('prettier/package.json')), 'bin', 'prettier.cjs');
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Content of the pre-commit hook: format staged markdown with prettier and re-stage it. */
export function preCommitHookScript(nodePath: string, prettierBin: string): string {
  return `#!/bin/sh
# Installed by Quorum: normalizes staged markdown (prettier, proseWrap=preserve).
NODE=${shQuote(nodePath)}
PRETTIER=${shQuote(prettierBin)}
git diff --cached --name-only --diff-filter=ACMR -z -- '*.md' |
  xargs -0 -r "$NODE" "$PRETTIER" --no-config --no-editorconfig --prose-wrap preserve --write --log-level warn || exit 1
git diff --cached --name-only --diff-filter=ACMR -z -- '*.md' | xargs -0 -r git add -- || exit 1
exit 0
`;
}
