import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  cwd: string;
  input?: string;
  /** when true a non-zero exit resolves instead of rejecting */
  allowFail?: boolean;
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    super(`git ${args.slice(0, 4).join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // inherited repository selection (e.g. when started from inside a git hook) must never leak in
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
  ]) {
    delete env[k];
  }
  return {
    ...env,
    // never depend on the host's git configuration; all needed config is set at the repository level
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    LC_ALL: 'C',
  };
}

/** Run `git <args>` with execFile (no shell). */
export function runGit(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd: opts.cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const code =
          typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
        if (opts.allowFail && typeof (err as { code?: unknown }).code === 'number')
          return resolve({ stdout, stderr, code });
        reject(new GitError(args, code, stderr ?? String(err), stdout ?? ''));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
