/**
 * 阅读器的取数与预热实测（真浏览器、手机视口、真站点）
 *
 * 要验的是"读起来卡不卡"这类只有跑起来才看得见的东西：
 *   - 打开一章要多久、第一张图多久能画出来
 *   - 读着的时候有没有把下一话的地址表先取回来（预热）
 *   - 预热有没有失控（把整本书都预取了一遍）
 *   - 重读同一章是不是直接命中缓存
 *
 * 跑法：node scripts/verify-prefetch.mjs
 * 依赖：本机 chromium 系浏览器 + 能上网 + dist/ 已经构建过。
 * 不进 npm test：CI 上两样都没有，只会假失败。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.VERIFY_PORT || 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN_PATH = resolve(ROOT, '../zeno-plugins/plugins/copymanga.json');
const SLUG = 'buxihuannverfanerxihuanmamawoma';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

if (!existsSync(PLUGIN_PATH)) {
  console.error(`找不到插件 ${PLUGIN_PATH}`);
  process.exit(2);
}
const plugin = JSON.parse(readFileSync(PLUGIN_PATH, 'utf8'));
const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'zeno-prefetch-'));
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 'p.db'),
    ALLOWED_HOSTS: '',
    SYNC_TOKEN: '',
    DIST_DIR: join(ROOT, 'dist'),
  },
});
const stop = () => {
  srv.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄可能还没放掉 */
  }
};

for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 150));
}
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'prefetch',
    seq: 0,
    plugins: [{ id: plugin.meta.id, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() }],
  }),
});

const errors = [];
const ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  executablePath: found.exe,
  headless: true,
  viewport: { width: 390, height: 844 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 160)}`));

/** 读客户端 IndexedDB：缓存了哪些章、每章几张图 */
const readCache = (store) =>
  page.evaluate(async (name) => {
    const d = await new Promise((res, rej) => {
      const r = indexedDB.open('zeno-reader');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise((res) => {
      const q = d.transaction(name, 'readonly').objectStore(name).getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => res([]);
    });
    d.close();
    return rows;
  }, store);

console.log('\n=== 1. 首轮同步把插件拉到客户端，详情页拿到章节表');
await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card', { timeout: 90_000 }).catch(() => {});
await page.goto(`${BASE}/comic/${SLUG}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('[class*=chapter], a').length > 20, null, { timeout: 90_000 });
const lists = await readCache('chapterCache');
const book = lists.find((r) => r.slug === SLUG);
check(!!book?.chapters?.length, `章节表缓存了 ${book?.chapters?.length ?? 0} 条`);
const ids = (book?.chapters ?? []).map((c) => c.id);

/*
 * 章节列表在界面上是会折叠的（一百多话不会全挂出来），所以"要点哪一章"
 * 只能问 DOM，不能拿数组下标猜：先取缓存里的升序 id，再和页面上真的存在的
 * 那些求交集，挑一个"后面还有下一章"的当下第一章。
 */
const domIds = await page.$$eval('a[href*="/read/"]', (els) =>
  els.map((e) => (e.getAttribute('href') || '').split('?')[0].split('/').pop()),
);
const present = new Set(domIds);
let first = null;
let second = null;
for (let i = 0; i < ids.length - 1; i++) {
  if (present.has(ids[i])) {
    first = ids[i];
    second = ids[i + 1];
    break;
  }
}
check(!!first && !!second, `页面上可点的第一话 ${first}，它的下一话 ${second}（DOM 里共 ${domIds.length} 个章节链接）`);

console.log('\n=== 2. 从详情页点进第一话：真人路径要多久');
/*
 * 这里全程走站内点击，不用 page.goto：goto 是整页重开，会把应用启动、
 * 首轮同步这些跟"阅读"无关的时间一起算进来，测出来的数没法解释。
 */
const clickChapter = async (cid) => {
  const t = performance.now();
  const clicked = await page
    .evaluate((id) => {
      const a = [...document.querySelectorAll('a')].find((x) => (x.getAttribute('href') || '').includes(id));
      if (!a) return false;
      a.click();
      return true;
    }, cid)
    .catch(() => false);
  if (!clicked) return null;
  const ok = await page
    .waitForFunction(
      () => {
        const i = document.querySelector('main img, img');
        return !!i && i.complete && i.naturalWidth > 0;
      },
      null,
      { timeout: 90_000, polling: 100 },
    )
    .then(() => true)
    .catch(() => false);
  return Math.round(performance.now() - t);
};

const openFirst = await clickChapter(first);
check(openFirst !== null && openFirst > 0, `点进第一话并等到首图解码（${openFirst}ms，服务端渲染浏览器此时已热）`);

console.log('\n=== 3. 读着的时候，下一话的地址表应当自己到位');
const warmed = await page
  .waitForFunction(
    async (key) => {
      const d = await new Promise((res) => {
        const r = indexedDB.open('zeno-reader');
        r.onsuccess = () => res(r.result);
      });
      const row = await new Promise((res) => {
        const q = d.transaction('chapters', 'readonly').objectStore('chapters').get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(null);
      });
      d.close();
      return !!row && (row.images?.length ?? 0) > 0;
    },
    `${plugin.meta.id}/${SLUG}/${second}`,
  )
  .then(() => true)
  .catch(() => false);
check(warmed, `第二话（${second}）的地址表已被预热出来 —— 不用点进去等渲染`);

const afterWarm = await readCache('chapters');
const mine = afterWarm.filter((r) => r.slug === SLUG);
check(mine.length <= 3, `预热只热了 ${mine.length} 章，没有把整本书拖下来`);
console.log(`     已缓存：${mine.map((r) => `${r.chapterId.slice(0, 8)}=${r.images?.length}张`).join(' ')}`);

console.log('\n=== 4. 点开已经被预热的那一章');
await page.goBack({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('a').length > 20, null, { timeout: 60_000 });
const openSecond = await clickChapter(second);
check(openSecond !== null, `点进第二话（它的地址表已经预热好了）用了 ${openSecond}ms`);
check(
  openSecond !== null && openSecond < (openFirst ?? Infinity),
  `比第一话快 ${(openFirst ?? 0) - (openSecond ?? 0)}ms —— 省掉的正是那一次服务端渲染`,
);

const afterReopen = await readCache('chapters');
const rows = afterReopen.filter((r) => r.slug === SLUG);
check(rows.length >= 2, `两章的地址表都在本地（${rows.length} 章）`);
/*
 * 这条是"翻开一章不该偷偷把整章几十张图下完"的回归点：
 * 一次实测 21 张 6.4 MB、174 张能到 50 MB，全都在阅读后台跑，
 * 抢的就是正在看的那几张图的带宽。整章下载只属于详情页那颗按钮。
 */
check(
  rows.every((r) => r.downloaded === false),
  `两章都只是地址表，没被下成整章离线（bytes=${rows.map((r) => r.bytes).join('/')}）`,
);

check(errors.length === 0, `浏览器没有报错${errors.length ? `：\n   - ${errors.slice(0, 5).join('\n   - ')}` : ''}`);

await ctx.close();
stop();
console.log(`\n${fails === 0 ? '全部通过 — 阅读与预热可用' : `${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
