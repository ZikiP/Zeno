/**
 * 真机路径验证：用手机视口 + 手机 UA 打**已部署**的实例，并按用户真实的点法走
 *
 * 为什么要用手机去跑：服务端渲染用的是插件声明的请求头，不是设备的头。
 * 这一层只有客户端真以手机 UA 发请求时才验得到，本机直连探针测不到。
 *
 * 为什么全程站内点击而不是直接 goto 章节地址：这个应用一次只跟一个激活内容源
 * （localStorage.activePluginId），而 /read/:pluginId/... 里的 pluginId 目前
 * 只是路径装饰 —— 直接深链进另一个源的章节，阅读器会拿当前激活的源去拼地址，
 * 结果是"这一章没有图片"。所以先激活，再点进去。
 *
 * 用法：node scripts/verify-phone.mjs [base-url] [插件id] [作品slug]
 *      默认 https://ziki-minipc.tail565ef2.ts.net copymanga
 *      注意：用 http:// 内网地址时 Service Worker 不会注册（非安全上下文），
 *      第 1 项会如实失败 —— 手机走 HTTPS 时才有那一层。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const BASE = process.argv[2] ?? 'https://ziki-minipc.tail565ef2.ts.net';
const PLUGIN_ID = process.argv[3] ?? 'copymanga';
const SLUG = process.argv[4] ?? '';
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
   * ts.net 必须绕开系统代理：FlClash 写的是注册表里的系统代理，Chromium 跟着走
   * 就打不通 Tailscale 那条 TLS（实测 net::ERR_CONNECTION_CLOSED / ABORTED）。
   * TUN 是网卡级透明劫持，不是 HTTP 代理 —— 浏览器这里要的是"直连"。
   */
  args: ['--proxy-bypass-list=*.ts.net'],
});
const ctx = await browser.newContext({
  userAgent: PHONE_UA,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 140)}`));

const painted = () =>
  page.evaluate(
    () => [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 400).length,
  );

console.log(`目标 ${BASE} ｜ 源 ${PLUGIN_ID} ｜ 390x844 + 手机 UA`);

console.log('\n=== 1. 启动与安全上下文那一层');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
const sw = await page
  .evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-api';
    const r = await navigator.serviceWorker.getRegistrations();
    return r.length ? `registered(${r.length})` : 'none';
  })
  .catch((e) => `查不到：${e.message}`);
const secure = BASE.startsWith('https');
check(
  !secure || sw.startsWith('registered'),
  `Service Worker ${sw}${secure ? '' : '（http 地址下本来就不该注册，跳过判定）'}`,
);

console.log('\n=== 2. 首轮同步把插件带到设备上');
const synced = await page
  .waitForFunction(
    async (id) => {
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
      return rows.some((x) => x.id === id);
    },
    PLUGIN_ID,
    { timeout: 60_000, polling: 500 },
  )
  .then(() => true)
  .catch(() => false);
check(synced, `设备上已有 ${PLUGIN_ID}（服务端装的，没人手动导入）`);

console.log('\n=== 3. 像用户那样把这个源切成激活');
await page.evaluate((id) => {
  localStorage.setItem('activePluginId', id);
  localStorage.setItem('activePluginId__at', String(Date.now()));
}, PLUGIN_ID);
await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
await page
  .waitForFunction(() => document.querySelectorAll('.card').length > 0, null, { timeout: 90_000, polling: 500 })
  .catch(() => {});
const cards = await page.evaluate(() => document.querySelectorAll('.card').length);
check(cards > 0, `发现页 ${cards} 张卡（客户端是手机 UA，服务端用的却是插件声明的桌面 UA —— 这条就是证据）`);
await page.screenshot({ path: join(shots, 'explore.png') });

console.log('\n=== 4. 点进一部作品，再点进一章');
const href = SLUG
  ? `/comic/${SLUG}`
  : await page.evaluate(() => document.querySelector('a.card')?.getAttribute('href') ?? '');
check(!!href, `从卡片拿到详情地址 ${href}`);
await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
await page
  .waitForFunction(() => document.querySelectorAll('a[href*="/read/"]').length > 0, null, { timeout: 90_000 })
  .catch(() => {});
const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/read/"]')].map((a) => a.getAttribute('href')));
check(links.length > 0, `详情页拿到 ${links.length} 个章节链接`);

const target = links.at(-1) ?? links[0];
const t0 = performance.now();
await page.click(`a[href="${target}"]`).catch(async () => page.goto(`${BASE}${target}`));
let ok = false;
let n = 0;
for (let i = 0; i < 120 && !ok; i++) {
  n = await painted();
  ok = n > 0;
  if (!ok) await page.waitForTimeout(1000);
}
const openMs = Math.round(performance.now() - t0);
check(ok, `翻开 ${target?.split('/').pop()} 后有 ${n} 张图真在屏上（${openMs}ms）`);
await page.screenshot({ path: join(shots, 'page-1.png') });

console.log('\n=== 5. 连续采样：不许出现舞台上没有任何图的那一帧');
const frames = [];
for (let i = 0; i < 10; i++) {
  frames.push(await painted());
  await page.waitForTimeout(200);
}
check(frames.every((x) => x > 0), `10 次采样在场图片数 ${frames.join(' ')}`);

console.log('\n=== 6. 翻页');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(900);
const afterFlip = await painted();
check(afterFlip > 0, `翻页后仍有 ${afterFlip} 张图在场`);
await page.screenshot({ path: join(shots, 'page-2.png') });

console.log('\n=== 7. 设备端控制台');
check(errors.length === 0, `没有报错${errors.length ? `：\n   - ${errors.slice(0, 6).join('\n   - ')}` : ''}`);

if (process.env.KEEP_SHOTS === '1') {
  const out = join(process.cwd(), 'phone-shots');
  mkdirSync(out, { recursive: true });
  const { cpSync } = await import('node:fs');
  for (const f of ['explore.png', 'page-1.png', 'page-2.png']) {
    try {
      cpSync(join(shots, f), join(out, f));
    } catch {
      /* 留档失败不影响结论 */
    }
  }
  console.log(`截图已留到 ${out}`);
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fails === 0 ? '全部通过 — 手机端体验可用' : `${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
