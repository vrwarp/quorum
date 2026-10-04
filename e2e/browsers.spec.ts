import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { hasManagedBrowser, newestChromium } from './browsers.js';

/**
 * How the Playwright config finds a Chromium when the revision Playwright wants is not installed (see browsers.ts).
 * No browser is started here: the specs build browser directories out of empty files.
 */

function browsersDir(...executables: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'quorum-browsers-'));
  for (const rel of executables) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  return root;
}

test.describe('newestChromium', () => {
  let root = '';
  test.afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  test('a headless run takes the headless shell, not the full Chromium that sorts after it by name', () => {
    root = browsersDir(
      'chromium-1194/chrome-linux/chrome',
      'chromium_headless_shell-1194/chrome-linux/headless_shell',
    );
    expect(newestChromium(root, false)).toBe(
      path.join(root, 'chromium_headless_shell-1194/chrome-linux/headless_shell'),
    );
  });

  test('a headed run takes the full Chromium: a headless shell cannot show a window', () => {
    root = browsersDir(
      'chromium-1194/chrome-linux/chrome',
      'chromium_headless_shell-1194/chrome-linux/headless_shell',
    );
    expect(newestChromium(root, true)).toBe(path.join(root, 'chromium-1194/chrome-linux/chrome'));
    rmSync(path.join(root, 'chromium-1194'), { recursive: true });
    expect(newestChromium(root, true)).toBeUndefined();
  });

  test('revisions compare as numbers: 1194 is newer than 999', () => {
    root = browsersDir(
      'chromium-999/chrome-linux/chrome',
      'chromium-1194/chrome-linux/chrome',
      'chromium_headless_shell-999/chrome-linux/headless_shell',
      'chromium_headless_shell-1194/chrome-linux/headless_shell',
    );
    expect(newestChromium(root, true)).toBe(path.join(root, 'chromium-1194/chrome-linux/chrome'));
    expect(newestChromium(root, false)).toBe(
      path.join(root, 'chromium_headless_shell-1194/chrome-linux/headless_shell'),
    );
  });

  test('knows both build layouts, and the newest build that actually has an executable wins', () => {
    root = browsersDir(
      'chromium-1243/chrome-linux64/chrome',
      'chromium-1200/chrome-linux/chrome',
      'chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
    );
    expect(newestChromium(root, true)).toBe(path.join(root, 'chromium-1243/chrome-linux64/chrome'));
    expect(newestChromium(root, false)).toBe(
      path.join(
        root,
        'chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
      ),
    );
    // a newer revision directory without an executable (a failed download) is skipped
    mkdirSync(path.join(root, 'chromium-1300'));
    mkdirSync(path.join(root, 'chromium_headless_shell-1300'));
    expect(newestChromium(root, true)).toBe(path.join(root, 'chromium-1243/chrome-linux64/chrome'));
    expect(newestChromium(root, false)).toContain('chromium_headless_shell-1243');
  });

  test('a headless run falls back to a full Chromium when there is no headless shell at all', () => {
    root = browsersDir('chromium-1194/chrome-linux/chrome');
    expect(newestChromium(root, false)).toBe(path.join(root, 'chromium-1194/chrome-linux/chrome'));
  });

  test('ignores everything else in the directory, and a directory that is not there', () => {
    root = browsersDir(
      'ffmpeg-1011/ffmpeg-linux',
      'firefox-1500/firefox/firefox',
      'chromium/readme',
    );
    expect(newestChromium(root, true)).toBeUndefined();
    expect(newestChromium(root, false)).toBeUndefined();
    expect(newestChromium(path.join(root, 'nowhere'), false)).toBeUndefined();
  });
});

test.describe('hasManagedBrowser', () => {
  let root = '';
  test.afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  test('a headed run needs the full Chromium Playwright names; a headless run needs the headless shell beside it', () => {
    root = browsersDir('chromium-1243/chrome-linux64/chrome');
    const managed = path.join(root, 'chromium-1243/chrome-linux64/chrome');
    expect(hasManagedBrowser(root, managed, true)).toBe(true);
    // the full browser alone does not serve a headless run: Playwright would launch chromium-headless-shell
    expect(hasManagedBrowser(root, managed, false)).toBe(false);
    mkdirSync(path.join(root, 'chromium_headless_shell-1243'));
    expect(hasManagedBrowser(root, managed, false)).toBe(true);
  });

  test("is false when Playwright's revision is not installed, which is when the fallback applies", () => {
    root = browsersDir('chromium-1194/chrome-linux/chrome', 'chromium_headless_shell-1194/x');
    const managed = path.join(root, 'chromium-1243/chrome-linux64/chrome');
    expect(hasManagedBrowser(root, managed, true)).toBe(false);
    expect(hasManagedBrowser(root, managed, false)).toBe(false);
  });
});
