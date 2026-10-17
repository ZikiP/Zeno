/**
 * 过代理取图的实测吞吐（打的是部署实例，不是本地起的假服务）
 *
 * 为什么不用 global fetch 量：**实测 fetch 每次要多付 10ms**（同样打 127.0.0.1
 * 的 /api/health，fetch 13.7ms 而带 keepAlive 的 http.Agent 3.2ms），
 * 于是"每张图 30ms"里三分之二是量具自己的开销。要量服务端就得把客户端摊平，
 * 这里用 node:http + 一个常驻连接，串行也照样是连接复用。
 *
 * 用法：node scripts/bench-images-live.mjs [张数]
 */
import http from 'node:http';

const BASE = process.env.ZENO_PROXY || 'http://127.0.0.1:8788';
const N = Number(process.argv[2] || 50);
const CONC = Number(process.env.CONC || 8);
const origin = new URL(BASE);

/** 这一章的图早就进过盘了（浏览器里翻过），拿来量命中路径 */
const SLUG = 'woduzishengji-duburedicestudio';
const DIR = '112-ur5o';
const paths = Array.from(
  { length: N },
  (_, i) =>
    `/api/proxy?url=${encodeURIComponent(`https://s2.bzcdn.net/scomic/${SLUG}/0/${DIR}/${i + 1}.jpg`)}`,
);

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function get(path) {
  return new Promise((resolveP, rejectP) => {
    const t0 = performance.now();
    const req = http.get(
      { host: origin.hostname, port: origin.port, path, agent },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => (bytes += c.length));
        res.on('end', () => resolveP({ ms: performance.now() - t0, bytes, status: res.statusCode }));
      },
    );
    req.on('error', rejectP);
  });
}

console.log(`=== 参照：/api/health（空端到端是什么价）===`);
const warm = await get('/api/health');
const probe = [];
for (let i = 0; i < 20; i++) probe.push((await get('/api/health')).ms);
probe.sort((a, b) => a - b);
console.log(`  中位 ${probe[10].toFixed(2)}ms（第一次含建连 ${warm.ms.toFixed(1)}ms）`);

console.log(`\n=== 串行 ${N} 张（模拟"一张一张要"的客户端）===`);
let t0 = performance.now();
const seq = [];
for (const p of paths) seq.push(await get(p));
const seqTotal = performance.now() - t0;
const bad = seq.filter((s) => s.status !== 200);
const sorted = seq.map((s) => s.ms).sort((a, b) => a - b);
console.log(
  `  总 ${(seqTotal / 1000).toFixed(2)}s | 每张均值 ${(seqTotal / N).toFixed(2)}ms | ` +
    `中位 ${sorted[Math.floor(N / 2)].toFixed(2)}ms | 最慢 ${sorted[N - 1].toFixed(2)}ms | 失败 ${bad.length}`,
);

console.log(`\n=== 并发 ${CONC} 张一批（阅读页实际就是这么发的）===`);
t0 = performance.now();
for (let i = 0; i < N; i += CONC) await Promise.all(paths.slice(i, i + CONC).map(get));
const parTotal = performance.now() - t0;
const bytes = seq.reduce((a, s) => a + s.bytes, 0);
console.log(
  `  总 ${(parTotal / 1000).toFixed(2)}s | ${Math.round(bytes / 1024)}KB | ` +
    `吞吐 ${(bytes / 1048576 / (parTotal / 1000)).toFixed(2)}MB/s`,
);
agent.destroy();
