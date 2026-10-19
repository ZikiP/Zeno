/**
 * 量「已缓存的章节 + 开着画面增强」读起来的真实等待：首开、翻页追不上、换章、重开
 *
 * 和 verify-enhance-local.mjs 的分工：那边用合成源量「换图那一下有没有闪」，
 * 这一份用真源量「用户等多久才看到像素」。要在增强真会触发的那一档跑：
 * 源图 1200 宽，所以显示宽 × dpr 要 > 1200 才走增强 —— 1440 桌面档，或
 * 390×844@3 之外的窄屏高 dpr 档。窄屏低 dpr（390@1）不触发，量出来全是假阴性。
 *
 * 跑法：node scripts/verify-enhance-warm.mjs
 * 依赖：本机 chromium 系浏览器；ZENO_BASE 指向一个已经缓存过该章的实例。
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = process.env.ZENO_BASE || 'http://127.0.0.1:5178';
const PLUGIN_FILE = process.env.ZENO_PLUGIN_FILE || 'baozimh-plugin.json';
const PLUGIN = process.env.ZENO_PLUGIN || 'baozimh';
const SLUG = process.env.ZENO_SLUG || 'wodetudidushidafanpai-yuetian';
const CH = process.env.ZENO_CHAPTER || '0_389';
const NEXT_CH = process.env.ZENO_NEXT_CHAPTER || '0_388';
const W = Number(process.env.ZENO_W || 1440);
const H = Number(process.env.ZENO_H || 900);
const DPR = Number(process.env.ZENO_DPR || 1);
/** 一页停多久：正常人滑动翻页大概 1~2 秒 */
const TURN_MS = Number(process.env.ZENO_TURN_MS || 1200);
const TURNS = Number(process.env.ZENO_TURNS || 12);
/** 分页或滚动：滚动模式整章一起挂上，门控代价的样子完全不同 */
const MODE = process.env.ZENO_MODE || 'paged';
/** CPU 降速倍数，模拟手机/低功耗主机（1=不降） */
const CPU = Number(process.env.ZENO_CPU || 1);

const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器');
  process.exit(2);
}
const plugin = JSON.parse(readFileSync(join(ROOT, PLUGIN_FILE), 'utf8'));

const INIT = `(() => {
  try { localStorage.setItem('readerEnhance', '1'); } catch (e) {}
  const T = { t0: performance.now(), workers: 0, posted: 0, errs: [], puts: 0, matches: 0, fetches: 0, fetchBytes: 0, turn: [], log: [] };
  const rel = () => Math.round(performance.now() - T.t0);
  const note = (k, extra) => { if (T.log.length < 400) T.log.push([rel(), k, extra ?? '']); };
  const RealWorker = window.Worker;
  window.Worker = function (...a) { T.workers++; return new RealWorker(...a); };
  window.Worker.prototype = RealWorker.prototype;
  const realPost = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...a) { T.posted++; note('dispatch'); return realPost.apply(this, a); };
  const realFetch = window.fetch;
  window.fetch = async function (u, o) {
    const r = await realFetch(u, o);
    if (String(u).includes('/api/proxy')) {
      T.fetches++;
      try { T.fetchBytes += (r.headers.get('content-length') | 0); } catch (e) {}
      const cl = (r.headers.get('content-length') | 0);
      if (cl > 30000) note('bytes', (cl / 1024 | 0) + 'KB');
    }
    return r;
  };
  /** 主线程被占住的每一段：>50ms 的长任务就是"页面无响应"的那段时间 */
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) note('longtask', Math.round(e.duration) + 'ms'); }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  /** 每张结果落地（内存里出现一个 blob 地址）记一次：这是"这一页可以画了"的时刻 */
  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { if (b && b.type === 'image/png') note('result', (b.size / 1024 | 0) + 'KB'); return realCreate(b); };
  window.addEventListener('error', (e) => T.errs.push(String(e.message).slice(0, 100)));
  window.addEventListener('unhandledrejection', (e) => T.errs.push('reject:' + String(e.reason).slice(0, 100)));
  window.__reset = () => { T.t0 = performance.now(); T.workers = 0; T.posted = 0; T.errs = []; T.log = []; };
  const onScreen = () => [...document.images].filter((i) => {
      const c = i.closest('.reader__spread') || i;
      const r = c.getBoundingClientRect();
      return r.width > 20 && r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0
        && getComputedStyle(c).visibility !== 'hidden';
    });
  window.__snap = () => ({
    now: rel(), workers: T.workers, posted: T.posted, errs: T.errs.slice(-3),
    puts: T.puts, matches: T.matches, fetches: T.fetches, fetchBytes: T.fetchBytes, log: T.log.slice(),
    n: onScreen().length,
    imgs: onScreen().map((i) => ({ blob: (i.src || '').startsWith('blob:'), shown: Math.round(i.offsetWidth), nat: i.naturalWidth, op: getComputedStyle(i).opacity })),
  });
  /** 数盘上这一层的读写：Cache.put / Cache.match 是被谁按住的 */
  const wrap = (proto) => {
    if (!proto) return;
    const put = proto.put, match = proto.match;
    proto.put = function (...a) { T.puts++; return put.apply(this, a); };
    proto.match = function (...a) { T.matches++; return match.apply(this, a); };
  };
  if (window.Cache) wrap(Cache.prototype);
  /** 每帧记一次屏幕上"该有图但被按住"的时长 */
  let painted = false;
  const frame = () => {
    const on = onScreen();
    if (!painted && on.length && on.some((i) => i.op === '1' && i.nat > 0)) { painted = true; note('paint', 'blob=' + on.some((i) => (i.src || '').startsWith('blob:'))); }
    /** 屏内第一张的完整状态，去重后记下来：看得出卡在哪一环（没挂上 src？没解码？被按住不画？） */
    if (on.length) {
      const i = on[0];
      const c = i.closest('.reader__spread') || i.parentElement;
      const st = [
        (i.src || '').startsWith('blob:') ? 'ENH' : (i.src || '').startsWith('data:') ? 'DATA' : 'ORIG',
        'complete=' + i.complete, 'nat=' + i.naturalWidth,
        'op=' + getComputedStyle(i).opacity, 'loading=' + (i.getAttribute('loading') || '-'),
        'w=' + Math.round(i.getBoundingClientRect().width),
        'disp=' + getComputedStyle(i).display, 'vis=' + getComputedStyle(c || i).visibility,
      ].join(' ');
      if (st !== T.lastState) { T.lastState = st; note('state', st); }
    }
    const blank = on.length && on.every((i) => i.op !== '1' || !i.nat);
    T.blankFrame = blank;
    (T.blanks = T.blanks || []).push([rel(), blank ? 1 : 0]);
    if (T.blanks.length > 20000) T.blanks.shift();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__blanks = () => T.blanks.slice();
})();`;

const tmp = mkdtempSync(join(tmpdir(), 'zeno-warm-'));
const browser = await chromium.launch({ headless: true, executablePath: found.exe });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, locale: 'zh-CN' });
await ctx.addInitScript(INIT);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 120)}`));

const snap = () => page.evaluate(() => window.__snap());
const disk = () => page.evaluate(async () => (await (await caches.open('zeno-enhanced')).keys()).length);

/** 屏幕上有像素为止；顺带返回这一段时间里"全黑"的帧数 */
async function waitPainted(ms) {
  const t0 = Date.now();
  for (;;) {
    const s = await snap();
    const on = s.imgs.filter((i) => i.op === '1' && i.nat > 0);
    if (on.length) return { at: Date.now() - t0, blob: on.every((i) => i.blob), s };
    if (Date.now() - t0 > ms) return { at: null, blob: false, s };
    await page.waitForTimeout(30);
  }
}

const chapterUrl = (id) => `${BASE}/read/${PLUGIN}/${SLUG}/${id}`;

/* ── 准备：新 profile，装插件、切分页模式 ── */
await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(1000);
await page.evaluate(
  (item) =>
    new Promise((res, rej) => {
      const o = indexedDB.open('zeno-reader');
      o.onerror = () => rej(o.error);
      o.onsuccess = () => {
        const d = o.result;
        if (!d.objectStoreNames.contains('plugins')) return rej(new Error('没有 plugins 表'));
        const tx = d.transaction('plugins', 'readwrite');
        tx.objectStore('plugins').put(item);
        tx.oncomplete = () => res(1);
        tx.onerror = () => rej(tx.error);
      };
    }),
  { id: PLUGIN, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
);
await page.evaluate((m) => localStorage.setItem('readerMode', m), MODE);
if (CPU > 1) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  console.log(`（CPU 降速 ${CPU}x，模式 ${MODE}）`);
}

async function openChapter(id, label) {
  await page.evaluate(() => window.__reset());
  await page.goto(chapterUrl(id), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('.reader__cell img, .reader__page', { timeout: 120_000, state: 'attached' }).catch(() => {});
  const r = await waitPainted(90_000);
  const s = await snap();
  console.log(
    `\n=== ${label}（${id}）===\n` +
      `  进章后第一张有像素：${r.at === null ? '>90s' : `${r.at}ms`}（${r.blob ? '增强版' : '原图'}）\n` +
      `  发活 ${s.posted} 次 / Worker ${s.workers} 台 / 取原图字节 ${s.fetches} 次、${Math.round(s.fetchBytes / 1048576)}MB / 盘上写 ${s.puts} 次、读 ${s.matches} 次`,
  );
  const lg = r.s?.log || [];
  const first = (k) => lg.find((x) => x[1] === k);
  const longs = lg.filter((x) => x[1] === 'longtask');
  const sum = (a) => a.reduce((t, x) => t + parseInt(x[2], 10), 0);
  console.log(
    `  时间线：首字节 ${first('bytes') ? first('bytes')[0] + 'ms' : '-'} → 首派活 ${first('dispatch') ? first('dispatch')[0] + 'ms' : '-'} → 首结果 ${first('result') ? first('result')[0] + 'ms' : '-'} → 挂上增强 src ${first('tosrc-enh') ? first('tosrc-enh')[0] + 'ms' : '-'} → 屏上有像素 ${first('paint') ? first('paint')[0] + 'ms' : r.at + 'ms'}\n` +
      `  主线程长任务 ${longs.length} 段、共 ${sum(longs)}ms（最长 ${Math.max(0, ...longs.map((x) => parseInt(x[2], 10)))}ms）\n` +
      `  状态变化：${JSON.stringify(lg.filter((x) => x[1] === 'state').slice(0, 12))}`,
  );
  return r;
}

async function turnPages(n, gap) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => window.__reset());
    const before = await snap();
    await page.evaluate(() => document.querySelector('.paged-tap--r')?.click());
    const r = await waitPainted(20_000);
    const after = await snap();
    rows.push(r.at);
    console.log(
      `  第 ${String(i + 1).padStart(2)} 下：黑 ${r.at === null ? '>20s' : `${String(r.at).padStart(5)}ms`}` +
        `${r.blob ? ' 增强' : ' 原图'}  发活 ${before.posted}→${after.posted} 读盘 ${after.matches - before.matches} 写盘 ${after.puts - before.puts} 取字节 ${after.fetches - before.fetches}`,
    );
    await page.waitForTimeout(Math.max(0, gap - (r.at ?? gap)));
  }
  const sorted = rows.filter((x) => x !== null).sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  console.log(
    `  → 翻页等待：中位 ${p(0.5)}ms、90 分位 ${p(0.9)}ms、最长 ${sorted.at(-1)}ms、>300ms 的 ${sorted.filter((x) => x > 300).length} 次 / ${n} 次`,
  );
  return rows;
}

/* ① 冷开一章 + 立刻按正常速度连翻 */
await openChapter(CH, '① 第一次开（浏览器侧全空）');
await turnPages(TURNS, TURN_MS);

/*
 * 跳深：连点 20 页跳到没算过的位置，停一下让翻页动画走完，再翻一页看要黑多久。
 * 这一档专门盯优先级 —— 章级预排的 prio 是"离章头多远"，脚下那一页不插队的话，
 * 跳到第 20 页就得等前面十几张算完（实测修之前 6.5 秒）。
 */
async function deepJump(pages) {
  await page.evaluate((n) => { for (let i = 0; i < n; i++) document.querySelector('.paged-tap--r')?.click(); }, pages);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__reset());
  const before = await snap();
  await page.evaluate(() => document.querySelector('.paged-tap--r')?.click());
  const r = await waitPainted(30_000);
  console.log(`  跳到第 ${pages + 1} 页后再翻一页：黑 ${r.at === null ? '>30s' : r.at + 'ms'}（此刻发活 ${before.posted}、盘上 ${await disk()} 条）`);
}
await deepJump(20);

/* ② 换到下一章：服务端字节早就缓存好了，但浏览器侧这一章一张增强版都没有 */
await openChapter(NEXT_CH, '② 换下一章（原图已缓存，增强版全新）');
await turnPages(8, TURN_MS);

/* ③ 回到第一章：盘上已经有了，重开该是纯读盘 */
const d0 = await disk();
await openChapter(CH, `③ 重开已增强过的那章（盘上 ${d0} 条）`);
await turnPages(6, 900);

await page.screenshot({ path: join(ROOT, 'dist/enhance-warm.png'), clip: { x: 0, y: 0, width: W, height: Math.min(H, 700) } });
console.log(`\n盘上条目 ${await disk()}；截图 dist/enhance-warm.png；报错 ${JSON.stringify(errors.slice(0, 5))}`);

await browser.close();
try {
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.log(`(临时目录没删：${tmp})`);
}
