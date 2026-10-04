import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * Tool permission policy for Agent SDK sessions (orchestrator, workers, merge driver).
 *
 * Bash is limited to read-only git, prettier in check mode, and read-only shell commands. The command is lexed here
 * (quotes, pipes, words) instead of pattern-matched, so quoting tricks cannot smuggle a path past the checks:
 * everything is judged on the words the shell would actually produce. Anything that chains, redirects, expands
 * variables or globs, groups, or escapes the worktree is denied.
 *
 * Options are judged against per-program allow-lists, never deny-lists: git's option grammar is far too large to
 * enumerate what is dangerous (`--output`, `--ext-diff`, `-O`, `--no-index`, ...), so an option is allowed only when
 * this file names it for that subcommand. Shell globs are the other way a file name could end up in option position
 * (`git log *.md` with a file called `--output=x.md`), so git commands take none, other commands only globs that start
 * with a literal character or `./`, and agents cannot create files whose names start with `-`.
 *
 * A word that starts with - is always judged as an option, even where it would be the value of the option before it:
 * programs disagree about whether such a value is taken or read as another option, so the policy does not guess.
 *
 * File tools are confined to the session's cwd, and writes can be narrowed to the one document a session is assigned.
 * WebFetch is restricted to public http(s) hosts.
 */

const SIMPLE_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'diff']);

// --- git option allow-lists ------------------------------------------------------------------

interface OptionSpec {
  /** options without a value (`--stat`, `-p`), standing alone; short ones may be clustered (`-sb`) */
  flags: string[];
  /**
   * Options whose value is optional, so it can only be attached (`--stat=80`, `-U5`, `-M50%`, `--abbrev=8`); the bare
   * form is a flag of its own. The distinction matters: git does NOT take the next word as the value of an optional
   * argument (`git diff -U --output=x` runs `-U` and then `--output=x`), so such an option must never be treated as
   * consuming it. Names listed only here (`--format`) exist only in the attached form.
   */
  attached?: string[];
  /** Options that require a value, given attached or as the next word (`--grep=x`, `--grep x`, `-n5`, `-n 5`). */
  valued: string[];
  /** `-5` (a bare number) is allowed */
  numeric?: boolean;
}

/** Output and comparison options shared by diff, log, show, diff-tree. None of them runs a program or writes a file. */
const DIFF_FLAGS = [
  '-p',
  '-u',
  '--patch',
  '--no-patch',
  '-s',
  '--stat',
  '--numstat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--summary',
  '--raw',
  '--compact-summary',
  '--no-color',
  '--color',
  '-w',
  '--ignore-all-space',
  '-b',
  '--ignore-space-change',
  '--ignore-space-at-eol',
  '--ignore-blank-lines',
  '--ignore-cr-at-eol',
  '--word-diff',
  '--minimal',
  '--patience',
  '--histogram',
  '-M',
  '--find-renames',
  '--no-renames',
  '-z',
  '--full-index',
  '--abbrev',
  '-R',
  '-U',
  '--unified',
];
/** Their optional values. */
const DIFF_ATTACHED = [
  '-U',
  '--unified',
  '--stat',
  '--color',
  '--word-diff',
  '--abbrev',
  '-M',
  '--find-renames',
];
/** Their required values. */
const DIFF_VALUED = ['--word-diff-regex', '--diff-algorithm', '--diff-filter', '-S', '-G'];

const LOG_FLAGS = [
  '--oneline',
  '--graph',
  '--decorate',
  '--no-decorate',
  '--abbrev-commit',
  '--no-abbrev-commit',
  '--all-match',
  '-i',
  '--regexp-ignore-case',
  '-E',
  '--extended-regexp',
  '-F',
  '--fixed-strings',
  '--invert-grep',
  '--no-merges',
  '--merges',
  '--first-parent',
  '--reverse',
  '--topo-order',
  '--date-order',
  '--author-date-order',
  '--follow',
  '--left-right',
  '--ancestry-path',
  '--full-history',
  '--simplify-merges',
  '--parents',
  '--pretty',
  '--all',
  '--branches',
  '--tags',
];
const LOG_VALUED = [
  '-n',
  '--max-count',
  '--skip',
  '--since',
  '--until',
  '--after',
  '--before',
  '--author',
  '--committer',
  '--grep',
  '-L',
];

const GIT_OPTIONS: Record<string, OptionSpec> = {
  status: {
    flags: [
      '-s',
      '--short',
      '-b',
      '--branch',
      '--porcelain',
      '--long',
      '-u',
      '--untracked-files',
      '--no-renames',
      '--renames',
      '-z',
      '--ahead-behind',
      '--no-ahead-behind',
    ],
    attached: ['--porcelain', '--untracked-files', '-u'],
    valued: [],
  },
  diff: {
    flags: [...DIFF_FLAGS, '--cached', '--staged', '--exit-code', '--quiet', '--check'],
    attached: DIFF_ATTACHED,
    valued: DIFF_VALUED,
  },
  log: {
    flags: [...DIFF_FLAGS, ...LOG_FLAGS],
    attached: [...DIFF_ATTACHED, '--format', '--pretty', '--date'],
    valued: [...DIFF_VALUED, ...LOG_VALUED],
    numeric: true,
  },
  show: {
    flags: [
      ...DIFF_FLAGS,
      '--oneline',
      '--abbrev-commit',
      '--no-abbrev-commit',
      '--quiet',
      '--pretty',
    ],
    attached: [...DIFF_ATTACHED, '--format', '--pretty', '--date'],
    valued: DIFF_VALUED,
  },
  blame: {
    flags: [
      '-w',
      '-s',
      '-e',
      '--porcelain',
      '--line-porcelain',
      '-l',
      '-t',
      '-M',
      '-C',
      '-b',
      '--root',
      '--first-parent',
      '-f',
      '--show-name',
      '-n',
      '--show-number',
    ],
    attached: ['--date', '--abbrev', '-M', '-C'],
    valued: ['-L'],
  },
  'ls-files': {
    flags: [
      '-c',
      '--cached',
      '-m',
      '--modified',
      '-o',
      '--others',
      '-d',
      '--deleted',
      '-s',
      '--stage',
      '--exclude-standard',
      '--full-name',
      '-t',
      '-v',
      '-z',
    ],
    valued: [],
  },
  'ls-tree': {
    flags: [
      '-r',
      '-t',
      '-d',
      '-l',
      '--long',
      '--name-only',
      '--name-status',
      '--full-name',
      '--full-tree',
      '--abbrev',
      '-z',
    ],
    attached: ['--abbrev'],
    valued: [],
  },
  'rev-parse': {
    flags: [
      '--short',
      '--verify',
      '--abbrev-ref',
      '--symbolic-full-name',
      '--is-inside-work-tree',
      '--quiet',
      '-q',
    ],
    attached: ['--short', '--abbrev-ref'],
    valued: [],
  },
  'rev-list': {
    flags: [
      '--all',
      '--branches',
      '--tags',
      '--count',
      '--reverse',
      '--first-parent',
      '--no-merges',
      '--merges',
      '--parents',
      '--left-right',
      '--ancestry-path',
      '--abbrev-commit',
      '--oneline',
      '-i',
      '--regexp-ignore-case',
      '-E',
      '--extended-regexp',
      '-F',
      '--fixed-strings',
      '--all-match',
    ],
    valued: [
      '-n',
      '--max-count',
      '--skip',
      '--since',
      '--until',
      '--after',
      '--before',
      '--author',
      '--committer',
      '--grep',
    ],
    numeric: true,
  },
  'cat-file': { flags: ['-p', '-t', '-s', '-e'], valued: [] },
  grep: {
    flags: [
      '-n',
      '--line-number',
      '-i',
      '--ignore-case',
      '-w',
      '--word-regexp',
      '-F',
      '--fixed-strings',
      '-E',
      '--extended-regexp',
      '-G',
      '--basic-regexp',
      '-P',
      '--perl-regexp',
      '-c',
      '--count',
      '-l',
      '--files-with-matches',
      '--name-only',
      '-L',
      '--files-without-match',
      '-h',
      '-H',
      '-v',
      '--invert-match',
      '-I',
      '-a',
      '--text',
      '-o',
      '--only-matching',
      '-q',
      '--quiet',
      '--no-color',
      '--color',
      '--full-name',
      '--heading',
      '--break',
      '--and',
      '--or',
      '--not',
      '--all-match',
    ],
    attached: ['--color'],
    valued: ['-e', '-A', '-B', '-C', '--max-depth'],
    numeric: true,
  },
  shortlog: {
    flags: [
      '-s',
      '--summary',
      '-n',
      '--numbered',
      '-e',
      '--email',
      '--no-merges',
      '--merges',
      '--first-parent',
      // `--committer` groups by committer here, with no value (`--committer=<pattern>` filters)
      '--committer',
    ],
    attached: ['--committer'],
    valued: ['--since', '--until', '--after', '--before', '--author', '--grep'],
  },
  'show-ref': {
    flags: [
      '--head',
      '--heads',
      '--tags',
      '-s',
      '--hash',
      '-d',
      '--dereference',
      '--verify',
      '-q',
      '--quiet',
      '--abbrev',
    ],
    attached: ['--hash', '--abbrev'],
    valued: [],
  },
  'merge-base': {
    flags: ['--is-ancestor', '--all', '--fork-point', '--octopus', '--independent'],
    valued: [],
  },
  'diff-tree': {
    flags: [
      '-r',
      '-t',
      '-p',
      '--patch',
      '--stat',
      '--numstat',
      '--shortstat',
      '--name-only',
      '--name-status',
      '--summary',
      '--raw',
      '--no-commit-id',
      '--root',
      '-m',
      '-c',
      '--cc',
      '--no-color',
      '-z',
      '--abbrev',
      '--full-index',
    ],
    attached: ['--abbrev', '--stat'],
    valued: [],
  },
  describe: {
    flags: ['--tags', '--always', '--long', '--abbrev', '--exact-match', '--first-parent', '--all'],
    attached: ['--abbrev'],
    valued: ['--candidates'],
  },
  'name-rev': { flags: ['--name-only', '--tags', '--always', '--no-undefined'], valued: [] },
};

/** Subcommands the model may run. Committing goes through commit_main, so there is no `add`, `commit` or `reset`. */
const GIT_SUBCOMMANDS = Object.keys(GIT_OPTIONS);

/** Options of the other programs that take any. Programs not listed here take options freely (they run nothing). */
const OPTION_SPECS: Record<string, OptionSpec> = {
  // check mode only: `--write` is not needed (formatting is applied at commit); plugin, config and cache options load code
  prettier: {
    flags: [
      '--check',
      '-c',
      '--list-different',
      '-l',
      '--no-config',
      '--no-editorconfig',
      '--no-color',
    ],
    valued: ['--prose-wrap', '--log-level'],
  },
  // `--pre` and `--hostname-bin` run programs, `-z` runs decompressors, `--config-path` and `--ignore-file` read files
  rg: {
    flags: [
      '-i',
      '--ignore-case',
      '-n',
      '--line-number',
      '-N',
      '--no-line-number',
      '-w',
      '--word-regexp',
      '-F',
      '--fixed-strings',
      '-S',
      '--smart-case',
      '-s',
      '--case-sensitive',
      '-v',
      '--invert-match',
      '-c',
      '--count',
      '-l',
      '--files-with-matches',
      '--files-without-match',
      '-o',
      '--only-matching',
      '-q',
      '--quiet',
      '-H',
      '--with-filename',
      '-I',
      '--no-filename',
      '-U',
      '--multiline',
      '--hidden',
      '--files',
      '--no-heading',
      '--heading',
      '--no-messages',
      '--no-color',
      '--column',
      '--trim',
      '--stats',
      '--sort-files',
    ],
    valued: [
      '-e',
      '--regexp',
      '-g',
      '--glob',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
      '-m',
      '--max-count',
      '--max-depth',
      '--color',
      '--sort',
      '-r',
      '--replace',
    ],
    numeric: true,
  },
  // `-f` and `-F` never end
  tail: {
    flags: ['-q', '--quiet', '-v', '--verbose'],
    valued: ['-n', '--lines', '-c', '--bytes'],
    numeric: true,
  },
};

export type BashCheck = { ok: true } | { ok: false; reason: string };

const CHAINING = 'chaining (; & && ||), redirection, expansion and grouping are not allowed';

/** Never allowed, quoted or not: variable and command substitution, escapes, line breaks, NUL. */
const ALWAYS_FORBIDDEN = /[`$\\\n\r\0]/;
/** Only literal inside quotes: chaining, redirection, grouping, brace expansion. */
const UNQUOTED_FORBIDDEN = new Set([';', '&', '<', '>', '(', ')', '{', '}']);

interface Word {
  /** the word as the shell would pass it on: quotes removed, pieces joined */
  value: string;
  /** contains an unquoted * or ? (the shell would expand it into file names) */
  glob: boolean;
}

type Lexed = { ok: true; segments: Word[][] } | { ok: false; reason: string };

function lex(command: string): Lexed {
  const segments: Word[][] = [[]];
  let word: Word | null = null;
  const flush = () => {
    if (word) segments[segments.length - 1]!.push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end === -1) return { ok: false, reason: 'unterminated quote' };
      word ??= { value: '', glob: false };
      word.value += command.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    if (ch === '|') {
      flush();
      if (command[i + 1] === '|') return { ok: false, reason: CHAINING };
      segments.push([]);
      continue;
    }
    if (UNQUOTED_FORBIDDEN.has(ch)) return { ok: false, reason: CHAINING };
    if (ch === '[' || ch === ']')
      return {
        ok: false,
        reason: 'bracket globs are not allowed; quote the character or name the file',
      };
    word ??= { value: '', glob: false };
    if (ch === '*' || ch === '?') word.glob = true;
    word.value += ch;
  }
  flush();
  return { ok: true, segments };
}

/** True when a path-like word leaves the worktree: absolute, home-relative, or with a `..` component. */
function escapesWorktree(value: string): boolean {
  // `--opt=path`, `rev:path` and `a=b` forms: judge each side
  return value
    .split(/[:=]/)
    .some((part) => part.startsWith('/') || part.startsWith('~') || part.split('/').includes('..'));
}

/** Judges one option word against a spec; `takesNext` says the option wants the following word as its value. */
function checkOption(
  word: string,
  spec: OptionSpec,
): { ok: true; takesNext: boolean } | { ok: false } {
  const flags = new Set(spec.flags);
  const attached = new Set(spec.attached ?? []);
  const valued = new Set(spec.valued);
  if (spec.numeric && /^-\d+$/.test(word)) return { ok: true, takesNext: false };
  if (flags.has(word)) return { ok: true, takesNext: false };
  const eq = word.indexOf('=');
  if (word.startsWith('--') && eq > 2) {
    const name = word.slice(0, eq);
    return valued.has(name) || attached.has(name) ? { ok: true, takesNext: false } : { ok: false };
  }
  if (!word.startsWith('--') && word.length > 2) {
    // `-n5`, `-Sfoo`, `-U3`, `-L10,20:file`: a short option with its value attached
    const head = word.slice(0, 2);
    if (valued.has(head) || attached.has(head)) return { ok: true, takesNext: false };
    // `-sb`: a cluster of boolean short options
    if (/^-[A-Za-z]+$/.test(word) && [...word.slice(1)].every((c) => flags.has(`-${c}`)))
      return { ok: true, takesNext: false };
    return { ok: false };
  }
  // an option that requires a value takes the next word; one with an optional value (listed in `flags`) never does
  if (valued.has(word)) return { ok: true, takesNext: true };
  return { ok: false };
}

/** A glob the shell would expand must not be able to produce a name that reads as an option, or leave the directory. */
function checkGlob(value: string): string | null {
  const rest = value.startsWith('./') ? value.slice(2) : value;
  if (rest.includes('/'))
    return 'globs may only match files in the current directory (no / except a leading ./)';
  if (rest.startsWith('.')) return 'globs may not start with . (they would match . and ..)';
  if (!value.startsWith('./') && !/^[A-Za-z0-9_]/.test(rest))
    return 'start globs with a letter, a digit or ./ (for example ./*.md) so that a file name can never read as an option';
  return null;
}

export function checkBashCommand(command: unknown): BashCheck {
  if (typeof command !== 'string' || command.trim() === '')
    return { ok: false, reason: 'empty command' };
  if (command.length > 2000) return { ok: false, reason: 'command too long' };
  if (ALWAYS_FORBIDDEN.test(command)) {
    return {
      ok: false,
      reason:
        'variable and command substitution ($ and backticks), backslashes and line breaks are not allowed',
    };
  }
  const lexed = lex(command);
  if (!lexed.ok) return lexed;

  for (const words of lexed.segments) {
    if (words.length === 0) return { ok: false, reason: 'empty pipeline segment' };
    let program = words[0]!.value;
    let args = words.slice(1);
    if (words[0]!.glob) return { ok: false, reason: 'the command name cannot be a glob' };
    if (program === 'npx') {
      // only a locally installed prettier: plain `npx prettier` may download a package
      const [first, second] = args.map((w) => w.value);
      if (
        first === 'prettier' ||
        ((first === '--no-install' || first === '--no') && second === 'prettier')
      ) {
        program = 'prettier';
        args = args.slice(first === 'prettier' ? 1 : 2);
      } else {
        return { ok: false, reason: 'npx is only allowed as `npx --no-install prettier`' };
      }
    }
    if (program !== 'git' && program !== 'prettier' && !SIMPLE_COMMANDS.has(program)) {
      return {
        ok: false,
        reason: `\`${program}\` is not allowed; use git, prettier, ls, cat, head, tail, wc, grep, rg, pwd or diff`,
      };
    }

    let spec: OptionSpec | undefined = OPTION_SPECS[program];
    let label: string = program;
    if (program === 'git') {
      const sub = args[0]?.value;
      if (!sub || sub.startsWith('-') || !GIT_SUBCOMMANDS.includes(sub)) {
        return {
          ok: false,
          reason: `git ${sub ?? ''} is not allowed; allowed: ${GIT_SUBCOMMANDS.join(', ')} (commit through commit_main)`,
        };
      }
      spec = GIT_OPTIONS[sub]!;
      label = `git ${sub}`;
      args = args.slice(1);
    }

    let optionsEnded = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const v = arg.value;
      if (escapesWorktree(v))
        return {
          ok: false,
          reason: 'absolute paths, ~ and .. are not allowed; stay inside the worktree',
        };
      if (arg.glob) {
        if (program === 'git')
          return {
            ok: false,
            reason:
              'git commands take no unquoted * or ?: the shell would expand them into file names that could pass for options (name the file, or quote a pattern for git to match itself)',
          };
        const why = checkGlob(v);
        if (why) return { ok: false, reason: why };
      }
      if (optionsEnded) {
        // after `--` everything is a file name, and a file name never starts with -
        if (program === 'git' && v.startsWith('-'))
          return { ok: false, reason: 'file names starting with - are not allowed' };
        continue;
      }
      if (v === '--') {
        optionsEnded = true;
        continue;
      }
      if (!v.startsWith('-') || v === '-') continue; // a revision, a path or a pattern
      if (!spec) continue; // programs without a spec take options freely
      const verdict = checkOption(v, spec);
      if (!verdict.ok) {
        return {
          ok: false,
          reason: `option ${v.length > 40 ? `${v.slice(0, 39)}…` : v} is not allowed for ${label}`,
        };
      }
      if (verdict.takesNext && !args[i + 1])
        return { ok: false, reason: `option ${v} needs a value` };
      // The value is the next word, which the next iteration judges like any other word. It is never skipped: a value
      // that starts with - is judged as an option, so the policy does not depend on how each program parses a value
      // (some take it whatever it looks like, others, like prettier, read `--opt --other` as two options).
    }
  }
  return { ok: true };
}

export function isAllowedBashCommand(command: unknown): boolean {
  return checkBashCommand(command).ok;
}

// --- WebFetch ----------------------------------------------------------------------------------

/** IPv4 literal in dotted decimal (the WHATWG URL parser rewrites 2130706433, 0x7f.1 and 127.1 to this form). */
function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return a! < 224; // multicast and reserved
}

/** The eight 16-bit groups of an IPv6 literal (without brackets), or null when it is not one. */
function parseIpv6(host: string): number[] | null {
  let text = host;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const parts = parseIpv4(v4[1]!);
    if (!parts) return null;
    text = `${text.slice(0, -v4[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isPublicIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return false; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return isPublicIpv4(embedded(g6, g7)); // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return isPublicIpv4(embedded(g6, g7)); // NAT64
  if (g0 === 0x2002) return isPublicIpv4(embedded(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard
  return true;
}

/** Name suffixes that are never public hosts. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'internal',
  'local',
  'localdomain',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
  'home.arpa',
];

/**
 * WebFetch may only reach the public internet: http(s), no credentials in the URL, no loopback, link-local (cloud
 * metadata), private or reserved addresses, no single-label names (`localhost`, `metadata`, `db`) and no internal
 * domain suffixes. Names are judged as written: a public name that resolves to a private address (DNS rebinding) is
 * not caught here, so network egress policy remains the second layer.
 */
export function checkWebUrl(raw: unknown): BashCheck {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'no URL' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'only http and https URLs are allowed' };
  if (url.username || url.password)
    return { ok: false, reason: 'URLs with credentials are not allowed' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'the URL has no host' };
  const notPublic = { ok: false as const, reason: `${host} is not a public host` };
  if (host.startsWith('[')) {
    const groups = parseIpv6(host.slice(1, -1));
    return groups && isPublicIpv6(groups) ? { ok: true } : notPublic;
  }
  const v4 = parseIpv4(host);
  if (v4) return isPublicIpv4(v4) ? { ok: true } : notPublic;
  if (!host.includes('.')) return notPublic;
  if (INTERNAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return notPublic;
  return { ok: true };
}

// --- tool callback -------------------------------------------------------------------------------

export interface PermissionPolicyOptions {
  /** the session's working directory; file tools may not leave it */
  cwd: string;
  /** WebSearch / WebFetch (exploration workers only) */
  allowWeb?: boolean;
  /** MCP tool names (mcp__quorum__...) this session may call; others are denied */
  allowedMcpTools?: string[];
  /** disable all built-in tools (digest writer) */
  mcpOnly?: boolean;
  /** Edit and Write may only touch these files (paths relative to cwd): the single-document scope rule. */
  writableFiles?: string[];
  /** Edit and Write may touch markdown documents at the root of cwd (the orchestrator's scratch worktree). */
  writableRootMarkdown?: boolean;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write']);

function insideCwd(cwd: string, p: string): boolean {
  const rel = relative(cwd, resolve(cwd, p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function relativePosix(cwd: string, p: string): string {
  return relative(cwd, resolve(cwd, p)).split(sep).join('/');
}

function writable(opts: PermissionPolicyOptions, p: string): boolean {
  const rel = relativePosix(opts.cwd, p);
  // a file whose name starts with - could be read as an option by anything that later sees it in a command line
  if ((rel.split('/').pop() ?? '').startsWith('-')) return false;
  if (!opts.writableFiles && !opts.writableRootMarkdown) return true;
  if (opts.writableFiles?.includes(rel)) return true;
  return Boolean(opts.writableRootMarkdown) && /^[^/.-][^/]*\.md$/i.test(rel);
}

function globEscapes(pattern: string): boolean {
  return pattern.startsWith('/') || pattern.startsWith('~') || pattern.split('/').includes('..');
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

export function makeCanUseTool(opts: PermissionPolicyOptions): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName.startsWith('mcp__')) {
      return opts.allowedMcpTools?.includes(toolName)
        ? { behavior: 'allow', updatedInput: input }
        : deny(`tool ${toolName} is not available in this session`);
    }
    if (opts.mcpOnly) return deny('built-in tools are disabled in this session');
    if (toolName === 'Bash') {
      if (input.dangerouslyDisableSandbox === true)
        return deny('Bash command denied: commands always run under the sandbox settings');
      const check = checkBashCommand(input.command);
      return check.ok
        ? { behavior: 'allow', updatedInput: input }
        : deny(`Bash command denied: ${check.reason}`);
    }
    if (FILE_TOOLS.has(toolName)) {
      for (const key of ['file_path', 'path']) {
        const v = input[key];
        if (typeof v === 'string' && !insideCwd(opts.cwd, v))
          return deny(`${toolName} is limited to the working directory`);
      }
      const glob =
        toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined;
      if (typeof glob === 'string' && globEscapes(glob))
        return deny(`${toolName} patterns must stay inside the working directory`);
      if (WRITE_TOOLS.has(toolName)) {
        const target = input.file_path;
        if (typeof target !== 'string' || !writable(opts, target)) {
          const scope = opts.writableFiles
            ? opts.writableFiles.join(', ')
            : 'the markdown documents at the repository root';
          return deny(`${toolName} is limited to ${scope}: a change touches exactly one document`);
        }
      }
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'WebSearch' && opts.allowWeb)
      return { behavior: 'allow', updatedInput: input };
    if (toolName === 'WebFetch' && opts.allowWeb) {
      const check = checkWebUrl(input.url);
      return check.ok
        ? { behavior: 'allow', updatedInput: input }
        : deny(`WebFetch denied: ${check.reason}; only public http(s) hosts can be fetched`);
    }
    return deny(`tool ${toolName} is not available in this session`);
  };
}
