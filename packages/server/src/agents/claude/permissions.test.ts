import { describe, expect, it } from 'vitest';
import { decide } from '../testing/fixtures.js';
import { checkBashCommand, isAllowedBashCommand, makeCanUseTool } from './permissions.js';

const allowed = [
  'git status',
  'git status --short',
  'git log --oneline -n 5',
  'git log -L 3,5:Architecture.md',
  'git log --format=%H%x20%s -- Architecture.md',
  "git log --pretty=format:'%h %s' --since='2 days ago'",
  'git blame -L 1,5 Architecture.md',
  'git show HEAD:Architecture.md',
  'git show HEAD~2:Architecture.md | head -20',
  'git show 3f9c1a2 -- Architecture.md',
  'git diff HEAD~1..HEAD --stat',
  'git diff main...architecture/storage/a',
  'git add Architecture.md',
  'git add -A',
  'git grep -n latency -- "*.md"',
  'git ls-files',
  'git rev-parse HEAD',
  'git cat-file -p HEAD:Architecture.md',
  'git merge-base HEAD MERGE_HEAD',
  'git show MERGE_HEAD:Architecture.md',
  'ls',
  'ls -la',
  'cat Architecture.md',
  'cat Architecture.md | wc -l',
  'head -n 20 Architecture.md',
  'tail -n 20 Architecture.md',
  'wc -l *.md',
  'grep -n latency Architecture.md',
  'grep -rn "latency" .',
  'grep -E "foo|bar" Architecture.md',
  'rg -n "p99" Architecture.md',
  'pwd',
  'diff Architecture.md PRD.md',
  'prettier --check Architecture.md',
  'npx --no-install prettier --check Architecture.md',
  'git log --oneline | head -5',
];

const denied: Array<[string, RegExp]> = [
  // git commands that change state or reach the network
  ['git commit -m "x"', /git commit is not allowed/],
  ['git checkout main', /git checkout is not allowed/],
  ['git reset --hard', /git reset is not allowed/],
  ['git push origin main', /git push is not allowed/],
  ['git merge feature', /git merge is not allowed/],
  ['git stash', /git stash is not allowed/],
  ['git config user.name x', /git config is not allowed/],
  ['git -c core.pager=less log', /git -c is not allowed/],
  ['git -C .. log', /git -C is not allowed/],
  ['git log --output=out.txt', /--output is not allowed/],
  ['git diff --ext-diff', /--ext-diff is not allowed/],
  ['git grep -O less foo', /-O is not allowed/],
  ['git diff --no-index a b', /--no-index is not allowed/],
  // other programs
  ['rm -rf .', /`rm` is not allowed/],
  ['curl http://example.com', /`curl` is not allowed/],
  ['echo hi', /`echo` is not allowed/],
  ['node -e "1"', /`node` is not allowed/],
  ['sh -c "ls"', /`sh` is not allowed/],
  ['/bin/cat Architecture.md', /is not allowed/],
  ['FOO=bar git log', /is not allowed/],
  // chaining, redirection, grouping
  ['git log; rm x', /chaining/],
  ['git log && rm x', /chaining/],
  ['git log || rm x', /chaining/],
  ['git log & rm x', /chaining/],
  ['cat x > y', /redirection/],
  ['cat x >> y', /redirection/],
  ['cat < /etc/passwd', /redirection/],
  ['(cat x)', /grouping/],
  ['cat x\nrm y', /line breaks/],
  // expansion: substitution, variables, braces, brackets, escapes
  ['cat $(ls)', /substitution/],
  ['cat `ls`', /substitution/],
  ['cat ${HOME}/x', /substitution/],
  ['cat $HOME/.claude/.credentials.json', /substitution/],
  ['cat $CLAUDE_CONFIG_DIR/.credentials.json', /substitution/],
  ['cat "$HOME/x"', /substitution/],
  ['cat {..,x}/y', /grouping/],
  ['cat a[0-9].md', /bracket globs/],
  ['cat .\\./x', /backslashes/],
  // leaving the worktree
  ['cat /etc/passwd', /absolute paths/],
  ['cat "/etc/passwd"', /absolute paths/],
  ['cat ../x', /\.\./],
  ['cat docs/../../x', /\.\./],
  ['cat ./"../x"', /\.\./],
  ["cat .'.'/x", /\.\./],
  ['cat ~/x', /absolute paths/],
  ['git show HEAD:../x', /\.\./],
  ['git blame --contents=/etc/passwd x.md', /absolute paths/],
  ['ls ..', /\.\./],
  ['grep -r foo /', /absolute paths/],
  // globs that could reach a parent directory or other directories
  ['ls .*', /globs may only match/],
  ['cat .*/../x', /\.\./],
  ['ls */*', /globs may only match/],
  // options that run programs, write files, or hang
  ['rg --pre cat foo', /--pre is not allowed/],
  ['prettier --write Architecture.md', /--write is not allowed/],
  ['prettier -w Architecture.md', /-w is not allowed/],
  ['prettier --plugin ./evil.js x.md', /--plugin is not allowed/],
  ['prettier --config ./rc x.md', /--config is not allowed/],
  ['tail -f Architecture.md', /-f is not allowed/],
  ['tail -F Architecture.md', /-F is not allowed/],
  // npx can download and run packages
  ['npx prettier@latest x.md', /npx is only allowed/],
  ['npx cowsay hi', /npx is only allowed/],
  ['npx --yes prettier x.md', /npx is only allowed/],
  // malformed
  ['', /empty command/],
  ['   ', /empty command/],
  ['git log |', /empty pipeline segment/],
  ['| cat', /empty pipeline segment/],
  ['cat "unterminated', /unterminated quote/],
];

describe('checkBashCommand', () => {
  it.each(allowed)('allows %s', (command) => {
    expect(checkBashCommand(command)).toEqual({ ok: true });
  });

  it.each(denied)('denies %s', (command, reason) => {
    const r = checkBashCommand(command);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('rejects non-string and overlong commands', () => {
    expect(isAllowedBashCommand(undefined)).toBe(false);
    expect(isAllowedBashCommand(42)).toBe(false);
    expect(isAllowedBashCommand(`cat ${'a'.repeat(2100)}`)).toBe(false);
  });

  it('does not treat a pipe inside quotes as a pipeline', () => {
    expect(checkBashCommand('grep -E "a|b" Architecture.md').ok).toBe(true);
    // but a real pipeline segment is checked on its own
    expect(checkBashCommand('grep -E "a|b" Architecture.md | rm x').ok).toBe(false);
  });
});

describe('makeCanUseTool', () => {
  const cwd = '/work/room/worktrees/main';
  const mcp = ['mcp__quorum__post_chat', 'mcp__quorum__read_transcript'];
  const orchestrator = makeCanUseTool({ cwd, allowedMcpTools: mcp, writableRootMarkdown: true });
  const call = decide;

  it('allows permitted Bash and denies the rest with the reason', async () => {
    expect((await call(orchestrator, 'Bash', { command: 'git log --oneline' })).behavior).toBe(
      'allow',
    );
    const denial = await call(orchestrator, 'Bash', { command: 'git commit -m x' });
    expect(denial).toMatchObject({ behavior: 'deny' });
    expect((denial as { message: string }).message).toMatch(/commit_main/);
  });

  it('allows only the listed MCP tools', async () => {
    expect((await call(orchestrator, 'mcp__quorum__post_chat', { body: 'hi' })).behavior).toBe(
      'allow',
    );
    expect((await call(orchestrator, 'mcp__quorum__commit_main', {})).behavior).toBe('deny');
    expect((await call(orchestrator, 'mcp__other__anything', {})).behavior).toBe('deny');
  });

  it('confines file tools to the working directory', async () => {
    expect(
      (await call(orchestrator, 'Read', { file_path: `${cwd}/Architecture.md` })).behavior,
    ).toBe('allow');
    expect((await call(orchestrator, 'Read', { file_path: 'Architecture.md' })).behavior).toBe(
      'allow',
    );
    expect((await call(orchestrator, 'Read', { file_path: '/etc/passwd' })).behavior).toBe('deny');
    expect(
      (await call(orchestrator, 'Read', { file_path: `${cwd}/../../claude/.credentials.json` }))
        .behavior,
    ).toBe('deny');
    expect((await call(orchestrator, 'Grep', { pattern: 'x', path: '/work' })).behavior).toBe(
      'deny',
    );
    expect((await call(orchestrator, 'Glob', { pattern: '/etc/*' })).behavior).toBe('deny');
    expect((await call(orchestrator, 'Glob', { pattern: '../*.md' })).behavior).toBe('deny');
    expect((await call(orchestrator, 'Glob', { pattern: '*.md' })).behavior).toBe('allow');
    expect((await call(orchestrator, 'Grep', { pattern: 'x', glob: '../**' })).behavior).toBe(
      'deny',
    );
  });

  it('lets the orchestrator write only markdown documents at the repository root', async () => {
    expect(
      (await call(orchestrator, 'Edit', { file_path: `${cwd}/Architecture.md` })).behavior,
    ).toBe('allow');
    expect(
      (await call(orchestrator, 'Write', { file_path: 'API-Spec.md', content: 'x' })).behavior,
    ).toBe('allow');
    expect(
      (await call(orchestrator, 'Write', { file_path: `${cwd}/sub/Notes.md`, content: 'x' }))
        .behavior,
    ).toBe('deny');
    expect(
      (await call(orchestrator, 'Write', { file_path: `${cwd}/.prettierrc.js`, content: 'x' }))
        .behavior,
    ).toBe('deny');
    expect(
      (await call(orchestrator, 'Write', { file_path: `${cwd}/package.json`, content: '{}' }))
        .behavior,
    ).toBe('deny');
    expect((await call(orchestrator, 'Edit', { file_path: '/etc/hosts' })).behavior).toBe('deny');
    expect((await call(orchestrator, 'Edit', {})).behavior).toBe('deny');
  });

  it('narrows a worker to its one document', async () => {
    const worker = makeCanUseTool({
      cwd: '/w/branch',
      allowWeb: true,
      writableFiles: ['Architecture.md'],
    });
    expect((await call(worker, 'Edit', { file_path: '/w/branch/Architecture.md' })).behavior).toBe(
      'allow',
    );
    expect(
      (await call(worker, 'Write', { file_path: 'Architecture.md', content: 'x' })).behavior,
    ).toBe('allow');
    const other = await call(worker, 'Write', { file_path: 'PRD.md', content: 'x' });
    expect(other.behavior).toBe('deny');
    expect((other as { message: string }).message).toMatch(/exactly one document/);
    expect((await call(worker, 'Read', { file_path: 'PRD.md' })).behavior).toBe('allow');
  });

  it('allows web tools only when asked to', async () => {
    const web = makeCanUseTool({ cwd, allowWeb: true });
    expect((await call(web, 'WebFetch', { url: 'https://example.com' })).behavior).toBe('allow');
    expect((await call(web, 'WebSearch', { query: 'x' })).behavior).toBe('allow');
    expect((await call(orchestrator, 'WebFetch', { url: 'https://example.com' })).behavior).toBe(
      'deny',
    );
    expect((await call(orchestrator, 'Task', {})).behavior).toBe('deny');
  });

  it('mcpOnly sessions get no built-in tools', async () => {
    const digest = makeCanUseTool({ cwd, mcpOnly: true, allowedMcpTools: mcp });
    expect((await call(digest, 'Read', { file_path: 'x.md' })).behavior).toBe('deny');
    expect((await call(digest, 'Bash', { command: 'ls' })).behavior).toBe('deny');
    expect((await call(digest, 'mcp__quorum__read_transcript', {})).behavior).toBe('allow');
  });
});
