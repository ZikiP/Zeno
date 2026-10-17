/**
 * 改动前后的取图路径对比：一边跑生产那份代码，一边跑工作副本的新代码
 *
 * 为什么要在旁边起一个临时服务而不是直接改现网：这一条省的是每次命中的
 * 一次 sqlite 写，量级是毫秒，现网的抖动（上游、别的标签页）比它大一个
 * 数量级。只有两边**同时**打同一批已缓存的图、交替多轮，才分得出来。
 *
 * 临时服务用的是生产库的一份副本（账本要真行数、图要真文件），
 * 端口另开，不碰 8788。
 *
 * 用法：node scripts/bench-cache-hit.mjs [张数] [轮数]
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] || 50);
const ROUNDS = Number(process.argv[3] || 4);
const PORT = Number(process.env.VERIFY_PORT || 8991);
const OLD = 'http://127.0.0.1:8788';
const NEW = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'zeno-bench-hit-'));
const dbCopy = join(dir, 'cache-copy.db');
for (const s of ['', '-wal', '-shm']) {
  try {
    copyFileSync(join(ROOT, 'data', 'zeno.db') + s, dbCopy + s);
  } catch {
    /* WAL/SHM 不一定存在 */
  }
}

const child = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbCopy },
});
const bye = (code) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 已经被释放 */
  }
  process.exit(code);
};
process.on('SIGINT', () => bye(130));

for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`${NEW}/api/health`, { signal: AbortSignal.timeout(500) });
    if (r.ok) break;
  } catch {
    /* 还没起来 */
  }
  if (child.exitCode !== null) {
    console.error(`临时服务端提前退出（code ${child.exitCode}）`);
    bye(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}

const SLUG = 'woduzishengji-duburedicestudio';
const SUB = '112-ur5o';
const pathFor = (i) =>
  `/api/proxy?url=${encodeURIComponent(`https://s2.bzcdn.net/scomic/${SLUG}/0/${SUB}/${i}.jpg`)}`;

function makeAgent(base) {
  const u = new URL(base);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  return {
    get(path) {
      return new Promise((res, rej) => {
        const t0 = performance.now();
        http
          .get({ host: u.hostname, port: u.port, path, agent }, (r) => {
            let bytes = 0;
            r.on('data', (c) => (bytes += c.length));
            r.on('end', () => res({ ms: performance.now() - t0, status: r.statusCode, bytes }));
          })
          .on('error', rej);
      });
    },
    close: () => agent.destroy(),
  };
}

const oldC = makeAgent(OLD);
const newC = makeAgent(NEW);

await oldC.get('/api/health');
await newC.get('/api/health'); // 先建好连接，别让握手混进第一轮

const runRound = async (c) => {
  const t0 = performance.now();
  let ok = 0;
  const times = [];
  for (let i = 1; i <= N; i++) {
    const r = await c.get(pathFor(i));
    if (r.status === 200) ok++;
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  return { total: performance.now() - t0, ok, median: times[Math.floor(N / 2)] };
};

const oldTotals = [];
const newTotals = [];
console.log(`=== ${N} 张已缓存的图，串行，交替 ${ROUNDS} 轮 ===`);
for (let i = 0; i < ROUNDS; i++) {
  const o = await runRound(oldC);
  const n = await runRound(newC);
  oldTotals.push(o.total);
  newTotals.push(n.total);
  console.log(
    `  第${i + 1}轮  旧 ${(o.total / 1000).toFixed(3)}s (中位 ${o.median.toFixed(2)}ms, 命中 ${o.ok}/${N})` +
      `   新 ${(n.total / 1000).toFixed(3)}s (中位 ${n.median.toFixed(2)}ms, 命中 ${n.ok}/${N})`,
  );
}
const avg = (v) => v.reduce((a, b) => a + b, 0) / v.length;
// 第一轮含 JIT/连接预热，丢掉再算平均
const drop1 = (v) => (v.length > 2 ? v.slice(1) : v);
const ao = avg(drop1(oldTotals));
const an = avg(drop1(newTotals));
console.log(
  `\n平均（去掉首轮）：旧 ${(ao / 1000).toFixed(3)}s  新 ${(an / 1000).toFixed(3)}s  ` +
    `每张 ${(ao / N).toFixed(2)} → ${(an / N).toFixed(2)}ms，省 ${(((ao - an) / ao) * 100).toFixed(0)}%`,
);

oldC.close();
newC.close();
child.kill();
await new Promise((r) => setTimeout(r, 300));
bye(0);
