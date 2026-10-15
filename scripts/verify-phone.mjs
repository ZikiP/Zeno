/**
 * 真机路径验证：用手机视口 + 手机 UA 打**已部署**的实例
 *
 * 存在的理由：服务端渲染用的是插件声明的头，不是设备的头。这件事只有在
 * 客户端真的以手机 UA 发请求时才能验 —— 本机直连探针永远测不到这一层。
 * 另外 Service Worker 只在安全上下文启用，所以要打 HTTPS 的那个地址。
 *
 * 用法：node scripts/verify-phone.mjs [base-url]
 *      默认 https://ziki-minipc.tail565ef2.ts.net
 * 只读为主：会打开一章并翻页，进度写入是应用本来就会做的事。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const BASE = process.argv[2] ?? 'https://ziki-minipc.tail565ef2.ts.net';
const SLUG = 'buxihuannverfanerxihuanmamawoma';
const CHAPTER = '46f6f7ce-f45c-11ea-8ec5-00163e0ca5bd';
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const found = findBrowser();
if (!found) {
  console.error('本机没有 chromium 系浏览器，无法模拟手机');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'zeno-phone-'));
const shots = join(tmp, 'shots');
mkdirSync(shots);
const errors = [];

const browser = await chromium.launch({
  headless: true,
  executablePath: found.exe,
  /*
   * ts.net 必须绕开系统代理：FlClash 会往注册表写系统代理，Chromium 跟着走了
   * 它就打不通 Tailscale 那条 TLS（实测 net::ERR_CONNECTION_ABORTED）。
   * TUN 是网卡级的透明劫持，不是 HTTP 代理 —— 浏览器要的是"直连"。
   */
  args: [
    '--proxy-bypass-list=*.ts.net',
    // Chromium 自己的异步解析器会绕开系统的 tailnet 名称解析，强制走系统解析
    '--disable-async-dns',
  ],
});
const ctx = await browser.newContext({
  userAgent: PHONE_UA,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
  ignoreHTTPSErrors: false,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 140)}`));

console.log(`目标：${BASE}（手机视口 390x844，UA = ${PHONE_UA.slice(11, 40)}…）`);

console.log('\n=== 1. 应用启动 + SW 注册');
const t0 = performance.now();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
const sw = await page
  .evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-api';
    const r = await navigator.serviceWorker.getRegistrations();
    return r.length ? `registered(${r.length})` : 'none';
  })
  .catch((e) => `查不到：${e.message}`);
check(sw.startsWith('registered'), `Service Worker ${sw} —— HTTPS 下才生效，这条就是证据`);

console.log('\n=== 2. 首轮同步把拷貝漫畫拉到客户端');
const hasPlugin = await page
  .waitForFunction(
    async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('zeno-reader');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(new Error('库打不开'));
      });
      const rows = await new Promise((res) => {
        const q = d.transaction('plugins').objectStore('plugins').getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => res([]);
      });
      d.close();
      return rows.some((x) => x.id === 'copymanga');
    },
    null,
    { timeout: 60_000, polling: 500 },
  )
  .then(() => true)
  .catch(() => false);
check(hasPlugin, '插件已同步到设备（服务端装的，客户端不用手导）');

console.log('\n=== 3. 用手机的移动 UA 走一遍列表');
await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
await page
  .waitForFunction(() => document.querySelectorAll('.card').length > 0, null, {
    timeout: 90_000,
    polling: 500,
  })
  .catch(() => {});
const cardCount = await page.evaluate(() => document.querySelectorAll('.card').length);
check(cardCount > 0, `发现页出卡 ${cardCount} 张（服务端用的是插件声明的桌面 UA，不是你手机的）`);
await page.screenshot({ path: join(shots, 'explore.png') });

console.log('\n=== 4. 打开一章：要等到图真的画出来');
const t1 = performance.now();
await page.goto(`${BASE}/read/copymanga/${SLUG}/${CHAPTER}`, { waitUntil: 'domcontentloaded' });
const painted = await page
  .waitForFunction(
    () => {
      const img = [...document.querySelectorAll('img')].find((i) => i.complete && i.naturalWidth > 400);
      return !!img;
    },
    null,
    { timeout: 120_000, polling: 200 },
  )
  .then(() => true)
  .catch(() => false);
const openMs = Math.round(performance.now() - t1);
check(painted, `章节有真的图在屏上（${openMs}ms）`);
await page.screenshot({ path: join(shots, 'page-1.png') });

const paintedCount = await page.evaluate(
  () => [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 400).length,
);
console.log(`     屏内已解码图片 ${paintedCount} 张`);

console.log('\n=== 5. 翻页：不能出现"舞台上没有任何图"的那一帧');
const frames = [];
for (let i = 0; i < 8; i++) {
  const n = await page.evaluate(
    () => [...document.querySelectorAll('img')].filter((x) => x.complete && x.naturalWidth > 400).length,
  );
  frames.push(n);
  await page.waitForTimeout(220);
}
check(
  frames.every((n) => n > 0),
  `连续 ${frames.length} 次采样都有图在场（${frames.join(' ')}）`,
);

console.log('\n=== 6. 控制台');
check(errors.length === 0, `设备端没有报错${errors.length ? `：\n   - ${errors.slice(0, 6).join('\n   - ')}` : ''}`);
console.log(`\n截图：${shots}`);
if (process.env.KEEP_SHOTS === '1') {
  const { cpSync } = await import('node:fs');
  const out = resolve('phone-shots');
  mkdirSync(out, { recursive: true });
  for (const f of ['explore.png', 'page-1.png']) cpSync(join(shots, f), join(out, f));
  console.log(`已留档到 ${out}`);
}

await browser.close();
if (process.env.KEEP_SHOTS !== '1') rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails === 0 ? '全部通过 — 手机端体验可用' : `${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
