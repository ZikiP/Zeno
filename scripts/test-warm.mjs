/**
 * 追漫预热的行为：递交、落盘、不重下、按章保留、删的时候不碰正在读的
 *
 * 自己起服务端和假源站（要特殊 env：缓存目录、宽限期 0、放行 127.0.0.1），
 * 跟 test-cache.mjs 同一个套路。
 *
 * 假源站带命中计数 —— 「重递一次有没有又下一遍」和「删掉的那张是不是真从盘上没了」
 * 都只能靠它证明，光看接口返回值是猜的。
 *
 * ZENO_WARM_LOOP_MS=0 关掉后台循环：所有轮次都由测试自己 kick，
 * 免得跑到一半被定时那一轮插进来，胜负就说不清了。
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

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 假源站 ───────────────────────────────────────── */

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const hits = {};
/** 每张图按 path 派生出确定的字节，好比对"删掉之后回源拿到的还是同一张" */
function page(seed, size = 120 * 1024) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) % 251;
  return Buffer.concat([JPG, b]);
}
const upstream = createServer((req, res) => {
  const p = req.url ?? '';
  const m = /^\/img\/(\d+)\.jpg$/.exec(p);
  if (!m) {
    res.writeHead(404).end('nope');
    return;
  }
  hits[p] = (hits[p] ?? 0) + 1;
  const body = page(Number(m[1]));
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) });
  res.end(body);
});
await new Promise((r) => upstream.listen(SRC_PORT, '127.0.0.1', r));

/* ── 服务端 ───────────────────────────────────────── */

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
    ZENO_UPDATE_CHECK_MS: '0',
    ZENO_WARM_LOOP_MS: '0',
    // 宽限期 0：这一轮就该删干净。"最近被读"那道护栏保持默认 24 小时，正是要它生效
    ZENO_WARM_READ_GRACE_MS: '0',
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

const POST = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const warmStatus = async () => (await fetch(`${BASE}/api/warm`)).json();
const cacheStatus = async () => (await fetch(`${BASE}/api/cache`)).json();

/** 等到 queued 清空、running 收尾。超时就把当时的状态原样吐出来，别只报"超时" */
async function waitRound(ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await warmStatus();
    if (!s.pumping && !(s.states?.queued ?? 0)) return s;
    if (Date.now() - t0 > ms) throw new Error(`等预热收尾超时：${JSON.stringify(s)}`);
    await sleep(150);
  }
}

const img = (n) => `${SRC}/img/${n}.jpg`;
/** 三章 × 两张。第一套故意用客户端真正会递交的那种代理形态相对地址 */
const BOOK = { pluginId: 'fakesrc', slug: 'warm-me' };
const chapters = (from) => [
  { id: `c${from}`, index: from, images: [`/api/proxy?url=${encodeURIComponent(img(from * 10 + 1))}`, img(from * 10 + 2)] },
  { id: `c${from + 1}`, index: from + 1, images: [img(from * 10 + 11), img(from * 10 + 12)] },
  { id: `c${from + 2}`, index: from + 2, images: [img(from * 10 + 21), img(from * 10 + 22)] },
];

try {
  const boot = await waitUp();
  console.log('\n=== 1. 递交之后原图落到盘上 ===');
  check(boot.keep === 5, '没配过时用 env 的默认保留章数', `keep=${boot.keep}`);

  const submit = await POST('/api/warm', { ...BOOK, chapters: chapters(1) });
  check(submit.status === 200 && submit.json.queued === 3, '三章都排上了', JSON.stringify(submit.json));
  const done = await waitRound();
  check(done.states?.done === 3, '一轮跑完三章都是 done', JSON.stringify(done.states));
  check((await cacheStatus()).files === 6, '六张图进了盘', `${(await cacheStatus()).files} 张`);
  check(
    hits['/img/11.jpg'] === 1 && hits['/img/12.jpg'] === 1,
    '代理形态的相对地址被认成了同一个上游地址（没多取一张）',
    `11.jpg hits=${hits['/img/11.jpg']}`,
  );

  console.log('\n=== 2. 重递同一份不重下 ===');
  const again = await POST('/api/warm', { ...BOOK, chapters: chapters(1) });
  check(again.json.queued === 0, '地址没变的行不再重排', `queued=${again.json.queued}`);
  await waitRound();
  const before = Object.values(hits).reduce((a, b) => a + b, 0);
  await POST('/api/warm', { ...BOOK, chapters: chapters(1) });
  await waitRound();
  const after = Object.values(hits).reduce((a, b) => a + b, 0);
  check(after === before, '第二趟一个字节都没回源', `${before} → ${after}`);

  console.log('\n=== 3. 保留 K=1：只留未读的第一章 ===');
  const keep = await POST('/api/warm/keep', { keep: 1 });
  check(keep.status === 200 && keep.json.keep === 1, '保留章数改成 1', JSON.stringify(keep.json));
  const swept = await POST('/api/warm/sweep', {});
  check(swept.json.dropped === 2, '另外两章标成不留', `dropped=${swept.json.dropped}`);
  check(swept.json.files === 4, '宽限期 0，这一轮就删掉四张', `files=${swept.json.files}`);
  check((await cacheStatus()).files === 2, '盘上只剩第一章那两张', `${(await cacheStatus()).files} 张`);

  console.log('\n=== 4. 正在读的章：字节不动刀 ===');
  // 重铺那两章（盘上已经被删空，所以这趟真回源，并给它们新的 warmed_at）
  const re = await POST('/api/warm', { ...BOOK, chapters: chapters(1) });
  check(re.json.queued === 2, '被删掉的两章重新排上，留着的那章没动', `queued=${re.json.queued}`);
  await waitRound();
  check((await cacheStatus()).files === 6, '六张又回到盘上', `${(await cacheStatus()).files} 张`);

  // c2 的进度是"刚刚报上来的"（人在这一章），c3 的进度是 25 小时前 —— 早出护栏窗口了
  const now = Date.now();
  const pushed = await POST('/api/sync/push', {
    deviceId: 'phone',
    positions: [
      { pluginId: BOOK.pluginId, slug: BOOK.slug, chapterId: 'c2', percent: 42, updatedAt: now },
      { pluginId: BOOK.pluginId, slug: BOOK.slug, chapterId: 'c3', percent: 42, updatedAt: now - 25 * 3600_000 },
    ],
  });
  check(pushed.status === 200, '两条进度都写进去了', JSON.stringify(pushed.json));
  const swept2 = await POST('/api/warm/sweep', {});
  check(swept2.json.dropped === 2, 'K=1 之下两章都标成不留', `dropped=${swept2.json.dropped}`);
  check(swept2.json.files === 2, '只删了不在读的那章，正在读的章一张没删', `files=${swept2.json.files}`);
  check((await cacheStatus()).files === 4, '盘上留下的是第一章 + 正在读的那章', `${(await cacheStatus()).files} 张`);

  console.log('\n=== 5. 关掉追漫 = 递交一份空表 ===');
  const off = await POST('/api/warm', { ...BOOK, chapters: [] });
  check(off.status === 200 && off.json.queued === 0 && off.json.kept === 0, '空表不报错，也不排新活', JSON.stringify(off.json));
  const swept3 = await POST('/api/warm/sweep', {});
  check(swept3.json.files === 2, '没在读的那两张删掉', `files=${swept3.json.files}`);
  check((await cacheStatus()).files === 2, '整本关掉了，只剩"正在读"那张护栏留下的', `${(await cacheStatus()).files} 张`);

  console.log('\n=== 6. 递交的形态不对就该挡下来 ===');
  const noSlug = await POST('/api/warm', { pluginId: 'fakesrc', chapters: [] });
  check(noSlug.status === 400, '缺 slug');
  const slashed = await POST('/api/warm', { pluginId: 'a/b', slug: 'x', chapters: [] });
  check(slashed.status === 400, 'pluginId 里带 / 挡掉（那是拼接过的键）', slashed.json.error);
  const notArray = await POST('/api/warm', { ...BOOK, chapters: { c1: [] } });
  check(notArray.status === 400, 'chapters 不是数组挡掉');
  const tooMany = await POST('/api/warm', {
    ...BOOK,
    chapters: Array.from({ length: 61 }, (_, i) => ({ id: `x${i}`, images: [img(900 + i)] })),
  });
  check(tooMany.status === 400, '一次 61 章挡掉，让客户端分批', tooMany.json.error);
  const blank = await POST('/api/warm', { ...BOOK, chapters: [{ id: 'c9', images: [] }] });
  check(blank.status === 200 && blank.json.queued === 0, '一张图都没有的章不进台账', JSON.stringify(blank.json));

  console.log('\n=== 7. 上游取不到：停在 error，别的章照铺 ===');
  const mix = await POST('/api/warm', {
    ...BOOK,
    chapters: [
      { id: 'gone', index: 1, images: [`${SRC}/nope/1.jpg`, `${SRC}/nope/2.jpg`] },
      { id: 'good', index: 2, images: [img(501), img(502)] },
    ],
  });
  check(mix.status === 200 && mix.json.queued === 2, '两章都排上', JSON.stringify(mix.json));
  await waitRound();
  const st = await warmStatus();
  check(st.states?.error === 1 && st.states?.done === 1, '取不到的停在 error，好的那章不受牵连', JSON.stringify(st.states));
  const goneRow = st.lastRound;
  check(goneRow?.paused === null, '这一轮不是因为限流停下来的', JSON.stringify(goneRow));
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
console.log('  全部通过 — 追漫预热行为正确');
