/**
 * 部署/重启之后还要不要再解一次浏览器质询
 *
 * 空闲关掉那一条已经由 bench-cold-session 量过（13s → 1.4s）。这里量的是更常
 * 撞上的那条：**进程被硬杀**。Windows 上部署就是 TerminateProcess 一次，信号处理
 * 函数一次也不会跑（实测：kill 之后会话目录是空的），所以会话必须"渲染过程中就存"。
 * 不这么做的代价也实测过：每次重启后的第一个 browser 请求重新解质询，9~14s，
 * 而界面上 `/api/health` 一直是绿的。
 *
 * 用法：node scripts/verify-session-keep.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_PORT || 8994);
const BASE = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'zeno-session-'));
const db = join(dir, 'keep.db');
for (const s of ['', '-wal', '-shm']) {
  try {
    copyFileSync(join(ROOT, 'data', 'zeno.db') + s, db + s);
  } catch {
    /* 可能不存在 */
  }
}

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const start = () =>
  spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
    // 空闲窗口放到十分钟：这条要量的就是"进程退出"这条路，别让空闲关浏览器先插一脚
    env: { ...process.env, PORT: String(PORT), DB_PATH: db, BROWSER_IDLE_MS: '600000' },
  });

const waitUp = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const render = async (slug) => {
  const t0 = performance.now();
  const r = await fetch(
    `${BASE}/api/proxy?url=${encodeURIComponent(`https://www.baozimh.com/comic/${slug}`)}` +
      '&mode=browser&waitFor=a.comics-chapters__item&timeoutMs=45000',
    { signal: AbortSignal.timeout(60_000) },
  );
  const html = await r.text();
  return {
    ms: performance.now() - t0,
    status: r.status,
    chapters: (html.match(/<a[^>]*comics-chapters__item/g) || []).length,
  };
};

let child = start();
if (!(await waitUp())) {
  console.error('临时服务端起不来');
  process.exit(1);
}

console.log('\n=== 同一个进程里，会话还在 ===');
const cold = await render('woduzishengji-duburedicestudio');
console.log(`  第一次 ${(cold.ms / 1000).toFixed(2)}s  章节 ${cold.chapters}`);
const warm = await render('wosiqiandebaiwuyu-deyeanzi');
console.log(`  第二次 ${(warm.ms / 1000).toFixed(2)}s  章节 ${warm.chapters}  ← 会话复用，应该是 1s 级`);
check(warm.ms < 4000, `会话还在时不用重解质询（${(warm.ms / 1000).toFixed(2)}s）`);

console.log('\n=== 硬杀进程（Windows 上部署就是这样），再当一次"重启完" ===');
child.kill();
await new Promise((r) => child.on('exit', r));
const sessDir = join(dir, 'render-sessions');
const files = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith('.json')) : [];
check(files.length > 0, `渲染过程中落了 ${files.length} 份会话文件（不靠退出钩子）`);

child = start();
check(await waitUp(), '重启完成');
const afterRestart = await render('wodetaizifei-xilindefangzi');
console.log(`  重启后第一次 ${(afterRestart.ms / 1000).toFixed(2)}s  章节 ${afterRestart.chapters}`);
check(afterRestart.chapters > 10, `内容照常解得出来（${afterRestart.chapters} 条章节）`);
// 全新解一次质询实测 9~14s；带着旧 cookie 只需重开浏览器（~2s 级）
check(afterRestart.ms < 6000, `重启后没重新解质询（${(afterRestart.ms / 1000).toFixed(2)}s < 6s）`);

child.kill();
await new Promise((r) => setTimeout(r, 300));
console.log(fails ? `\n${fails} 条没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
