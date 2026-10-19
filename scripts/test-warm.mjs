/**
 * 追漫的行为：服务端自己算该铺哪几章、自己解地址、按各自的到期时间腾盘
 *
 * 自己起服务端和假源站（要特殊 env：缓存目录、放行 127.0.0.1、把两个宽限期调小
 * 到能在测试里等的程度），跟 test-cache.mjs 同一个套路。
 *
 * 假源站带命中计数 —— 「这一章是不是真去解过」「重跑一轮有没有再下一遍」
 * 只能这么证明，光看接口返回值是猜的。
 *
 * 全程不碰真站点：三章 × 每章两个内页，图是确定性字节。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8870);
const SRC_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const SRC = `http://127.0.0.1:${SRC_PORT}`;
const BASE_DIR = mkdtempSync(join(tmpdir(), 'zeno-warm-'));
const PLUGIN_ID = 'fakesrc';
const SLUG = 'demo';

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 假源站：详情页 + 章节页（每章两个内页）+ 图 ── */

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const hits = { detail: 0, chapter: 0, img: 0 };
function page(seed, size = 60 * 1024) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) % 251;
  return Buffer.concat([JPG, b]);
}
/** 一章两个内页：第 1 页标题写着 (1/2)，第 2 页没有标记 */
function chapterHtml(id) {
  const [, p] = String(id).split('_');
  const imgs = p ? [`${SRC}/img/${id}_a.jpg`] : [`${SRC}/img/${id}_a.jpg`, `${SRC}/img/${id}_b.jpg`];
  return (
    `<!doctype html><meta charset="utf-8"><title>第${id}话${p ? '' : '(1/2)'} - 假源</title>` +
    imgs.map((u) => `<img data-src="${u}">`).join('')
  );
}
const upstream = createServer((req, res) => {
  const u = new URL(req.url, SRC);
  if (u.pathname === '/hits') {
    // 给测试读的：详情页被取了几次 —— 那道 6 小时闸门有没有真的生效，只能这么证
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hits));
    return;
  }
  if (u.pathname === '/detail') {
    hits.detail++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<div class="book" title="合成漫画" data-slug="demo"></div>' +
        [1, 2, 3].map((i) => `<a class="chap" href="/chapter?c=${i}">第${i}话</a>`).join(''),
    );
    return;
  }
  const c = /^\/chapter$/.exec(u.pathname) && u.searchParams.get('c');
  if (c) {
    hits.chapter++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(chapterHtml(c));
    return;
  }
  const m = /^\/img\/(.+)\.jpg$/.exec(u.pathname);
  if (m) {
    hits.img++;
    let seed = 0;
    for (const ch of m[1]) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
    const body = page(seed);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(404).end('nope');
});
await new Promise((r) => upstream.listen(SRC_PORT, '127.0.0.1', r));

/* ── 服务端 ── */

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(BASE_DIR, 'zeno.db'),
    DIST_DIR: join(BASE_DIR, 'no-dist'),
    ALLOWED_HOSTS: '127.0.0.1',
    ALLOW_PRIVATE_HOSTS: '1',
    ZENO_CACHE_DIR: join(BASE_DIR, 'cache'),
    ZENO_CACHE_MAX_MB: '512',
    ZENO_UPDATE_CHECK_MS: '0', // 不自己起循环，全部由测试手动踢
    ZENO_WARM_LOOP_MS: '0',
    ZENO_WARM_READ_GRACE_MS: '0', // 读完/掉出窗口的，这一轮就该删
    ZENO_WARM_UNFOLLOW_GRACE_MS: '2000', // 取消追漫留 2 秒反悔，测试等得起
  },
});

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    if (srv.exitCode !== null) throw new Error(`服务端提前退出（code ${srv.exitCode}）`);
    try {
      const r = await fetch(`${BASE}/api/warm`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('服务端启动超时');
}

const GET = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const POST = async (p, body = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const warm = async () => (await GET('/api/warm')).json;
const book = async () => (await GET(`/api/warm/book?pluginId=${PLUGIN_ID}&slug=${SLUG}`)).json;
const cacheFiles = async () => (await GET('/api/cache')).json.files;

/** 往服务端推一份客户端状态（书架、开关、进度都走同步那条路） */
const push = (what) =>
  POST('/api/sync/push', { deviceId: 'test', seq: 0, plugins: [], shelf: [], positions: [], bookPrefs: [], ...what });

const plugin = {
  format: 'zeno-plugin@1',
  meta: { id: PLUGIN_ID, name: '本地合成源', description: '追漫测试用', author: 'local', version: '1.0.0', icon: '🧪' },
  entry: SRC,
  urls: { search: '/detail?slug={q}', classify: '/detail', detail: '/detail?slug={slug}', chapter: '/chapter?c={id}' },
  parse: {
    card: '<div class="book" title=',
    slugFrom: 'data-slug="([a-z0-9]+)"',
    title: { attr: 'title' },
    cover: `${SRC}/img/cover.jpg`,
    chapterItem: 'class="chap"',
    chapterIdFrom: 'c=(\\d+)',
    imageAttr: 'data-src',
  },
  imageHosts: ['127.0.0.1'],
  fetch: { mode: { list: 'fetch', detail: 'fetch', chapter: 'fetch' }, timeoutMs: 15000 },
  headers: {},
};

/** 追更那一轮是后台跑的（端点立刻回 202），所以判据只能等假源站的计数 */
async function waitHits(pred, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const h = await (await fetch(`${SRC}/hits`)).json();
    if (pred(h)) return h;
    if (Date.now() - t0 > ms) return h; // 把当时的数交回去，让断言自己报差多少
    await sleep(150);
  }
}

/** 踢一轮，等到不再 pumping */
async function runRound(label) {
  for (let i = 0; i < 60; i++) {
    const r = await POST('/api/warm/run');
    if (r.status !== 200) throw new Error(`${label}：踢轮失败 ${JSON.stringify(r.json)}`);
    if (!r.json.round?.rows || !warm) break;
    if (!(await warm()).pumping) break;
    await sleep(300);
  }
  return warm();
}

try {
  const boot = await waitUp();
  console.log('\n=== 1. 没开追漫的书，一轮下来台账该是空的 ===');
  check(boot.keep === 30, '默认保留章数 30', `keep=${boot.keep}`);
  await push({
    plugins: [{ id: PLUGIN_ID, origin: 'imported', data: JSON.stringify(plugin), updatedAt: 1 }],
    shelf: [{ pluginId: PLUGIN_ID, slug: SLUG, title: '合成漫画', cover: '', addedAt: 1, updatedAt: 1 }],
  });
  await POST('/api/updates/check', { force: true });
  const forced = await waitHits((h) => h.detail > 0);
  check(forced.detail > 0, '强制那一轮真的去数了详情页', `detail hits=${forced.detail}`);
  const soft = await POST('/api/updates/check', {});
  check(soft.status === 202 && soft.json.force === false, '不带 force 的那条路端点也认（202 + force:false）', `${soft.status}/${soft.json.force}`);
  await sleep(800);
  check(
    (await (await fetch(`${SRC}/hits`)).json()).detail === forced.detail,
    '有章节表且刚查过 → 6 小时闸门生效，不再重复数',
  );

  console.log('\n=== 1b. 刚查过但没存过章节表的书，闸门不该拦它 ===');
  /*
   * 这是升级到"有 chapter_ids 这一列"之后每台机器都会遇到的状态：
   * updates 行是有的、checked_at 是新的（客户端翻开过这本书，markSeen 写进去的），
   * 而 chapter_ids 是 NULL。闸门只看 checked_at 的话，追漫要等整整半天才拿到表，
   * 期间健康检查全绿、界面一切正常 —— 典型的"部署了但没在干活"。
   */
  await push({ shelf: [{ pluginId: PLUGIN_ID, slug: 'demo2', title: '第二本', cover: '', addedAt: 1, updatedAt: 1 }] });
  await POST('/api/updates/seen', { key: `${PLUGIN_ID}/demo2`, anchors: 3 });
  const before = (await (await fetch(`${SRC}/hits`)).json()).detail;
  await POST('/api/updates/check', {});
  const after = await waitHits((h) => h.detail > before);
  check(after.detail > before, '章节表为空 → 即使刚查过也要补一次', `detail ${before} → ${after.detail}`);
  await push({ deletes: [{ kind: 'shelf', id: `${PLUGIN_ID}/demo2`, updatedAt: 2 }] });

  let st = await runRound('未开追漫');
  check(!st.states?.done && !st.states?.queued, '在架但没开追漫 → 一章都没铺', JSON.stringify(st.states));
  check((await cacheFiles()) === 0, '盘上也没东西', `${await cacheFiles()} 张`);

  console.log('\n=== 2. 开了追漫：服务端自己算、自己解、自己铺 ===');
  await push({ bookPrefs: [{ pluginId: PLUGIN_ID, slug: SLUG, data: JSON.stringify({ warm: true }), updatedAt: 2 }] });
  st = await runRound('开追漫');
  check(st.states?.done === 3, '三章都铺完', JSON.stringify(st.states));
  /*
   * 每章两个内页：第 1 页 2 张 + 第 2 页 1 张 = 3 张，三章 9 张。
   * 这个数同时钉住了 (1/N) 那条内页探测 —— 只解第 1 页的话这里会是 6。
   */
  check((await cacheFiles()) === 9, '九张图进了盘（含每章的第 2 页）', `${await cacheFiles()} 张`);
  check(hits.chapter >= 6, `章节页被解过（3 章 × 2 内页）`, `chapter hits=${hits.chapter}`);

  const marks = await book();
  check(marks.chapters.length === 3 && marks.chapters.every((c) => c.cached), '标记端点：三章都报"已缓存"', JSON.stringify(marks.chapters.map((c) => c.cached)));
  check(marks.chapters[0].id === '1' && marks.chapters[2].id === '3', '标记按阅读顺序回', marks.chapters.map((c) => c.id).join(','));

  console.log('\n=== 3. 重跑一轮不重下 ===');
  const imgHits = hits.img;
  await runRound('重跑');
  check(hits.img === imgHits, '一张图都没重新回源', `${imgHits} → ${hits.img}`);

  console.log('\n=== 4. 窗口收窄：keep=2 之后掉出去的那章腾盘 ===');
  check((await POST('/api/warm/keep', { keep: 2 })).json.keep === 2, '保留章数改成 2');
  await POST('/api/warm/sweep');
  st = await warm();
  check(st.states?.done === 2, '只剩最近两章', JSON.stringify(st.states));
  check((await cacheFiles()) === 6, '掉出去那章的三张删掉了', `${await cacheFiles()} 张`);
  const marks2 = await book();
  check(marks2.chapters.filter((c) => c.cached).length === 2, '标记也跟着少一个', JSON.stringify(marks2.chapters.map((c) => [c.id, c.state])));

  console.log('\n=== 5. 读完的章：过宽限期删，且按"读完那一刻"算 ===');
  /* 进度写成 4 天前读完的：窗口是 2，未读只剩 ch3 —— ch2 虽在窗口内但已读，该走 */
  await push({ positions: [{ pluginId: PLUGIN_ID, slug: SLUG, chapterId: '2', percent: 100, updatedAt: Date.now() - 4 * 24 * 3600_000 }] });
  await POST('/api/warm/sweep');
  await runRound('读完之后');
  st = await warm();
  check(st.states?.done === 2, 'ch2 腾掉、ch3 补进来，窗口仍是两章', JSON.stringify(st.states));
  const marks3 = await book();
  check(
    marks3.chapters.filter((c) => c.cached).map((c) => c.id).join(',') === '1,3',
    '标记现在是第 1、3 章',
    JSON.stringify(marks3.chapters.map((c) => [c.id, c.cached])),
  );

  console.log('\n=== 6. 正在读的章不动刀 ===');
  // ch1 也在窗口边缘，但进度是刚刚报的 → 该被"正在读"护栏留下
  await push({ positions: [{ pluginId: PLUGIN_ID, slug: SLUG, chapterId: '1', percent: 100, updatedAt: Date.now() }] });
  await POST('/api/warm/sweep');
  const afterGuard = await cacheFiles();
  check(afterGuard >= 6, '刚报过进度那章的字节没被删', `${afterGuard} 张`);

  console.log('\n=== 7. 取消追漫：排一天后清，反悔期内重新追就撤销 ===');
  await push({ bookPrefs: [{ pluginId: PLUGIN_ID, slug: SLUG, data: JSON.stringify({ warm: false }), updatedAt: 3 }] });
  await POST('/api/warm/sweep');
  const scheduled = await book();
  check(
    scheduled.chapters.length > 0 && scheduled.chapters.every((c) => c.purgeAt > Date.now() - 5000),
    '整本排上了到期时间（没立刻删）',
    JSON.stringify(scheduled.chapters.map((c) => c.purgeAt)),
  );
  check((await cacheFiles()) >= 6, '字节此刻还在', `${await cacheFiles()} 张`);

  await push({ bookPrefs: [{ pluginId: PLUGIN_ID, slug: SLUG, data: JSON.stringify({ warm: true }), updatedAt: 4 }] });
  await POST('/api/warm/sweep');
  const cancelled = await book();
  check(cancelled.chapters.every((c) => !c.purgeAt), '重新追漫 → 到期时间撤销', JSON.stringify(cancelled.chapters.map((c) => c.purgeAt)));
  check((await cacheFiles()) >= 6, '缓存原封不动', `${await cacheFiles()} 张`);

  console.log('\n=== 8. 反悔期过了才真删；移出书架同理 ===');
  await push({ bookPrefs: [{ pluginId: PLUGIN_ID, slug: SLUG, data: JSON.stringify({ warm: false }), updatedAt: 5 }] });
  await POST('/api/warm/sweep');
  await sleep(2300); // 等过那 2 秒的宽限期
  await POST('/api/warm/sweep');
  st = await warm();
  check(!st.states?.done && !st.states?.queued, '过完宽限期，台账清空', JSON.stringify(st.states));
  check((await cacheFiles()) === 0, '这本书的字节全腾掉了', `${await cacheFiles()} 张`);

  /* 移出书架：开关还开着，但人不在架上了 —— 同样该排到期 */
  await push({ bookPrefs: [{ pluginId: PLUGIN_ID, slug: SLUG, data: JSON.stringify({ warm: true }), updatedAt: 6 }] });
  await POST('/api/warm/run');
  await POST('/api/updates/check', { force: true });
  await runRound('重新铺一轮');
  const back = await book();
  check(back.chapters.some((c) => c.cached), '重新追漫后又铺上了', JSON.stringify(back.chapters.map((c) => [c.id, c.cached])));
  await push({ shelf: [], deletes: [{ kind: 'shelf', id: `${PLUGIN_ID}/${SLUG}`, updatedAt: 7 }] });
  await POST('/api/warm/sweep');
  const offShelf = await book();
  check(
    offShelf.chapters.length > 0 && offShelf.chapters.every((c) => c.purgeAt),
    '移出书架 → 整本排上一天后清',
    JSON.stringify(offShelf.chapters.map((c) => !!c.purgeAt)),
  );
  check((await cacheFiles()) > 0, '此刻字节还在（一天内加回来就不删）', `${await cacheFiles()} 张`);

  console.log('\n=== 9. 参数校验 ===');
  check((await GET('/api/warm/book')).status === 400, '缺 pluginId/slug 挡下来');
  check((await GET('/api/warm/book?pluginId=a/b&slug=x')).status === 400, 'pluginId 带 / 挡下来');
  check((await POST('/api/warm/keep', { keep: 'abc' })).status === 400, '保留章数不是个数就挡下来');
} finally {
  srv.kill();
  upstream.close();
  await sleep(300);
  try {
    rmSync(BASE_DIR, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 还占着的话留给系统临时目录自己清 */
  }
}

console.log('\n' + '='.repeat(56));
if (fails) {
  console.log(`  ${fails} 项失败`);
  process.exit(1);
}
console.log('  全部通过 — 追漫行为正确');
