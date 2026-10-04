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

/**
 * Content of the pre-commit hook: format staged markdown with prettier and re-stage it.
 * File names go after `--` so that a document called `--plugin=x` or `-l` can never be read as an option, and git
 * gets `safe.directory=*` like every other git call of the server (the hook is a separate process).
 */
export function preCommitHookScript(nodePath: string, prettierBin: string): string {
  return `#!/bin/sh
# Installed by Quorum: normalizes staged markdown (prettier, proseWrap=preserve).
NODE=${shQuote(nodePath)}
PRETTIER=${shQuote(prettierBin)}
git -c safe.directory='*' diff --cached --name-only --diff-filter=ACMR -z -- '*.md' |
  xargs -0 -r "$NODE" "$PRETTIER" --no-config --no-editorconfig --prose-wrap preserve --write --log-level warn -- || exit 1
git -c safe.directory='*' diff --cached --name-only --diff-filter=ACMR -z -- '*.md' |
  xargs -0 -r git -c safe.directory='*' --literal-pathspecs add -- || exit 1
exit 0
`;
}
