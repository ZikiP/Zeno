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
let sharedCtx = null;
let openPages = 0;
let idleTimer = null;

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    await teardown();
    console.log('[zeno] 渲染浏览器空闲超时，已关闭');
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function teardown() {
  try {
    await sharedCtx?.close();
  } catch {
    /* 已随浏览器一起回收 */
  }
  sharedCtx = null;
  try {
    await browser?.close();
  } catch {
    /* 已经关了 */
  }
  browser = null;
  launching = null;
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
      sharedCtx = null;
    });
  } finally {
    launching = null;
  }
  return browser;
}

/**
 * 全站共享一个 context —— 也就是同一个浏览器会话。
 *
 * 每次请求新建 context 会把会话 cookie 一起丢掉，于是带 JS 质询的站点
 * 每一个页面都要从零再解一次质询：实测列表页 40s、详情页直接撑破 45s 超时。
 * 复用同一个会话后只有第一次付这个代价，后续就是正常页面加载。
 * 这不是伪装 —— 浏览器对连续翻页的正常用户本来就是这么做的。
 */
async function getContext(userAgent) {
  const b = await getBrowser();
  if (sharedCtx) return sharedCtx;
  sharedCtx = await b.newContext({
    userAgent: userAgent || DESKTOP_UA,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  return sharedCtx;
}

/**
 * 渲染一个页面并返回 HTML。
 * @param {string} url
 * @param {{waitFor?: string, timeoutMs?: number, userAgent?: string}} opts
 */
export async function renderHtml(url, opts = {}) {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 20_000, 5_000), 120_000);
  scheduleIdleClose();

  if (openPages >= MAX_PAGES) {
    throw Object.assign(new Error(`渲染并发已满（${MAX_PAGES}）`), { code: 'BUSY' });
  }
  openPages++;

  const ctx = await getContext(opts.userAgent);
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // waitFor 是**提示**而不是硬要求：插件只有一份 fetch.waitFor，却要覆盖
    // 列表 / 详情 / 章节三种页面，后两者往往没有列表的那个选择器。
    // 当成必须条件就会白等满超时再报错，所以超时后直接用当前 DOM。
    let settled = false;
    if (opts.waitFor) {
      settled = await page
        .waitForSelector(opts.waitFor, { timeout: timeoutMs })
        .then(() => true)
        .catch(() => false);
    } else {
      // 没有声明等待条件时，给 SPA 一个落地的机会；不是精确方案，但比立即抓强
      await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    }
    // 再让出一小段时间给"选择器已出现但内容仍在补"的站点
    await page.waitForTimeout(800).catch(() => {});
    const html = await page.content();

    /*
     * 状态码：渲染模式下首次导航的响应经常没有意义。
     * 实测带 JS 质询的站点会先回一个 403 的质询页，浏览器执行完 JS 后自行
     * 重新加载并渲染出完整内容 —— 此时 resp.status() 仍是 403，透传给上层
     * 就会被当成失败丢掉（客户端 fetchText 见 !res.ok 直接抛）。
     * 所以判据换成"要等的东西出来了没有"：等到了就是 200。
     */
    let status = resp?.status() ?? 200;
    if (settled) status = 200;
    else if (status >= 400 && html.length > 2000) status = 200;

    return { html, status, contentType: 'text/html; charset=utf-8' };
  } finally {
    openPages--;
    // 只关标签页，不关 context —— context 是全站共享的会话，关掉就等于
    // 把质询成果丢了，下一次请求又得从零再解一遍。
    await page.close().catch(() => {});
  }
}

export async function shutdownBrowser() {
  if (idleTimer) clearTimeout(idleTimer);
  await teardown();
}
