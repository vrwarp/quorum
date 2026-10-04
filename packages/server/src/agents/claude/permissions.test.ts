import { describe, expect, it } from 'vitest';
import { decide } from '../testing/fixtures.js';
import {
  checkBashCommand,
  checkWebUrl,
  isAllowedBashCommand,
  makeCanUseTool,
} from './permissions.js';

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
  'git log -p -5 -- Architecture.md',
  'git log --since="2 days ago" --author=Alice --stat',
  'git status -sb',
  'git diff -U5 HEAD~1 -- Architecture.md',
  'git diff --word-diff=color --stat=100',
  'git show --stat --format=%B HEAD',
  'git grep -n -i -e latency -- Architecture.md',
  'git grep -n latency -- "*.md"',
  "git grep -E 'p9[59].*ms' -- Architecture.md",
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
  'wc -l ./*.md',
  'cat Arch*.md',
  'ls -la ./*.md',
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
  ['git add Architecture.md', /git add is not allowed.*commit_main/],
  ['git add -A', /git add is not allowed/],
  ['git log --output=out.txt', /option --output=out\.txt is not allowed for git log/],
  ['git diff --ext-diff', /option --ext-diff is not allowed for git diff/],
  ['git grep -O less foo', /option -O is not allowed for git grep/],
  ['git diff --no-index a b', /option --no-index is not allowed for git diff/],
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
  ['ls .*', /globs may not start with \./],
  ['ls ./.*', /globs may not start with \./],
  ['cat .*/../x', /\.\./],
  ['ls */*', /globs may only match/],
  ['ls ./*/x', /globs may only match/],
  // options that run programs, write files, or hang
  ['rg --pre cat foo', /--pre is not allowed for rg/],
  ['rg --pre=cat foo', /--pre=cat is not allowed for rg/],
  ['rg -z foo', /-z is not allowed for rg/],
  ['prettier --write Architecture.md', /--write is not allowed for prettier/],
  ['prettier -w Architecture.md', /-w is not allowed for prettier/],
  ['prettier --plugin ./evil.js x.md', /--plugin is not allowed for prettier/],
  ['prettier --config ./rc x.md', /--config is not allowed for prettier/],
  ['tail -f Architecture.md', /-f is not allowed for tail/],
  ['tail -F Architecture.md', /-F is not allowed for tail/],
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

describe('git options are allowed one by one, per subcommand', () => {
  // The review found the prefix deny-list brittle: git has a very large option grammar, including abbreviations of long
  // options, so naming the dangerous options cannot be complete. Only listed options are accepted now.
  it('rejects an option that is not on the subcommand list, however it is spelled', () => {
    for (const command of [
      'git log --out=x.md', // an abbreviation of --output that git itself would accept
      'git log --outp=x.md',
      'git diff --ext=x',
      'git diff --no-ext-diff --ext-diff',
      'git show --textconv HEAD:Architecture.md',
      'git log --exec-path',
      'git grep --open-files-in-pager=less foo',
      'git grep -Oless foo',
      'git blame --contents=Architecture.md Architecture.md',
      'git ls-files --exclude-from=Architecture.md',
    ]) {
      const r = checkBashCommand(command);
      expect(r.ok, command).toBe(false);
      if (!r.ok) expect(r.reason, command).toMatch(/is not allowed for git/);
    }
  });

  it('keeps the options of one subcommand away from another', () => {
    expect(checkBashCommand('git blame -L 1,5 Architecture.md').ok).toBe(true);
    expect(checkBashCommand('git status -L 1,5').ok).toBe(false);
    expect(checkBashCommand('git ls-files --stat').ok).toBe(false);
  });

  it('a valued option takes the next word as its value, and needs one', () => {
    expect(checkBashCommand('git log -n 5 --grep latency').ok).toBe(true);
    expect(checkBashCommand('git log --grep').ok).toBe(false);
    const r = checkBashCommand('git log --grep');
    if (!r.ok) expect(r.reason).toMatch(/needs a value/);
    // the value is judged as a path like every word
    expect(checkBashCommand('git log -L /etc/passwd').ok).toBe(false);
    expect(checkBashCommand('git log -L 3,5:Architecture.md').ok).toBe(true);
  });

  it('does not let an option with an optional value swallow the next word: git would run that word as an option', () => {
    // `-U` and `--stat` take their value only when it is attached, so in `git diff -U --output=x` git runs `-U` and
    // then `--output=x`. The word after such an option is therefore judged like any other option.
    for (const command of [
      'git diff -U --output=out.md',
      'git diff --unified --output=out.md',
      'git diff --stat --output=out.md',
      'git log --color --output=out.md',
      'git log --pretty --output=out.md',
      'git status --untracked-files --output=out.md',
      'git show --abbrev --output=out.md',
    ]) {
      const r = checkBashCommand(command);
      expect(r.ok, command).toBe(false);
      if (!r.ok) expect(r.reason, command).toMatch(/--output=out\.md is not allowed for git/);
    }
    // attached, they are fine, and so is the bare form on its own
    for (const command of [
      'git diff -U5',
      'git diff --unified=5 --stat=80',
      'git diff -U',
      'git log --pretty=oneline --color=never',
      'git status --untracked-files=no',
    ])
      expect(checkBashCommand(command).ok, command).toBe(true);
    // options that exist only in the attached form are refused bare
    expect(checkBashCommand('git log --format %h').ok).toBe(false);
    expect(checkBashCommand('git log --format=%h').ok).toBe(true);
    // an option that requires a value takes the next word when that is a plain word ...
    expect(checkBashCommand('git log --grep latency').ok).toBe(true);
    expect(checkBashCommand('rg --color never foo').ok).toBe(true);
    expect(checkBashCommand('prettier --prose-wrap preserve --check Architecture.md').ok).toBe(
      true,
    );
    // ... but a value that starts with - is judged as an option, whatever the program would make of it
    // (prettier, for one, reads `--prose-wrap --config=x` as two options)
    for (const command of [
      'git log --grep --output=x',
      'git grep -e --output=x foo',
      'rg -e --pre=cat foo',
      'prettier --prose-wrap --config=rc Architecture.md',
      'tail -n --follow Architecture.md',
      'git shortlog --committer --output=out.md',
    ]) {
      expect(checkBashCommand(command).ok, command).toBe(false);
    }
    expect(checkBashCommand('git shortlog --committer -s').ok).toBe(true); // a flag here
  });

  it('refuses file names that start with - after the --', () => {
    expect(checkBashCommand('git log -- Architecture.md').ok).toBe(true);
    const r = checkBashCommand('git log -- --output=x.md');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/starting with -/);
  });

  it('does not let git add stage anything: commits go through commit_main', () => {
    for (const command of ['git add Architecture.md', 'git add -A', 'git add --all', 'git add .']) {
      expect(checkBashCommand(command).ok, command).toBe(false);
    }
  });
});

describe('globs cannot smuggle a file name into option position', () => {
  // A file called `--output=x.md` would be expanded by the shell into `git log --output=x.md`, after the words were
  // checked. Agents cannot create such files any more (see the Write tests below), and the shell expansion is closed too.
  it('git commands take no unquoted globs', () => {
    for (const command of [
      'git log *.md',
      'git log -- *.md',
      'git diff HEAD -- ./*.md',
      'git grep latency *.md',
      'git ls-files ?.md',
      'git log -L 1,5:Arch*.md',
    ]) {
      const r = checkBashCommand(command);
      expect(r.ok, command).toBe(false);
      if (!r.ok) expect(r.reason, command).toMatch(/no unquoted \* or \?/);
    }
    // quoted, the pattern is git's own pathspec: the shell never expands it
    expect(checkBashCommand("git log -- '*.md'").ok).toBe(true);
    expect(checkBashCommand('git grep -E "a.*b" -- Architecture.md').ok).toBe(true);
  });

  it('other commands may glob only when no match can read as an option', () => {
    expect(checkBashCommand('cat ./*.md').ok).toBe(true);
    expect(checkBashCommand('cat Arch*.md').ok).toBe(true);
    for (const command of ['cat *.md', 'wc -l *', 'rg foo ?.md', 'grep foo *']) {
      const r = checkBashCommand(command);
      expect(r.ok, command).toBe(false);
      if (!r.ok) expect(r.reason, command).toMatch(/start globs with a letter, a digit or \.\//);
    }
    expect(checkBashCommand('cat -*.md').ok).toBe(false);
  });
});

describe('WebFetch only reaches public hosts', () => {
  it('allows ordinary public http(s) URLs', () => {
    for (const url of [
      'https://example.com',
      'http://example.com/a?b=c#d',
      'https://docs.postgresql.org:443/17/index.html',
      'https://93.184.216.34/',
      'https://[2606:2800:220:1:248:1893:25c8:1946]/',
    ]) {
      expect(checkWebUrl(url), url).toEqual({ ok: true });
    }
  });

  it('refuses loopback, link-local, private and reserved addresses, in every spelling', () => {
    for (const url of [
      'http://127.0.0.1:8787/api/health',
      'http://127.1/',
      'http://2130706433/', // 127.0.0.1 as one number
      'http://0x7f.0.0.1/',
      'http://0177.0.0.1/',
      'http://0.0.0.0/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://100.64.0.1/',
      'http://224.0.0.1/',
      'http://[::1]/',
      'http://[::]/',
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
      'http://[::ffff:a00:1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[2002:7f00:1::1]/',
    ]) {
      const r = checkWebUrl(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason, url).toMatch(/not a public host/);
    }
    expect(checkWebUrl('http://172.32.0.1/').ok).toBe(true); // just outside 172.16/12
  });

  it('refuses single-label names and internal suffixes', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://localhost./',
      'http://LOCALHOST/',
      'http://db/',
      'http://metadata/',
      'http://api.internal/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://printer.local/',
      'http://nas.lan/',
      'http://foo.localhost/',
      'http://router.home.arpa/',
    ]) {
      const r = checkWebUrl(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason, url).toMatch(/not a public host/);
    }
  });

  it('refuses other schemes, credentials in the URL, and things that are not URLs', () => {
    expect(checkWebUrl('file:///etc/passwd').ok).toBe(false);
    expect(checkWebUrl('ftp://example.com/x').ok).toBe(false);
    expect(checkWebUrl('javascript:alert(1)').ok).toBe(false);
    expect(checkWebUrl('https://user:secret@example.com/').ok).toBe(false);
    expect(checkWebUrl('example.com').ok).toBe(false);
    expect(checkWebUrl('').ok).toBe(false);
    expect(checkWebUrl(undefined).ok).toBe(false);
    expect(checkWebUrl(42).ok).toBe(false);
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

  it('never lets an agent create a file whose name starts with -', async () => {
    // such a name could be read as an option by anything that later sees it on a command line
    for (const name of ['-x.md', '--output=x.md', '-']) {
      expect(
        (await call(orchestrator, 'Write', { file_path: `${cwd}/${name}`, content: 'x' })).behavior,
        name,
      ).toBe('deny');
    }
    const worker = makeCanUseTool({ cwd: '/w/branch', writableFiles: ['-odd.md'] });
    expect((await call(worker, 'Write', { file_path: '-odd.md', content: 'x' })).behavior).toBe(
      'deny',
    );
    // non-ASCII document names are fine
    expect(
      (await call(orchestrator, 'Write', { file_path: `${cwd}/Übersicht.md`, content: 'x' }))
        .behavior,
    ).toBe('allow');
  });

  it('does not let a command opt out of the sandbox', async () => {
    const out = await call(orchestrator, 'Bash', {
      command: 'git status',
      dangerouslyDisableSandbox: true,
    });
    expect(out.behavior).toBe('deny');
    expect(
      (
        await call(orchestrator, 'Bash', {
          command: 'git status',
          dangerouslyDisableSandbox: false,
        })
      ).behavior,
    ).toBe('allow');
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

  it('allows web tools only when asked to, and WebFetch only for public hosts', async () => {
    const web = makeCanUseTool({ cwd, allowWeb: true });
    expect((await call(web, 'WebFetch', { url: 'https://example.com' })).behavior).toBe('allow');
    expect((await call(web, 'WebSearch', { query: 'x' })).behavior).toBe('allow');
    for (const url of [
      'http://127.0.0.1:8787/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
      'http://10.1.2.3/',
      'http://vault.internal/',
    ]) {
      const denial = await call(web, 'WebFetch', { url });
      expect(denial.behavior, url).toBe('deny');
      expect((denial as { message: string }).message, url).toMatch(/public http\(s\) hosts/);
    }
    expect((await call(web, 'WebFetch', {})).behavior).toBe('deny');
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
