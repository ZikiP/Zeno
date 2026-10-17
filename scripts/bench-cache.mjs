/**
 * 图片缓存这几个 sqlite 动作各自多贵
 *
 * 为什么单独量这个：一次翻页要过 50 张图，每张都走一遍 lookup，
 * 每张新图落盘后又都要 evict 一次。单次哪怕只有几百微秒，
 * 乘在"每屏"上就是可感知的差别 —— 而这类开销在浏览器里看不见，
 * 只表现为"图慢半拍"。
 *
 * 跑在**库里那份 cache_index 的真实行数**上，但写只落在临时副本上，
 * 不碰生产库。缓存目录读的是真实那一份（只 stat，不写）。
 *
 * 用法：node scripts/bench-cache.mjs
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.env.SRC_DB || join(ROOT, 'data', 'zeno.db');
const dir = mkdtempSync(join(tmpdir(), 'zeno-bench-cache-'));
const copy = join(dir, 'bench.db');
for (const s of ['', '-wal', '-shm']) {
  try {
    copyFileSync(src + s, copy + s);
  } catch {
    /* WAL/SHM 可能不存在，正常的 */
  }
}
process.env.DB_PATH = copy;

const { openDb } = await import('../server/db.mjs');
const store = await import('../server/cache-store.mjs');
const { cacheDir, cacheMaxBytes } = await import('../server/cache-config.mjs');

const db = openDb();
const rows = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM cache_index').get();
console.log(`账本行数 ${rows.n}，记账 ${Math.round(rows.b / 1048576)}MB，上限 ${Math.round(cacheMaxBytes() / 1048576)}MB，目录 ${cacheDir()}`);

const timed = (label, n, fn) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(34)} 共 ${ms.toFixed(1)}ms  每次 ${(ms / n).toFixed(3)}ms`);
  return ms / n;
};

const keys = db.prepare('SELECT key FROM cache_index LIMIT 2000').all().map((r) => r.key);
const urls = keys.map((k) => `bench://x/${k}`);

console.log('\n=== 命中一张缓存图 ===');
// lookup 的键是 URL 的 sha256，所以要造"能命中"的 URL 得反过来：
// 直接测同一份 SQL 组合的成本，用真 key 反查不出 URL，就按行为拆成三段量。
const perSelect = timed('SELECT 一行（真 key，必然命中）', 5000, (i) =>
  db.prepare('SELECT bytes, ctype FROM cache_index WHERE key = ?').get(keys[i % keys.length]),
);
const perUpdate = timed('UPDATE at（一次命中尾巴上的写）', 2000, (i) =>
  db.prepare('UPDATE cache_index SET at = ? WHERE key = ?').run(Date.now(), keys[i % keys.length]),
);
const perPrepare = timed('每次重新 prepare 同一条 SELECT', 3000, (i) =>
  openDb()
    .prepare('SELECT bytes, ctype FROM cache_index WHERE key = ?')
    .get(keys[i % keys.length]),
);
console.log(
  `  → 一条 SELECT 复用语句 ${(perSelect * 1).toFixed(3)}ms / 重新 prepare ${perPrepare.toFixed(3)}ms，差 ${(perPrepare - perSelect).toFixed(3)}ms`,
);

console.log('\n=== 每存一张图之后的尾巴 ===');
const perTotals = timed('totals()（COUNT+SUM 全表）', 200, () => store.totals());
const perScanOrder = timed('evict 的 ORDER BY at ASC 全表取行', 50, () =>
  db.prepare('SELECT key, bytes FROM cache_index ORDER BY at ASC').all(),
);

console.log('\n=== 一张 50 图的章节，服务端自己要付多少 ===');
const perHit = perSelect + perUpdate;
console.log(
  `  50 张全命中：${(perHit * 50).toFixed(1)}ms（其中写 ${((perUpdate * 50) / (perHit * 50) * 100).toFixed(0)}% 花在续访问时间的 UPDATE 上）`,
);
console.log(`  50 张全新落盘：账本扫描 ${(perTotals * 50).toFixed(1)}ms + 取行 ${(perScanOrder * 50).toFixed(1)}ms`);
