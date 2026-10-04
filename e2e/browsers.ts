import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Where each kind of Chromium keeps its executable, by build layout (older and newer builds differ). */
const FULL_CHROMIUM = ['chrome-linux64/chrome', 'chrome-linux/chrome'];
const HEADLESS_SHELL = [
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-linux/headless_shell',
];

function builds(root: string, family: string): Array<{ dir: string; revision: number }> {
  const pattern = new RegExp(`^${family}-(\\d+)$`);
  const out: Array<{ dir: string; revision: number }> = [];
  for (const name of readdirSync(root)) {
    const m = pattern.exec(name);
    if (m) out.push({ dir: path.join(root, name), revision: Number(m[1]) });
  }
  // numeric, newest first: "chromium-999" is older than "chromium-1194"
  return out.sort((a, b) => b.revision - a.revision);
}

function firstExisting(found: Array<{ dir: string }>, layouts: string[]): string | undefined {
  for (const { dir } of found) {
    for (const rel of layouts) {
      const file = path.join(dir, rel);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

/**
 * The Chromium to launch from the browsers directory `root` when Playwright's own revision is not installed. Headless
 * runs (Playwright launches chromium-headless-shell for them) take the newest headless shell, and only without one a
 * full Chromium, which also runs headless; headed runs need a full Chromium (a headless shell cannot show a window).
 */
export function newestChromium(root: string, headed: boolean): string | undefined {
  if (!existsSync(root)) return undefined;
  const full = firstExisting(builds(root, 'chromium'), FULL_CHROMIUM);
  if (headed) return full;
  return firstExisting(builds(root, 'chromium_headless_shell'), HEADLESS_SHELL) ?? full;
}

/**
 * Whether Playwright's own browser for this mode is installed. `managed` is where it would look for the full
 * Chromium (chromium.executablePath()); headless runs use the headless shell installed beside it at the same revision.
 */
export function hasManagedBrowser(root: string, managed: string, headed: boolean): boolean {
  if (headed) return existsSync(managed);
  const relative = path.relative(root, managed);
  const revision = /^chromium-(\d+)(?:[\\/]|$)/.exec(relative)?.[1];
  if (!revision) return existsSync(managed);
  return existsSync(path.join(root, `chromium_headless_shell-${revision}`));
}
