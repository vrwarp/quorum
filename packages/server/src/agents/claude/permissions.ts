import { isAbsolute, relative, resolve } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * Tool permission policy for Agent SDK sessions (orchestrator, workers, merge driver).
 *
 * Bash is limited to git (read-only subcommands plus `add`), prettier, and read-only shell commands. Anything that
 * chains, redirects, substitutes or escapes the worktree is denied. File tools are confined to the session's cwd.
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

/** shell syntax that chains, redirects or substitutes (a lone `|` pipe is handled separately) */
const FORBIDDEN_SYNTAX = /[;&`<>\n\r]|\$\(|\$\{/;

const FORBIDDEN_ARG_PREFIXES: Record<string, string[]> = {
  git: ['--output', '--ext-diff', '--exec', '--upload-pack', '--open-files-in-pager', '-O'],
  prettier: ['--plugin', '--config', '--ignore-path'],
  rg: ['--pre', '--hostname-bin'],
};

export type BashCheck = { ok: true } | { ok: false; reason: string };

export function checkBashCommand(command: unknown): BashCheck {
  if (typeof command !== 'string' || command.trim() === '') return { ok: false, reason: 'empty command' };
  if (command.length > 2000) return { ok: false, reason: 'command too long' };
  if (FORBIDDEN_SYNTAX.test(command)) {
    return { ok: false, reason: 'chaining (; & &&), redirection, backticks and command substitution are not allowed' };
  }
  for (const segment of command.split('|')) {
    const tokens = segment.trim().split(/\s+/).map(stripQuotes).filter((t) => t !== '');
    if (tokens.length === 0) return { ok: false, reason: 'empty pipeline segment' };
    let program = tokens[0]!;
    let args = tokens.slice(1);
    if (program === 'npx') {
      if (args[0] !== 'prettier') return { ok: false, reason: 'npx is only allowed for prettier' };
      program = 'prettier';
      args = args.slice(1);
    }
    if (program !== 'git' && program !== 'prettier' && !SIMPLE_COMMANDS.has(program)) {
      return { ok: false, reason: `\`${program}\` is not allowed; use git, prettier, ls, cat, head, tail, wc, grep, rg, pwd or diff` };
    }
    if (program === 'git') {
      const sub = args[0];
      if (!sub || sub.startsWith('-') || !GIT_SUBCOMMANDS.has(sub)) {
        return { ok: false, reason: `git ${sub ?? ''} is not allowed; allowed: ${[...GIT_SUBCOMMANDS].join(', ')} (commit through commit_main)` };
      }
    }
    for (const arg of args) {
      const bad = FORBIDDEN_ARG_PREFIXES[program]?.find((p) => arg.startsWith(p));
      if (bad) return { ok: false, reason: `option ${bad} is not allowed` };
      if (escapesWorktree(arg)) return { ok: false, reason: 'absolute paths and .. are not allowed; stay inside the worktree' };
    }
  }
  return { ok: true };
}

function stripQuotes(t: string): string {
  return t.replace(/^(['"])(.*)\1$/, '$2');
}

function escapesWorktree(arg: string): boolean {
  const v = arg.includes('=') && arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg;
  return v.startsWith('/') || v.startsWith('~') || v === '..' || v.startsWith('../') || v.includes('/../') || v.endsWith('/..');
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
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob']);

function insideCwd(cwd: string, p: string): boolean {
  const rel = relative(cwd, resolve(cwd, p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

export function makeCanUseTool(opts: PermissionPolicyOptions): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName.startsWith('mcp__')) {
      return opts.allowedMcpTools?.includes(toolName) ? { behavior: 'allow', updatedInput: input } : deny(`tool ${toolName} is not available in this session`);
    }
    if (opts.mcpOnly) return deny('built-in tools are disabled in this session');
    if (toolName === 'Bash') {
      const check = checkBashCommand(input.command);
      return check.ok ? { behavior: 'allow', updatedInput: input } : deny(`Bash command denied: ${check.reason}`);
    }
    if (FILE_TOOLS.has(toolName)) {
      for (const key of ['file_path', 'path']) {
        const v = input[key];
        if (typeof v === 'string' && !insideCwd(opts.cwd, v)) return deny(`${toolName} is limited to the working directory`);
      }
      return { behavior: 'allow', updatedInput: input };
    }
    if ((toolName === 'WebSearch' || toolName === 'WebFetch') && opts.allowWeb) return { behavior: 'allow', updatedInput: input };
    return deny(`tool ${toolName} is not available in this session`);
  };
}
