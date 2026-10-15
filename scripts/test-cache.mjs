/**
 * 图片磁盘缓存的行为
 *
 * 自己起服务端和假源站：这一套要特殊的 env（缓存目录、上限、放行 127.0.0.1），
 * 跑器再套一层反而碍事。
 *
 * 假源站带命中计数 —— 「第二次是不是又回上游问了」只能这么证明，
 * 光看响应头是猜的。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8866);
const SRC_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const SRC = `http://127.0.0.1:${SRC_PORT}`;
const BASE_DIR = mkdtempSync(join(tmpdir(), 'zeno-cache-'));

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 假源站 ───────────────────────────────────────── */

/** 400KB 的确定性字节：两张不同的图靠 path 派生，比对字节才叫同一张 */
function blob(seed, size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) % 251;
  return b;
}
const JPG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
let hits = {};
let alive = true;

const upstream = createServer((req, res) => {
  const p = req.url ?? '';
  if (!alive) {
    res.destroy(); // 连接直接被掐，跟 CDN 抽风是同一种失败
    return;
  }
  hits[p] = (hits[p] ?? 0) + 1;
  if (p.startsWith('/img')) {
    const seed = p.endsWith('b') ? 2 : p.endsWith('c') ? 3 : 1;
    const body = Buffer.concat([JPG_HEADER, blob(seed, 400 * 1024)]);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  if (p === '/big') {
    const body = Buffer.concat([JPG_HEADER, blob(9, 9 * 1024 * 1024)]);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  if (p === '/page.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>列表页</body></html>');
    return;
  }
  res.writeHead(404).end('nope');
});
await new Promise((r) => upstream.listen(SRC_PORT, '127.0.0.1', r));

/* ── 服务端 ───────────────────────────────────────── */

const dbPath = join(BASE_DIR, 'zeno.db');
const cacheDir = join(BASE_DIR, 'cache');
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    ALLOWED_HOSTS: '127.0.0.1',
    ALLOW_PRIVATE_HOSTS: '1',
    ZENO_CACHE_DIR: cacheDir,
    ZENO_CACHE_MAX_MB: '512',
  },
});

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    if (srv.exitCode !== null) throw new Error(`服务端提前退出（code ${srv.exitCode}）`);
    try {
      const r = await fetch(`${BASE}/api/cache`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('服务端启动超时');
}

const proxyUrl = (p) => `${BASE}/api/proxy?url=${encodeURIComponent(`${SRC}${p}`)}`;
async function get(p) {
  const r = await fetch(proxyUrl(p), { signal: AbortSignal.timeout(30_000) });
  return { status: r.status, headers: Object.fromEntries(r.headers), buf: Buffer.from(await r.arrayBuffer()) };
}
const status = async () => (await fetch(`${BASE}/api/cache`)).json();
/** 落盘是流 'end' 之后异步做的。不等就是测竞态，不是测行为 */
async function waitCached(n, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const s = await status();
    if (s.files >= n) return s;
    if (Date.now() - t0 > ms) throw new Error(`等缓存落盘超时（要 ${n} 张，现在 ${s.files} 张）`);
    await sleep(100);
  }
}
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

try {
  const boot = await waitUp();
  console.log('\n=== 1. 命中与不命中 ===');
  check(boot.dir === cacheDir && boot.enabled, '启动就认 env 里的缓存目录', boot.dir);

  const first = await get('/img');
  check(first.status === 200 && !first.headers['x-zeno-cache'], '第一次回上游，没打 HIT 标');
  await waitCached(1);
  const second = await get('/img');
  check(second.headers['x-zeno-cache'] === 'HIT', '第二次从盘上回', second.headers['x-zeno-cache']);
  check(hits['/img'] === 1, '假源站只被问了一次', `hits=${hits['/img']}`);
  check(second.buf.equals(first.buf), '缓存回来的字节和原来逐字节相同', `${second.buf.length}B`);

  const st1 = await status();
  check(st1.files === 1 && st1.bytes === first.buf.length, '账本记了一张', `${st1.files} 张 / ${st1.bytes}B`);

  console.log('\n=== 2. HTML 不进缓存 ===');
  await get('/page.html');
  await get('/page.html');
  check(hits['/page.html'] === 2, '列表页每次都回上游（新话不能被缓存挡着）');
  const st2 = await status();
  check(st2.files === 1, '缓存里还是只有那一张图', `${st2.files} 张`);

  console.log('\n=== 3. 超过 8MB 的图只转发不存 ===');
  const big = await get('/big');
  check(big.status === 200 && big.buf.length === 9 * 1024 * 1024 + 4, '客户端照样拿到完整 9MB', `${big.buf.length}B`);
  check((await status()).files === 1, '大图没进盘（内存里攒一份是有上限的）');

  console.log('\n=== 4. 超上限按最后访问淘汰 ===');
  const cfg = await post('/api/cache/config', { maxMb: 1 });
  check(cfg.status === 200 && cfg.json.maxBytes === 1024 * 1024, '上限改成 1MB（一张 400KB，只装得下两张）');
  await get('/img');            // 已经缓存，把它的访问时间顶到最新
  await get('/imgb');           // 新存一张，此刻两张正好不超
  await sleep(400);
  await get('/img');            // 再碰一次 —— imgb 于是成了最久没碰的那个
  await get('/imgc');           // 第三张挤进来，必须裁掉一张
  await sleep(400);
  const st3 = await status();
  check(st3.files === 2 && st3.bytes <= 1024 * 1024, '三张装不下，裁到只剩两张', `${st3.files} 张 / ${st3.bytes}B`);
  const beforeB = hits['/imgb'] ?? 0;
  await get('/img');
  const afterImg = hits['/img'] ?? 0;
  await get('/imgb');
  await sleep(400);
  check(afterImg === 1, '刚碰过的那张没被裁（还是 HIT，没回上游）', `hits=${afterImg}`);
  check((hits['/imgb'] ?? 0) === beforeB + 1, '最久没碰的那张被裁了，得回上游重取');

  console.log('\n=== 5. 上游掐了，看过的图照样出 ===');
  await get('/imgd');           // 一张确定还在缓存里的图
  await sleep(400);
  await get('/imgd');
  alive = false;
  const hot = await get('/imgd');
  check(hot.status === 200 && hot.headers['x-zeno-cache'] === 'HIT', '命中路径根本不去问上游，源站死活无关', `HTTP ${hot.status}`);
  check(hot.buf.length > 0, '拿回来的还是那张图的字节', `${hot.buf.length}B`);
  const never = await get('/imgnever');
  check(never.status === 502 && !never.headers['x-zeno-cache'], '没缓存过的才真的失败', `HTTP ${never.status}`);
  alive = true;

  console.log('\n=== 6. 目录校验 ===');
  const rel = await post('/api/cache/config', { dir: 'relative/path' });
  check(rel.status === 400, '拒绝相对路径', rel.json.error);
  const inside = await post('/api/cache/config', { dir: join(process.cwd(), 'data', 'cache') });
  check(inside.status === 400, '拒绝指进应用自己的目录', inside.json.error);
  const other = join(BASE_DIR, 'cache2');
  const moved = await post('/api/cache/config', { dir: other });
  check(moved.status === 200 && moved.json.dir === other, '换成别的目录');
  check(moved.json.files === 0, '换目录后旧账本作废（不然统计是陈的）', `${moved.json.files} 张`);

  console.log('\n=== 7. 清空与关闭 ===');
  await get('/img');
  await waitCached(1);
  check((await status()).files === 1, '新目录里重新攒了一张');
  const cleared = await post('/api/cache/clear', {});
  check(cleared.status === 200 && cleared.json.files === 0, '清空后归零');
  const off = await post('/api/cache/config', { maxMb: 0 });
  check(off.status === 200 && off.json.enabled === false, '上限 0 = 关掉缓存');
  await get('/img');
  await get('/img');
  check(hits['/img'] >= 3, '关掉后每次都回上游', `hits=${hits['/img']}`);
  check((await status()).files === 0, '关掉期间不落盘');

  console.log('\n=== 8. 目录浏览（设置页那个选择器的后端）===');
  const roots = await (await fetch(`${BASE}/api/cache/dirs`)).json();
  check(
    roots.roots === true && roots.entries.length > 0,
    '不传 path 就报根（Windows 是盘符，POSIX 是 /）',
    roots.entries.map((e) => e.name).join(' '),
  );
  const browsable = join(BASE_DIR, 'browse');
  mkdirSync(join(browsable, 'in'), { recursive: true });
  mkdirSync(join(browsable, 'z'), { recursive: true });
  mkdirSync(join(browsable, '.hidden'), { recursive: true });
  writeFileSync(join(browsable, 'afile.txt'), 'x');
  const listed = await (await fetch(`${BASE}/api/cache/dirs?path=${encodeURIComponent(browsable)}`)).json();
  check(
    JSON.stringify(listed.entries.map((e) => e.name)) === '["in","z"]',
    '只列子目录：文件跳过、点开头的跳过，并按名字排好',
    JSON.stringify(listed.entries.map((e) => e.name)),
  );
  check(
    listed.parent === BASE_DIR && listed.current === (await status()).dir,
    '带上父级和服务端当前目录，界面才知道自己在哪',
  );
  const relBrowse = await fetch(`${BASE}/api/cache/dirs?path=relative/x`);
  check(relBrowse.status === 400, '拒绝相对路径');
  const gone = await fetch(`${BASE}/api/cache/dirs?path=${encodeURIComponent(join(BASE_DIR, 'not-there'))}`);
  check(gone.status === 400, '不存在的目录报错，而不是给一个空列表让人以为盘是空的');
} finally {
  srv.kill();
  upstream.close();
  await sleep(400);
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
console.log('  全部通过 — 图片缓存行为正确');
