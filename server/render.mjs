/**
 * 浏览器渲染池（插件 fetch.mode = "browser" 的后端）
 *
 * 存在的理由：Zeno 的代理是 Node fetch，拿不到需要执行 JS 才出内容的页面。
 * 这里提供一个通用能力 —— 用一个真的浏览器引擎渲染后把 HTML 交回解析层。
 *
 * 刻意不做的事：**不加任何反自动化检测的伪装**（不改 navigator.webdriver、
 * 不伪造指纹、不破解质询令牌）。这个模块的价值是"渲染 JS 生成的页面"，
 * 不是"冒充人类绕过站点的机器人拦截"。站点如果拒绝自动化客户端，
 * 那就应该被拒绝 —— 是否要访问是站点和使用者的事，不由这段代码代为决定。
 *
 * playwright-core 用动态 import：没装浏览器的机器上，服务端照常起，
 * 只是 browser 模式的插件会明确报错。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const IDLE_SHUTDOWN_MS = Number(process.env.BROWSER_IDLE_MS || 60_000);
const MAX_PAGES = Number(process.env.BROWSER_MAX_PAGES || 3);

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 找可用的 chromium 系浏览器。顺序与 scripts/gen-icons.ts 保持一致。 */
export function findBrowser() {
  if (process.env.ZENO_BROWSER && existsSync(process.env.ZENO_BROWSER)) {
    return { exe: process.env.ZENO_BROWSER, from: 'ZENO_BROWSER' };
  }

  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA?.replace(/\\AppData\\Roaming$/, '');
  const cache = localAppData ? join(localAppData, 'ms-playwright') : null;
  if (cache && existsSync(cache)) {
    const dir = readdirSync(cache).find((d) => /^chromium-\d+$/.test(d));
    if (dir) {
      for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, dir, sub);
        if (existsSync(p)) return { exe: p, from: 'ms-playwright' };
      }
    }
  }

  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { exe: p, from: 'system' };
  }
  return null;
}

let browser = null;
let launching = null;
let openPages = 0;
let idleTimer = null;

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try {
      await browser?.close();
    } catch {
      /* 已经关了 */
    }
    browser = null;
    launching = null;
    console.log('[zeno] 浏览器空闲超时，已关闭');
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function getBrowser() {
  if (browser) return browser;
  if (launching) return launching;

  const found = findBrowser();
  if (!found) {
    throw Object.assign(
      new Error('服务端没有可用的 chromium 系浏览器，无法使用 fetch.mode="browser"'),
      { code: 'NO_BROWSER' },
    );
  }
  const { chromium } = await import('playwright-core');
  launching = chromium.launch({ headless: true, executablePath: found.exe });
  try {
    browser = await launching;
    console.log(`[zeno] 渲染浏览器已启动（${found.from}）`);
    browser.on('disconnected', () => {
      browser = null;
      launching = null;
    });
  } finally {
    launching = null;
  }
  return browser;
}

/**
 * 渲染一个页面并返回 HTML。
 * @param {string} url
 * @param {{waitFor?: string, timeoutMs?: number, userAgent?: string}} opts
 */
export async function renderHtml(url, opts = {}) {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 20_000, 5_000), 120_000);
  const b = await getBrowser();
  scheduleIdleClose();

  if (openPages >= MAX_PAGES) {
    throw Object.assign(new Error(`渲染并发已满（${MAX_PAGES}）`), { code: 'BUSY' });
  }
  openPages++;

  const ctx = await b.newContext({
    userAgent: opts.userAgent || DESKTOP_UA,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  try {
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { timeout: timeoutMs });
    } else {
      // 没有声明等待条件时，给 SPA 一个落地的机会；不是精确方案，但比立即抓强
      await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    }
    const html = await page.content();
    return {
      html,
      status: resp?.status() ?? 200,
      contentType: 'text/html; charset=utf-8',
    };
  } finally {
    openPages--;
    await ctx.close().catch(() => {});
  }
}

export async function shutdownBrowser() {
  if (idleTimer) clearTimeout(idleTimer);
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
}
