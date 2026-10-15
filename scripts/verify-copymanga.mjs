/**
 * 拷贝漫画的**图片与缓存层**验证
 *
 * 解析链路（列表/详情/章节能不能抓对）由 scripts/verify-plugin.ts 覆盖，
 * 这里只管它管不到的部分：几百张图怎么过代理、有没有落到盘上、
 * 以及那个"CDN 回 octet-stream 就认不出是图"的坑。
 *
 * 跑在独立端口 + 独立临时库 + 独立缓存目录上，不碰生产服务。
 *
 * 用法：node scripts/verify-copymanga.mjs [插件 JSON 路径]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_PATH = process.argv[2] ?? resolve(ROOT, '../zeno-plugins/plugins/copymanga.json');
const PORT = Number(process.env.VERIFY_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 已验证过的一章：21 页 */
const CHAPTER =
  'https://www.mangacopy.com/comic/buxihuannverfanerxihuanmamawoma/chapter/46f6f7ce-f45c-11ea-8ec5-00163e0ca5bd';
const CAPTURE = '"url"\\s*:\\s*"([^"]+)"';
const EXPECT_PAGES = 21;

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};
const get = (u, opts = {}) =>
  fetch(u, { ...opts, signal: opts.signal ?? AbortSignal.timeout(120_000) });
const proxyUrl = (u, q = '') => `${BASE}/api/proxy?url=${encodeURIComponent(u)}${q}`;

const dir = mkdtempSync(join(tmpdir(), 'zeno-copymanga-'));
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'verify.db'), SYNC_TOKEN: '', ALLOWED_HOSTS: '' },
});
const stop = () => {
  child.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄可能还没放掉，临时目录交给系统清 */
  }
};

for (let i = 0; i < 60; i++) {
  if (child.exitCode !== null) {
    console.error(`服务端提前退出（code ${child.exitCode}）`);
    process.exit(1);
  }
  try {
    if ((await get(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 500));
}

/*
 * 插件必须真的**装进去**，不是拿 ALLOWED_HOSTS 糊过去：
 * 这个站要求桌面 UA，而 UA 是从插件的 headers 推导出来的，
 * 用环境变量补域名就测不到那条路径了。
 */
const pluginData = readFileSync(PLUGIN_PATH, 'utf8');
const push = await get(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'verify',
    plugins: [{ id: 'copymanga', origin: 'local', updatedAt: Date.now(), data: pluginData }],
  }),
});
const pushed = await push.json();
const hosts = pushed.allowedHosts ?? [];
console.log('=== 0. 装插件');
check(pushed.ok === true, `push ${push.status}`);
/*
 * 白名单里存的是 entry 的**具体主机名**（www.mangacopy.com），不是域名根。
 * 代理放行是按后缀匹配的，所以这里也按后缀断言，别写死一种写法。
 */
const covers = (h) => hosts.some((a) => h === a || h.endsWith(`.${a}`));
check(covers('www.mangacopy.com'), `白名单覆盖站点（实际 ${JSON.stringify(hosts)}）`);
check(covers('sb.mangafunb.fun'), `白名单覆盖图片 CDN 的各级子域名`);

console.log('\n=== 1. 插件声明的 UA 在代理这一侧生效');
{
  /*
   * 同一地址，手机 UA 会被 302 到 JS 壳（没有任何卡片），桌面 UA 才给渲染好的列表。
   * 代理用了插件的 headers 才拿得到卡片标记。
   */
  const res = await get(proxyUrl('https://www.mangacopy.com/comics?theme=aiqing'));
  const html = await res.text();
  check(res.ok, `HTTP ${res.status}`);
  check(
    html.includes('exemptComic_Item') || html.includes('lazyload'),
    `SSR 卡片标记在响应里（HTML ${html.length} 字节）`,
  );
}

console.log('\n=== 2. 章节：一次捕获拿到整张表');
let images = [];
{
  const t0 = performance.now();
  const res = await get(
    proxyUrl(CHAPTER, `&mode=browser&capture=${encodeURIComponent(CAPTURE)}&waitFor=img`),
  );
  const ms = Math.round(performance.now() - t0);
  check(
    (res.headers.get('content-type') ?? '').includes('application/json'),
    `命中捕获回 JSON（content-type ${res.headers.get('content-type')}）`,
  );
  images = (await res.json()).images ?? [];
  check(images.length === EXPECT_PAGES, `拿到 ${images.length} 张（页面指示器 1 / ${EXPECT_PAGES}）`);
  console.log(`     ${ms}ms（含服务端浏览器冷启动，waitFor=img 也没能抢跑 —— capture 优先）`);

  /*
   * 平时阅读付的是这一笔：浏览器已经起着，换一章要多久。
   * 上一节那次包含 launch 的开销，拿它当"每章成本"会把问题看大。
   */
  const other =
    'https://www.mangacopy.com/comic/baoliwansui/chapter/d2bb9687-f9a6-11ef-878e-fa163e02432f';
  const t1 = performance.now();
  const r2 = await get(
    proxyUrl(other, `&mode=browser&capture=${encodeURIComponent(CAPTURE)}`),
  );
  const warmMs = Math.round(performance.now() - t1);
  const imgs2 = (await r2.json()).images ?? [];
  check(imgs2.length === 57, `热浏览器换章：另一部作品的 ${imgs2.length} 页（指示器 1 / 57）`);
  console.log(`     热浏览器换章 ${warmMs}ms —— 这才是每章的实际成本`);
}

console.log('\n=== 3. 图片过代理：并发取回 + 落到盘上');
{
  const run = async (urls, limit) => {
    const t0 = performance.now();
    const it = urls[Symbol.iterator]();
    const out = [];
    await Promise.all(
      Array.from({ length: limit }, async () => {
        for (const u of it) {
          const r = await get(proxyUrl(u));
          out.push({ status: r.status, bytes: (await r.arrayBuffer()).byteLength, ct: r.headers.get('content-type'), cc: r.headers.get('cache-control') });
        }
      }),
    );
    return { wall: (performance.now() - t0) / 1000, out };
  };

  const cold = await run(images, 8);
  const bytes = cold.out.reduce((a, r) => a + r.bytes, 0);
  check(cold.out.length === EXPECT_PAGES, `取回 ${cold.out.length} 张`);
  check(cold.out.every((r) => r.status === 200), `全部 200（失败 ${cold.out.filter((r) => r.status !== 200).length}）`);
  check(cold.out.every((r) => (r.ct ?? '').startsWith('image/')), `类型都是 image/*（首张 ${cold.out[0]?.ct}）`);
  check(
    cold.out.every((r) => /max-age=86400/.test(r.cc ?? '')),
    `图片给一天的 Cache-Control（首张 "${cold.out[0]?.cc}"）`,
  );
  console.log(
    `     冷：${(bytes / 1048576).toFixed(1)} MB / ${cold.wall.toFixed(1)}s = ${(bytes / 1048576 / cold.wall).toFixed(2)} MB/s`,
  );

  const warm = await run(images, 8);
  const gain = Math.round(((cold.wall - warm.wall) / cold.wall) * 100);
  console.log(`     热（服务端盘上已有）：${warm.wall.toFixed(2)}s`);
  check(warm.wall < cold.wall, `第二遍快 ${gain}% —— 缓存真的在起作用`);
}

console.log('\n=== 4. 封面：CDN 回 octet-stream 也要按图片对待');
{
  const listHtml = await (await get(proxyUrl('https://www.mangacopy.com/comics?theme=aiqing'))).text();
  const cover = listHtml.match(/data-src="(https:\/\/[^"]+\/cover\/[^"]+)"/)?.[1];
  check(!!cover, `从列表里取到一个封面地址 ${cover ?? '(没有)'}`);
  if (cover) {
    const res = await get(proxyUrl(cover));
    const bytes = (await res.arrayBuffer()).byteLength;
    const ct = res.headers.get('content-type') ?? '';
    const cc = res.headers.get('cache-control') ?? '';
    check(res.ok && bytes > 2000, `HTTP ${res.status}，${bytes} B，类型 "${ct}"`);
    check(/max-age=86400/.test(cc), `按图片缓存（Cache-Control "${cc}"）—— 只看类型会漏掉这个站`);
  }
}

console.log('\n=== 5. 没装的域名依然进不去');
{
  const res = await get(`${BASE}/api/proxy?url=${encodeURIComponent('https://example.com/x')}`);
  check(res.status === 403, `白名单外的域名 ${res.status}`);
}

stop();
console.log(`\n${fails === 0 ? '全部通过 — 图片与缓存层可用' : `${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
