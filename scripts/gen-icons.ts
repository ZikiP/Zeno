/**
 * 从 icon.svg 生成 PWA 需要的 PNG 图标（192 / 512）。
 * 复用 Playwright MCP 已下载的 Chromium，不额外下载浏览器。
 */
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, '../public/icon.svg'), 'utf8');

// playwright-core 不自带浏览器，复用 Playwright MCP 已下载的 chromium-1228
// 注意目录名是 chrome-win64（不是 chrome-win）
const CACHE = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const dirs = existsSync(CACHE) ? readdirSync(CACHE) : [];
const chromeDir = dirs.find((d) => /^chromium-\d+$/.test(d));
const exe = chromeDir
  ? join(CACHE, chromeDir, 'chrome-win64', 'chrome.exe')
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';

console.log('using browser:', exe);

const browser = await chromium.launch({ headless: true, executablePath: exe });

for (const size of [192, 512]) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">
       ${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}
     </body></html>`,
  );
  await page.screenshot({
    path: resolve(here, `../public/icon-${size}.png`),
    omitBackground: true,
  });
  await page.close();
  console.log(`generated icon-${size}.png`);
}

await browser.close();
