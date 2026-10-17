/**
 * 详情页：正文和「读到哪了」该一起来
 *
 * 用户报的是"割裂"：本地那份缓存让正文秒出，而进度环和「继续阅读」要等一会儿
 * 才凭空冒出来。根因是 `getShelfEntry`（IndexedDB，几毫秒）被捆在
 * `Promise.all` 里陪 `getComic`（一次服务端渲染，会话还在 0.8s、会话没了 8s+）等。
 *
 * 量的办法是把代理请求**人为按住 2.5 秒**，这样"等网络"那一截被放大成看得见的数：
 * 正文该在按住的那 2.5 秒之前就画好，按钮该紧跟着它，而不是等满 2.5 秒。
 *
 * 两条前提自己会验，不然这测试能假过：
 *  - 书架上真有"上次读到"，否则按钮根本不该出现，空窗量出来是 0；
 *  - 按住的那一跳真的发生过。踩过的坑：Service Worker 接管页面之后
 *    `page.route` 一个 /api/proxy 都拦不到（request 事件看得见），
 *    于是一路绿灯、数字全是假的 —— 所以这里把 SW 关掉，并把拦到的条数打出来。
 *
 * 跑法：node scripts/verify-detail-instant.mjs
 * 不进 npm test：CI 上没有浏览器也没有外网，只会假失败。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = 'baozimh';
const SLUG = 'woduzishengji-duburedicestudio';
/** 人为按住的那一段。正文必须在这之前出来，按钮不该等它 */
const HOLD_MS = 2500;
/** 正文到按钮之间允许的空窗。同一批渲染里就该一起画完 */
const MAX_GAP_MS = 400;

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const tmp = mkdtempSync(join(tmpdir(), 'zeno-instant-'));
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 'g.db'),
    ALLOWED_HOSTS: '',
    SYNC_TOKEN: '',
    DIST_DIR: join(ROOT, 'dist'),
  },
});
await new Promise((r) => setTimeout(r, 1500));

const plugin = JSON.parse(readFileSync(join(ROOT, 'baozimh-plugin.json'), 'utf8'));
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'instant',
    seq: 0,
    plugins: [
      { id: plugin.meta.id, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() },
    ],
  }),
});

const found = findBrowser();
if (!found) {
  console.error('本机没有 chromium 系浏览器');
  srv.kill('SIGTERM');
  process.exit(2);
}
const browser = await chromium.launch({ headless: true, executablePath: found.exe });
const ctx = await browser.newContext({
  /** SW 必须关掉，否则 page.route 拦不到 /api/proxy，按住那段等于没发生 */
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
const page = await ctx.newPage();

let hold = false;
const held = [];
await page.route('**/api/proxy**', async (route) => {
  if (hold) {
    held.push(new URL(route.request().url()).searchParams.get('url') ?? '');
    await new Promise((r) => setTimeout(r, HOLD_MS));
  }
  await route.continue();
});

const shelfEntry = () =>
  page.evaluate(
    (key) =>
      new Promise((res) => {
        const o = indexedDB.open('zeno-reader');
        o.onsuccess = () => {
          const q = o.result.transaction('shelf', 'readonly').objectStore('shelf').get(key);
          q.onsuccess = () => res(q.result ?? null);
        };
      }),
    `${PLUGIN}/${SLUG}`,
  );

const detail = () => `${BASE}/comic/${PLUGIN}/${SLUG}`;

console.log(`目标 ${BASE} ｜ 详情页按住 ${HOLD_MS}ms ｜ 允许空窗 ${MAX_GAP_MS}ms`);

/* ── 1. 环境：装源、入架、真的读一章（要有"上次读到"才量得出按钮） ── */
await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(
  (item) =>
    new Promise((res, rej) => {
      const o = indexedDB.open('zeno-reader');
      o.onerror = () => rej(o.error);
      o.onsuccess = () => {
        const tx = o.result.transaction('plugins', 'readwrite');
        tx.objectStore('plugins').put(item);
        tx.oncomplete = () => res(1);
        tx.onerror = () => rej(tx.error);
      };
    }),
  { id: plugin.meta.id, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
);

for (let i = 0; ; i++) {
  await page.goto(detail(), { waitUntil: 'domcontentloaded' });
  const ok = await page
    .waitForFunction(() => /加入书架|已在书架/.test(document.body.innerText), undefined, {
      timeout: 90_000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  if (ok) break;
  if (i >= 3) {
    console.error('详情页一直出不来（门神那关没过？），后面的数都别信');
    break;
  }
  await page.waitForTimeout(2000);
}
await page.locator('button', { hasText: '加入书架' }).first().click();
await page.waitForTimeout(800);

await page.goto(`${BASE}/read/${PLUGIN}/${SLUG}/0_111`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => {
    const el = document.querySelector('.reader__scroll');
    return !!el && el.scrollHeight - el.clientHeight > 2000;
  },
  undefined,
  { timeout: 120_000, polling: 500 },
);
/* 光打开不滚的话进度根本不落库，按钮不该出现，测试会假过 */
await page.evaluate(() => {
  const el = document.querySelector('.reader__scroll');
  el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.3;
});
await page.waitForTimeout(3000);
const seeded = await shelfEntry();
console.log(`\n=== 1. 底子`);
check(
  !!seeded?.lastChapterId,
  `有"上次读到"了：${seeded?.lastChapterId} · ${JSON.stringify(seeded?.positions ?? {})}（没有的话按钮本来就不出现，空窗量出来是 0）`,
);

/* ── 2. 第二遍（本地章节缓存已热）：正文该秒出，按钮该跟着它 ── */
console.log('\n=== 2. 带缓存再进一次，那一遍的详情页请求按住 2.5 秒');
hold = true;
const t0 = Date.now();
await page.goto(detail(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.querySelector('.detail'), undefined, {
  timeout: 60_000,
  polling: 50,
});
const tPaint = Date.now() - t0;
const hasBtn = await page
  .waitForFunction(() => document.body.innerText.includes('继续阅读'), undefined, {
    timeout: 30_000,
    polling: 50,
  })
  .then(() => true)
  .catch(() => false);
const tBtn = Date.now() - t0;
hold = false;

console.log(`  正文画好 ${tPaint}ms ｜ 「继续阅读」${hasBtn ? `出现在 ${tBtn}ms` : '30 秒内没出现'}`);
console.log(`  这一遍真的按住了 ${held.length} 个代理请求`);
check(
  held.length > 0,
  '按住那段真的发生过（SW 没关掉的话 route 一个请求都拦不到，数字全是假的）',
);
check(
  tPaint < HOLD_MS,
  `正文没等网络：${tPaint}ms < ${HOLD_MS}ms —— 等的是本地缓存那份章节表`,
);
check(hasBtn, '「继续阅读」出来了（没出来的话下面那条空窗无从谈起）');
check(
  hasBtn && tBtn - tPaint <= MAX_GAP_MS,
  `正文到按钮的空窗 ${tBtn - tPaint}ms ≤ ${MAX_GAP_MS}ms（捆在 Promise.all 里那版实测 2532ms）`,
);

await browser.close();
srv.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1200));
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  console.log(`  临时目录没删掉：${tmp}`);
}

console.log(fails === 0 ? '\n阅读信息和正文一起到齐' : `\n${fails} 条没过`);
process.exit(fails ? 1 : 0);
