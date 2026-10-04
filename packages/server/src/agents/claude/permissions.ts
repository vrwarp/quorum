import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * Tool permission policy for Agent SDK sessions (orchestrator, workers, merge driver).
 *
 * Bash is limited to git (read-only subcommands plus `add`), prettier in check mode, and read-only shell commands.
 * The command is lexed here (quotes, pipes, words) instead of pattern-matched, so quoting tricks cannot smuggle a path
 * past the checks: everything is judged on the words the shell would actually produce. Anything that chains, redirects,
 * expands variables or globs, groups, or escapes the worktree is denied. File tools are confined to the session's cwd,
 * and writes can be narrowed to the one document a session is assigned.
 */

const SIMPLE_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'diff']);

const GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'cat-file',
  'grep',
  'shortlog',
  'show-ref',
  'merge-base',
  'diff-tree',
  'describe',
  'name-rev',
  'add',
]);

/** Never allowed, quoted or not: variable and command substitution, escapes, line breaks, NUL. */
const ALWAYS_FORBIDDEN = /[`$\\\n\r\0]/;
/** Only literal inside quotes: chaining, redirection, grouping, brace expansion. */
const UNQUOTED_FORBIDDEN = new Set([';', '&', '<', '>', '(', ')', '{', '}']);

/** Option prefixes that run programs, write files, or load code, per program. */
const FORBIDDEN_ARG_PREFIXES: Record<string, string[]> = {
  git: [
    '--output',
    '--ext-diff',
    '--exec',
    '--upload-pack',
    '--open-files-in-pager',
    '-O',
    '--no-index',
  ],
  // `--write` is not needed: formatting is applied at commit. Config/plugin options would load code.
  prettier: ['--write', '-w', '--plugin', '--config', '--ignore-path', '--cache'],
  rg: ['--pre', '--hostname-bin'],
  tail: ['-f', '-F', '--follow'],
};

export type BashCheck = { ok: true } | { ok: false; reason: string };

interface Word {
  /** the word as the shell would pass it on: quotes removed, pieces joined */
  value: string;
  /** contains an unquoted * or ? */
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
      if (command[i + 1] === '|')
        return {
          ok: false,
          reason: 'chaining (; & && ||), redirection, expansion and grouping are not allowed',
        };
      segments.push([]);
      continue;
    }
    if (UNQUOTED_FORBIDDEN.has(ch))
      return {
        ok: false,
        reason: 'chaining (; & && ||), redirection, expansion and grouping are not allowed',
      };
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
    if (program === 'git') {
      const sub = args[0]?.value;
      if (!sub || sub.startsWith('-') || !GIT_SUBCOMMANDS.has(sub)) {
        return {
          ok: false,
          reason: `git ${sub ?? ''} is not allowed; allowed: ${[...GIT_SUBCOMMANDS].join(', ')} (commit through commit_main)`,
        };
      }
    }
    for (const arg of args) {
      const bad = FORBIDDEN_ARG_PREFIXES[program]?.find((p) => arg.value.startsWith(p));
      if (bad) return { ok: false, reason: `option ${bad} is not allowed` };
      if (escapesWorktree(arg.value))
        return {
          ok: false,
          reason: 'absolute paths, ~ and .. are not allowed; stay inside the worktree',
        };
      // a glob must not be able to reach a parent directory (`.*` matches `..`) or walk into subdirectories
      if (arg.glob && (arg.value.includes('/') || arg.value.startsWith('.'))) {
        return {
          ok: false,
          reason: 'globs may only match files in the current directory (no / and no leading .)',
        };
      }
    }
  }
  return { ok: true };
}

export function isAllowedBashCommand(command: unknown): boolean {
  return checkBashCommand(command).ok;
}

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
  /** Edit and Write may touch markdown documents at the root of cwd (the orchestrator's main worktree). */
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
  if (!opts.writableFiles && !opts.writableRootMarkdown) return true;
  const rel = relativePosix(opts.cwd, p);
  if (opts.writableFiles?.includes(rel)) return true;
  return Boolean(opts.writableRootMarkdown) && /^[^/.][^/]*\.md$/i.test(rel);
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
    if ((toolName === 'WebSearch' || toolName === 'WebFetch') && opts.allowWeb)
      return { behavior: 'allow', updatedInput: input };
    return deny(`tool ${toolName} is not available in this session`);
  };
}
