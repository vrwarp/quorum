import process from 'node:process';

/**
 * node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature" the first time it is loaded. This
 * filter drops exactly that warning; every other warning goes through untouched. It only helps if it runs before
 * node:sqlite loads, and Node loads a statically imported `node:sqlite` while linking the module graph, i.e. before
 * any module body runs. So db/index.ts imports this file first and loads `node:sqlite` with require() at call time.
 */
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text =
    typeof warning === 'string' ? warning : ((warning as Error | undefined)?.message ?? '');
  if (text.includes('SQLite is an experimental feature')) return;
  return (originalEmit as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
