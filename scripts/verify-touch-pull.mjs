/**
 * 手机上「按住蓄力接下一章」到底哪里断了 —— 用真触摸事件走一遍
 *
 * 为什么要单独写：verify-autojump 用的是 page.mouse.wheel，那只验了滚轮那条路。
 * 手机上没有 wheel，全靠 touchstart/touchend + ReaderProgress 的 pointer 事件，
 * 两条路完全不是一个入口，滚轮绿了不代表手机上能用。
 *
 * 场景（每个都从 A 章重新开始）：
 *   1. 已经停在章末，手指按在正文区不动 → 蓄满跳章
 *   2. 已经停在章末，手指按在底部 44px 进度热区不动（顶栏开 / 关各一遍）
 *   2t. 顶栏开着，按「上拉接下一章」那行字本身 → 蓄满跳章
 *   3. 手指按着的时候才滚到章末，不松手继续按 → 蓄满跳章
 *      这条是 2026-10-26 修的 bug：蓄力只在 touchstart 时 armed 才起算，
 *      "一路拉到底、手不松" 这种最顺手的手势永远建不起拉力。
 *      不能用 touchMove 模拟滚动（CDP 的合成触摸不驱动滚动），
 *      所以在按着的时候直接改 scrollTop，状态机看到的是同一串事件。
 *
 * 跑法：node scripts/verify-touch-pull.mjs [1|2|2t|2h|3|all]
 * 不进 npm test：要外网、要浏览器。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = 'baozimh';
const SLUG = 'woduzishengji-duburedicestudio';
const A = '0_111';
const B = '0_112';
const RENDER_WAIT = 150_000;
const W = 390;
const H = 844;

const which = (process.argv[2] ?? 'all').split(',');

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('先 npm run build');
  process.exit(2);
}
const found = findBrowser();
if (!found) {
  console.error('本机没有 chromium 系浏览器');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'zeno-touchpull-'));
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 'tp.db'),
    /* 共用本机图片缓存：章节表都在里面，省掉上游抓取那几分钟 */
    ZENO_CACHE_DIR: join(ROOT, 'data', 'cache'),
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
    deviceId: 'touchpull',
    seq: 0,
    plugins: [
      { id: plugin.meta.id, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() },
    ],
  }),
});

const browser = await chromium.launch({
  headless: true,
  executablePath: found.exe,
  args: ['--proxy-bypass-list=*.ts.net;127.0.0.1;localhost'],
});
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: W, height: H },
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
const at = (x, y) => [{ x, y, radiusX: 6, radiusY: 6, force: 1 }];

const state = () =>
  page.evaluate(() => {
    const el = document.querySelector('.reader__scroll');
    if (!el) return null;
    const bar = document.querySelector('.reader__bar');
    const zone = document.querySelector('.reader__progress');
    return {
      top: Math.round(el.scrollTop),
      range: Math.round(el.scrollHeight - el.clientHeight),
      hint: document.querySelector('.reader__end')?.textContent?.trim() ?? null,
      bar: bar ? !bar.classList.contains('hide') : null,
      zoneAction: zone ? getComputedStyle(zone).touchAction : null,
      url: location.pathname,
    };
  });

async function installPlugin() {
  await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1200);
  await page.evaluate(
    (item) =>
      new Promise((res, rej) => {
        const o = indexedDB.open('zeno-reader');
        o.onerror = () => rej(o.error);
        o.onsuccess = () => {
          const d = o.result;
          const tx = d.transaction('plugins', 'readwrite');
          tx.objectStore('plugins').put(item);
          tx.oncomplete = () => res(1);
          tx.onerror = () => rej(tx.error);
        };
      }),
    { id: plugin.meta.id, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
  );
}

const url = (id) => `${BASE}/read/${PLUGIN}/${SLUG}/${id}?n=${B}`;

async function openChapter(id) {
  for (let i = 0; i < 6; i++) {
    await page.goto(url(id), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.reader__scroll');
          return !!el && el.scrollHeight - el.clientHeight > 2000;
        },
        undefined,
        { timeout: RENDER_WAIT, polling: 300 },
      );
      return;
    } catch {
      await page.waitForTimeout(1500);
    }
  }
  throw new Error(`章节 ${id} 打不开`);
}

/** 一边贴底一边等章末提示，懒加载会把"假底部"往上顶 */
async function parkAtEnd() {
  let last = '(不在)';
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('.reader__scroll');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
    const s = await state();
    last = s?.hint ?? '(不在)';
    if (last === '上拉接下一章') return s;
  }
  throw new Error(`章末提示一直是「${last}」`);
}

async function shot(name) {
  const file = join(tmp, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  截图 ${file}`);
}

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};
const want = (n) => which.includes('all') || which.includes(String(n));

/* ── 环境 ── */
await installPlugin();
await page.evaluate((prefs) => {
  localStorage.setItem('readerPrefs', JSON.stringify({ ...prefs, __at: Date.now() }));
}, { autoNextChapter: true, pullMs: 1500, keepAwake: true, immersive: false, mode: 'scroll' });

/* 详情页要打上游，上游偶尔弹质询 —— 这一条只验手势，前后章直接从 URL 兜底给 */

/* ── 1. 停在章末，按正文区不动 ── */
if (want(1)) {
  console.log('\n=== 1. 章末 + 按正文区 2 秒');
  await openChapter(A);
  const s = await parkAtEnd();
  console.log(`  贴底 ${s.top}/${s.range}，提示「${s.hint}」`);
  await touch('touchStart', at(W / 2, 500));
  await page.waitForTimeout(1000);
  await shot('hold-body-1s');
  await page.waitForTimeout(900);
  const held = await state();
  console.log(`  按住 1.9s 后：${held ? `提示「${held.hint}」` : '已在换章'}，地址 …/${page.url().split('/').pop().split('?')[0]}`);
  await touch('touchEnd', []);
  await page.waitForTimeout(1500);
  check(page.url().includes(`/${B}`), `松手后停在 B 章（当前 …/${page.url().split('/').pop().split('?')[0]}）`);
}

/* ── 2. 停在章末，按底部进度热区不动 ── */
if (want(2)) {
  console.log('\n=== 2. 章末 + 按底部 44px 热区 2 秒（顶部菜单展开）');
  await openChapter(A);
  const s = await parkAtEnd();
  console.log(`  贴底 ${s.top}/${s.range}，提示「${s.hint}」，顶栏展开=${s.bar}，热区动作=${s.zoneAction}`);
  const box = await page.evaluate(() => {
    const el = document.querySelector('.reader__progress');
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  console.log(`  热区 ${JSON.stringify(box)}`);
  await touch('touchStart', at(W / 2, Math.round(box.top + (box.bottom - box.top) / 2)));
  await page.waitForTimeout(2000);
  await shot('hold-zone-2s');
  await touch('touchEnd', []);
  await page.waitForTimeout(1500);
  check(page.url().includes(`/${B}`), `松手后停在 B 章（当前 …/${page.url().split('/').pop().split('?')[0]}）`);
}

/* ── 2t. 顶栏展开时，按在提示文字正中间 ── */
if (want(2)) {
  console.log('\n=== 2t. 顶栏展开，按「上拉接下一章」这行字本身 2 秒');
  await openChapter(A);
  await parkAtEnd();
  const t = await page.evaluate(() => {
    const span = document.querySelector('.reader__end--go span');
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
  });
  console.log(`  文字中心 (${Math.round(t.x)}, ${Math.round(t.y)})，纵向 ${Math.round(t.top)}–${Math.round(t.bottom)}`);
  await touch('touchStart', at(Math.round(t.x), Math.round(t.y)));
  await page.waitForTimeout(2000);
  await shot('hold-on-text');
  await touch('touchEnd', []);
  await page.waitForTimeout(1500);
  check(page.url().includes(`/${B}`), `松手后停在 B 章（当前 …/${page.url().split('/').pop().split('?')[0]}）`);
}

/* ── 2h. 先点一下收起顶栏，再按底部热区 ── */
if (want(2)) {
  console.log('\n=== 2h. 点一下收起顶栏，再按底部热区 2 秒');
  await openChapter(A);
  await parkAtEnd();
  await page.mouse.click(W / 2, 300);
  await page.waitForTimeout(500);
  const s = await state();
  console.log(`  顶栏展开=${s.bar}，热区动作=${s.zoneAction}，提示「${s.hint}」`);
  await touch('touchStart', at(W / 2, H - 12));
  await page.waitForTimeout(2000);
  await shot('hold-zone-hidden-bar');
  await touch('touchEnd', []);
  await page.waitForTimeout(1500);
  check(page.url().includes(`/${B}`), `松手后停在 B 章（当前 …/${page.url().split('/').pop().split('?')[0]}）`);
}

/* ── 3. 手指按住不放，滚动在这一下里到达章末 ── */
if (want(3)) {
  console.log('\n=== 3. 手指按着时滚到章末（不松手），继续按 2 秒');
  await openChapter(A);
  await page.evaluate(() => {
    const el = document.querySelector('.reader__scroll');
    el.scrollTop = el.scrollHeight - el.clientHeight - 500;
  });
  await page.waitForTimeout(400);
  const s0 = await state();
  console.log(`  起点 ${s0.top}/${s0.range}，提示「${s0.hint}」`);
  await touch('touchStart', at(W / 2, 400));
  await page.waitForTimeout(150);
  /* 这一下滚动发生在手指还按着的时候 —— 与"一路拖到底"在状态机上等价 */
  await page.evaluate(() => {
    const el = document.querySelector('.reader__scroll');
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
  const mid = await state();
  console.log(`  滚到章末 ${mid.top}/${mid.range}，提示「${mid.hint}」`);
  await page.waitForTimeout(2000);
  await shot('hold-arrive-while-down');
  await touch('touchEnd', []);
  await page.waitForTimeout(1500);
  check(page.url().includes(`/${B}`), `按满之后停在 B 章（当前 …/${page.url().split('/').pop().split('?')[0]}）`);
}

await browser.close();
srv.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1200));
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  console.log(`  临时目录留着看截图：${tmp}`);
}
console.log(fails === 0 ? '\n全部通过' : `\n${fails} 条没过`);
process.exit(fails ? 1 : 0);
