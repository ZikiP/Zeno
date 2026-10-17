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
import { captureScript, readCaptures } from './capture.mjs';
import { cacheGet, cachePut, keyFor } from './render-cache.mjs';
import { waitUntilSettled } from './render-wait.mjs';

export { renderCacheStats } from './render-cache.mjs';

/*
 * 空闲多久关掉渲染用的浏览器。60 秒对"阅读"是错的：一章读三分钟很常见，
 * 翻到下一话时浏览器已被收了，每章都要再付一次启动（实测 1.5s 的换章变 4s+）。
 * 代价是一个 chromium 进程多空挂 3 分钟（百来 MB），换来阅读期间不再隔章卡一次。
 */
const IDLE_SHUTDOWN_MS = Number(process.env.BROWSER_IDLE_MS || 180_000);
const MAX_PAGES = Number(process.env.BROWSER_MAX_PAGES || 3);
/** 把页面自己的子资源失败/脚本报错打到 stdout，专门用来诊断部署实例 */
const RENDER_DEBUG = process.env.ZENO_RENDER_DEBUG === '1';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 计划任务的会话没有真桌面，Windows 上的 Chromium 于是把窗口判定为"被挡住"，
 * 连带把渲染进程的计时器与 rAF 压到约 1% —— 表现是结构在、不报错、子资源不失败，
 * 但要几个计时周期才能完成的数据永远不到。这四条只关掉"看不见=后台"这条推论，
 * 请求、UA、指纹都不动，不是伪装。
 */
const LAUNCH_ARGS = [
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

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
    await teardown();
    console.log('[zeno] 渲染浏览器空闲超时，已关闭');
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function teardown() {
  for (const ctx of [...contexts.values()]) {
    try {
      await ctx.close();
    } catch {
      /* 已随浏览器一起回收 */
    }
  }
  contexts.clear();
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
  launching = chromium.launch({
    headless: true,
    executablePath: found.exe,
    args: LAUNCH_ARGS,
  });
  try {
    browser = await launching;
    console.log(`[zeno] 渲染浏览器已启动（${found.from}）`);
    browser.on('disconnected', () => {
      browser = null;
      launching = null;
      contexts.clear();
    });
  } finally {
    launching = null;
  }
  return browser;
}

/**
 * 同一个 UA 共享一个 context —— 也就是同一个浏览器会话。
 *
 * 每次请求新建 context 会把会话 cookie 一起丢掉，于是带 JS 质询的站点
 * 每一个页面都要从零再解一次质询：实测列表页 40s、详情页直接撑破 45s 超时。
 * 复用同一个会话后只有第一次付这个代价，后续就是正常页面加载。
 * 这不是伪装 —— 浏览器对连续翻页的正常用户本来就是这么做的。
 *
 * 按 UA 分开而不是全局一个：UA 现在可以由插件声明（有的站只给桌面 UA
 * 返回服务端渲染的内容），共用一个就等于让后装的那个插件的 UA 形同废纸。
 */
const contexts = new Map();

async function getContext(userAgent) {
  const b = await getBrowser();
  const ua = userAgent || DESKTOP_UA;
  const existing = contexts.get(ua);
  if (existing) return existing;
  const ctx = await b.newContext({
    userAgent: ua,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  contexts.set(ua, ctx);
  ctx.on('close', () => contexts.delete(ua));
  return ctx;
}



/**
 * 渲染一个页面。
 *
 * @param {string} url
 * @param {{waitFor?: string, minCount?: number, capture?: string, timeoutMs?: number, userAgent?: string}} opts
 * @returns {Promise<{format:'html'|'json', html:string, captured:string[], status:number, contentType:string}>}
 */
export async function renderHtml(url, opts = {}) {
  const key = keyFor(url, opts);
  const cached = cacheGet(key);
  if (cached) return cached;

  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 20_000, 5_000), 120_000);
  scheduleIdleClose();

  if (openPages >= MAX_PAGES) {
    throw Object.assign(new Error(`渲染并发已满（${MAX_PAGES}）`), { code: 'BUSY' });
  }
  openPages++;
  /*
   * 拿到槽之后先自己兜一次：getContext / newPage 任一抛错（浏览器刚好被空闲
   * 关掉、context 建不出来）都必须把槽还回去。之前这两行落在下面的 try 外面，
   * 于是漏满 MAX_PAGES 次之后，所有 browser 模式的请求都在几十毫秒内回 429
   * 且根本不出网 —— 日志一行痕迹都没有，只有重启进程才恢复。
   */
  let page;
  try {
    page = await (await getContext(opts.userAgent)).newPage();
  } catch (e) {
    openPages--;
    throw e;
  }
  /*
   * 只有前台跑得好好的、部署实例里却拿不到内容时才知道需要这个：
   * 页面自己的 XHR/子资源失败、脚本报错，在服务会话里看不见 ——
   * 因为客户端只收到一份"渲染完但没数据"的 HTML。开了 ZENO_RENDER_DEBUG=1
   * 就把这些打到 stdout（计划任务的日志里）。
   */
  if (RENDER_DEBUG) {
    /** 发出去了但还没回来的请求 → 发出时刻。挂着的请求两边都不报错，只能这样抓 */
    page.__pending = new Map();
    page.on('request', (r) => {
      page.__pending.set(r.url(), Date.now());
      console.warn(`[zeno][render] → ${r.resourceType()} ${r.url().slice(0, 120)}`);
    });
    page.on('requestfinished', (r) => page.__pending.delete(r.url()));
    page.on('requestfailed', (r) => {
      page.__pending.delete(r.url());
      console.warn(`[zeno][render] 子资源失败 ${r.url().slice(0, 110)} ${r.failure()?.errorText ?? ''}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400) console.warn(`[zeno][render] HTTP ${r.status()} ${r.url().slice(0, 110)}`);
    });
    page.on('pageerror', (e) => console.warn(`[zeno][render] 页面报错 ${String(e).slice(0, 150)}`));
  }
  try {
    /** 必须在 goto 之前装：注入脚本要在站点的脚本跑到之前就把 JSON.parse 包住 */
    if (opts.capture) await page.addInitScript({ content: captureScript(opts.capture) });

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    /*
     * waitFor 是**提示**而不是硬要求：插件只有一份 fetch.waitFor，却要覆盖
     * 列表 / 详情 / 章节三种页面，后两者往往没有列表的那个选择器。
     * 当成必须条件就会白等满超时再报错，所以超时后直接用当前 DOM。
     */
    const settled = await waitUntilSettled(page, opts, timeoutMs);
    // 只有什么都没等到时才额外让 800ms。等到了内容再固定加 800ms 是纯开销 ——
    // 它会加在每一次渲染上。
    if (!settled && !opts.waitFor) await page.waitForTimeout(800).catch(() => {});

    // 捕获到期没中也要再读一次：可能刚好在最后一段等待时间里到位
    const captured = opts.capture ? await readCaptures(page) : [];

    /*
     * 整章地址已经从 JSON 里拿到就不再序列化 DOM —— 实测一次 page.content()
     * 在四万像素高的长章节页上要几百毫秒，而那份 HTML 我们一个字节都用不到。
     * 只有没抓到才回落取 HTML，让解析层还能按老路（parse.imageAttr）再试一次。
     */
    const html = captured.length ? '' : await page.content();

    /*
     * 抓空时把"发出去却永远没回来"的请求列出来。
     * 这类请求既不算失败也没有响应，两边都不会报错 —— 而服务会话里渲染
     * 不出内容就是这么一种表现：页面结构在、脚本没报错、数据永远不到。
     */
    if (page.__pending && !captured.length) {
      for (const [u, at] of page.__pending) {
        console.warn(`[zeno][render] 未返回 已等 ${Date.now() - at}ms ${u.slice(0, 120)}`);
      }
    }

    /*
     * 状态码：渲染模式下首次导航的响应经常没有意义。
     * 实测带 JS 质询的站点会先回一个 403 的质询页，浏览器执行完 JS 后自行
     * 重新加载并渲染出完整内容 —— 此时 resp.status() 仍是 403，透传给上层
     * 就会被当成失败丢掉（客户端 fetchText 见 !res.ok 直接抛）。
     * 所以判据换成"要等的东西出来了没有"：等到了就是 200。
     */
    let status = resp?.status() ?? 200;
    /*
     * 'idle'（"不再吐新内容了"）不算证据：一个停在质询页的站点同样很安静。
     * 所以它不走这条直接判 200 的路，只留给下面"页面确实有内容"那条兜底。
     */
    const gotIt =
      settled === 'capture' || settled === 'selector' || settled === 'load' || captured.length > 0;
    if (gotIt) status = 200;
    else if (status >= 400 && html.length > 2000) status = 200;

    const out = captured.length
      ? { format: 'json', html: '', captured, status, contentType: 'application/json; charset=utf-8' }
      : { format: 'html', html, captured: [], status, contentType: 'text/html; charset=utf-8' };

    /*
     * 判据没满足的结果不进缓存。之前只有"声明了 capture 却一条没抓到"被挡住
     * （那次实测：第一次 24s 没抓到，第二次 55ms 就"成功"返回同一份空壳 ——
     * 一次抖动被钉死，重试永远无效）。只声明 waitFor 的页是同一个坑：停在质询页的
     * 站点也会安静下来，'idle' 赢了就把那份壳缓存 90 秒，用户刷新几次拿到的都是它。
     */
    if (gotIt) cachePut(key, out);

    return out;
  } finally {
    openPages--;
    // 只关标签页，不关 context —— context 是全站共享的会话，关掉就等于
    // 把质询成果丢了，下一次请求又得从零再解一遍。
    await page.close().catch(() => {});
  }
}

/**
 * 当前占用的渲染槽。
 *
 * 这个数以前不可见，于是「槽漏光了」和「真的在忙」长得一模一样 —— 都是 429。
 * 挂到 /api/health 上，出问题时一眼分得开。
 */
export function renderLoad() {
  return { openPages, max: MAX_PAGES };
}

export async function shutdownBrowser() {  if (idleTimer) clearTimeout(idleTimer);
  await teardown();
}
