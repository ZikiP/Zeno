/**
 * 浏览器端同步落库验证
 *
 * 服务端的 LWW 有 test-deletes 覆盖，但客户端 applyRemote 跑在 IndexedDB 的
 * **单个事务**里 —— 事务会不会中途自动提交、删除会不会把刚加回来的数据再抹掉，
 * 只有真浏览器能验，node 测试碰不到这一层。
 *
 * 依赖本机浏览器，所以不进 npm test（CI 上会假失败），手动跑：
 *   node scripts/verify-sync-e2e.mjs
 *
 * 临时 profile + 临时库，不会碰到正在使用的数据。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
/*
 * 基准时间取"一分钟前"而不是某个固定常量。
 * 客户端会把同步回来的墓碑按 deletedAt 做 90 天回收 —— 用 2023 年的固定值，
 * 落库的那一瞬间就被 pruneTombstones 当过期清掉了，看着像"墓碑没记上"。
 */
const T = Date.now() - 60_000;

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const tmp = mkdtempSync(join(tmpdir(), 'zeno-e2e-'));
const dbPath = join(tmp, 'e2e.db');
const profile = join(tmp, 'profile');
mkdirSync(profile);

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, ALLOWED_HOSTS: '', SYNC_TOKEN: '' },
});

function killServer() {
  try {
    srv.kill();
  } catch {
    /* 已经退了 */
  }
}
function rmTmp() {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 可能还没释放，留在临时目录里无所谓 */
  }
}
process.on('exit', () => {
  killServer();
  rmTmp();
});
async function done(code) {
  killServer();
  await new Promise((r) => setTimeout(r, 250));
  rmTmp();
  process.exit(code);
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务端起不来');
}

const PLUGIN = {
  format: 'zeno-plugin@1',
  meta: { id: 'e2e', name: 'E2E 源', icon: '🧪' },
  entry: BASE,
  chapterHost: BASE,
  urls: { search: '/s?q={q}', detail: '/c/{slug}', chapter: '/c/{slug}/{id}.html' },
  parse: { card: '<div class="c', slugFrom: 'href="/c/([^"?]+)"', title: { attr: 'title' } },
  imageHosts: ['127.0.0.1'],
  headers: {},
};
/* slug 里带 '/'，顺手把书架主键的边界情况也走一遍 */
const SHELF = { pluginId: 'e2e', slug: 'one/two', title: '端到端这本书', cover: '', addedAt: T, updatedAt: T };

const seed = (body) =>
  fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-ipad', seq: 0, ...body }),
  }).then((r) => r.json());

const shelfKey = 'e2e/one/two';
const bmKey = 'e2e/one/two/ch1/3';

let page;
/** 直接读页面里的 IndexedDB，不要求应用暴露任何调试接口 */
async function readLocal() {
  return page.evaluate(async (keys) => {
    const open = await new Promise((res, rej) => {
      const rq = indexedDB.open('zeno-reader');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const tx = open.transaction(['shelf', 'bookmarks', 'plugins', 'tombstones'], 'readonly');
    const get = (store, key) =>
      new Promise((res) => {
        const rq = tx.objectStore(store).get(key);
        rq.onsuccess = () => res(rq.result);
      });
    const all = (store) =>
      new Promise((res) => {
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result);
      });
    const out = {
      shelf: await get('shelf', keys.shelf),
      bookmark: await get('bookmarks', keys.bm),
      plugins: await all('plugins'),
      tombstones: await all('tombstones'),
      theme: localStorage.getItem('themeMode'),
    };
    open.close();
    return out;
  }, { shelf: shelfKey, bm: bmKey });
}

/** 同步在页面加载时自动触发，等它把结果落库 */
async function waitFor(pred, ms = 25_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await readLocal();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

const reload = () => page.reload({ waitUntil: 'domcontentloaded' });

/**
 * 确认浏览器真的跑完了一轮同步。
 *
 * 只看"本地数据对不对"会有假通过：还没同步就已经是期望值了。
 * 服务端每次 pull 都会记下该设备的 last_seq，
 * 所以「这台设备的 last_seq 追上了我推送之后的 seq」才是同步发生过的证据。
 */
async function waitSyncRound() {
  const deviceId = await page.evaluate(() => localStorage.getItem('syncDeviceId') ?? '');
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const [{ clients }, { seq }] = await Promise.all([
      fetch(`${BASE}/api/sync/clients`).then((r) => r.json()),
      fetch(`${BASE}/api/health`).then((r) => r.json()),
    ]);
    const row = clients?.find((c) => c.device_id === deviceId);
    // 每轮同步是 push→pull，pull 会把该设备的 last_pulled_seq 写成服务端当前 seq。
    // 两者相等说明这台设备已经看到了服务端最新的状态。
    if (row && Number(row.last_pulled_seq ?? 0) >= seq) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

console.log('\n=== 0. 起服务端，先往服务端塞一批「平板」的数据 ===');
await waitUp();
const applied = await seed({
  plugins: [{ id: 'e2e', origin: 'imported', data: JSON.stringify(PLUGIN), updatedAt: T }],
  shelf: [SHELF],
  bookmarks: [{ key: bmKey, pluginId: 'e2e', slug: 'one/two', chapterId: 'ch1', page: 3, percent: 10, note: '这一段值得记', createdAt: T, updatedAt: T }],
  settings: [{ key: 'themeMode', value: '"dark"', updatedAt: T }],
});
console.log('  服务端接受：', JSON.stringify(applied.applied));

const found = findBrowser();
if (!found) {
  console.log('  [SKIP] 本机找不到 chromium 系浏览器');
  await done(0);
}
console.log(`  浏览器：${found.from} ${found.exe}`);

const errors = [];
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: found.exe,
  headless: true,
});
page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

console.log('\n=== 1. 手机首次加载，远端数据应落进 IndexedDB ===');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const s1 = await waitFor((x) => !!x.shelf);
check(!!s1.shelf, `书架条目落库${s1.shelf ? `（${s1.shelf.title}）` : ' —— 没落库'}`);
check(s1.shelf?.updatedAt === T, `updatedAt 用的是服务端时间戳（${s1.shelf?.updatedAt}）`);
check(!!s1.bookmark, `书签落库${s1.bookmark ? `（笔记「${s1.bookmark.note}」）` : ''}`);
check(s1.plugins.length === 1 && s1.plugins[0].id === 'e2e', `插件落库（${s1.plugins.length} 个）`);
check(s1.theme === '"dark"', `主题设置同步过来了（${s1.theme}）`);
check(errors.length === 0, `落库过程无报错${errors.length ? `：${errors.slice(0, 3).join(' | ')}` : ''}`);

console.log('\n=== 2. 平板删掉这本书，手机下一次同步要跟着删 ===');
await seed({
  deletes: [
    { kind: 'shelf', id: shelfKey, deletedAt: T + 1000 },
    { kind: 'bookmark', id: bmKey, deletedAt: T + 1000 },
  ],
});
await reload();
const s2 = await waitFor((x) => !x.shelf && !x.bookmark);
check(!s2.shelf, '书架条目已被删除传播清掉');
check(!s2.bookmark, '书签同样');
check(
  s2.tombstones.some((t) => t.kind === 'shelf' && t.id === shelfKey),
  `本地补记了墓碑（共 ${s2.tombstones.length} 条）`,
);
check(errors.length === 0, `删除传播无报错${errors.length ? `：${errors.slice(0, 3).join(' | ')}` : ''}`);

console.log('\n=== 3. 平板又重新加回来，手机要能拿到且不被旧墓碑再删一次 ===');
await seed({ shelf: [{ ...SHELF, addedAt: T + 2000, updatedAt: T + 2000 }] });
await reload();
const s3a = await waitFor((x) => !!x.shelf);
check(!!s3a.shelf, '重新添加的条目回到了本地');
check(s3a.shelf?.updatedAt === T + 2000, `updatedAt 前进到了 ${s3a.shelf?.updatedAt}`);

// 再走一轮，专门验"旧墓碑不会反复删新数据"—— 第一轮通过可能只是时序侥幸
await reload();
check(await waitSyncRound(), '第二轮同步确实发生了（不是还没同步）');
const s3b = await readLocal();
check(!!s3b.shelf, '第二轮同步后条目还在（墓碑没有反复咬）');

console.log('\n=== 4. 服务端侧确认最终状态 ===');
const snap = await (await fetch(`${BASE}/api/sync/pull?since=0&deviceId=verify`)).json();
check(snap.shelf.length === 1, `服务端书架 ${snap.shelf.length} 条`);
check(snap.plugins.length === 1, `服务端插件 ${snap.plugins.length} 个`);

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 客户端落库与删除传播正确' : `  ${fails} 项失败`);
if (errors.length) console.log('  浏览器报错：\n   - ' + errors.slice(0, 10).join('\n   - '));
console.log('='.repeat(52));
await ctx.close();
await done(fails === 0 ? 0 : 1);
