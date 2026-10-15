/**
 * 图片取源吞吐探针
 *
 * 为什么需要它：阅读器一章几十张图，慢的不是解析而是"几十张图怎么排队"。
 * 并发数、代理槽位、预取深度这几个数拍脑袋定，实测可能差 3–4 倍。
 *
 * 用法：node scripts/bench-images.mjs [并发列表...]
 *      默认 1,4,8,16 —— 只是本地探针，不经过 Zeno 服务，直连 CDN。
 */

const CHAPTER = [
  '16403460415833', '16403460446446', '16403460477835', '16403460504724', '16403460543538',
  '16403460572697', '16403460601226', '16403460629672', '16403460658306', '16403460685785',
  '16403460709677', '16403460738193', '16403460771728', '16403460804164', '16403460830381',
  '16403460858444', '16403460891769', '16403460913154', '16403460938831', '16403460961607',
  '16403460988498',
].map((id) => `https://sb.mangafunb.fun/b/buxihuannverfanerxihuanmamawoma/593c1/${id}/c1500x.webp`);

const COVER = 'https://sn.mangafunb.fun/n/naoodngxueshenghui/cover/1785949380.jpg.328x422.jpg';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function grab(url) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, bytes: buf.length, ms: performance.now() - t0, ct: res.headers.get('content-type') };
}

/** 固定并发跑一遍全部 URL */
async function run(urls, limit) {
  const next = urls.values();
  const workers = Array.from({ length: limit }, async () => {
    const out = [];
    for (const u of next) out.push(await grab(u));
    return out;
  });
  const t0 = performance.now();
  const parts = (await Promise.all(workers)).flat();
  const wall = performance.now() - t0;
  const bytes = parts.reduce((a, b) => a + b.bytes, 0);
  const times = parts.map((p) => p.ms).sort((a, b) => a - b);
  return {
    limit,
    n: parts.length,
    bad: parts.filter((p) => p.status !== 200).length,
    wallS: +(wall / 1000).toFixed(2),
    perImageMs: Math.round(wall / parts.length),
    p50: Math.round(times[times.length >> 1]),
    p95: Math.round(times[Math.floor(times.length * 0.95)]),
    mbs: +(bytes / 1024 / 1024 / (wall / 1000)).toFixed(2),
  };
}

console.log('=== 封面：带不带尺寸参数');
for (const [name, u] of [
  ['原样', COVER],
  ['追加 ?w=300&h=400&q=85', `${COVER}?w=300&h=400&q=85`],
]) {
  try {
    const r = await grab(u);
    console.log(`  ${name.padEnd(24)} ${r.status} ${r.bytes} B ${r.ct} ${Math.round(r.ms)}ms`);
  } catch (e) {
    console.log(`  ${name.padEnd(24)} 失败 ${e.message}`);
  }
}

const limits = (process.argv[2] ? process.argv[2].split(',') : ['1', '4', '8', '16']).map(Number);
console.log(`\n=== 章节 ${CHAPTER.length} 张图的并发吞吐`);
console.log('并发  全部耗时   平均每张   p50      p95     MB/s   失败');
for (const limit of limits) {
  const r = await run(CHAPTER, limit);
  console.log(
    `  ${String(r.limit).padEnd(4)} ${String(r.wallS + 's').padEnd(9)} ${String(r.perImageMs + 'ms').padEnd(10)} ` +
      `${String(r.p50 + 'ms').padEnd(8)} ${String(r.p95 + 'ms').padEnd(7)} ${String(r.mbs).padEnd(6)} ${r.bad}`,
  );
}
