/**
 * 「离开三分钟再回来」要付几次浏览器质询
 *
 * 现网实测：质询是一个渲染浏览器会话只付一次的代价（9.3s），之后每次详情
 * 渲染 1.0~1.2s。但渲染浏览器有空闲就关（BROWSER_IDLE_MS，默认 180s），
 * 关掉等于把会话 cookie 一起丢掉 —— 于是"去倒了杯水再回来翻开一本书"
 * 又要付一次 9 秒。这条量的就是这个代价多久出现一次。
 *
 * 临时服务把空闲窗口调短到 1.5s 才好在几分钟内跑完；生产默认 180s。
 *
 * 用法：node scripts/bench-cold-session.mjs
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_PORT || 8992);
const IDLE_MS = Number(process.env.BROWSER_IDLE || 1500);

const dir = mkdtempSync(join(tmpdir(), 'zeno-bench-cold-'));
const dbCopy = join(dir, 'cold.db');
for (const s of ['', '-wal', '-shm']) {
  try {
    copyFileSync(join(ROOT, 'data', 'zeno.db') + s, dbCopy + s);
  } catch {
    /* 可能不存在 */
  }
}

const child = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbCopy,
    BROWSER_IDLE_MS: String(IDLE_MS),
    BROWSER_CHALLENGE_MS: '20000',
  },
});
const bye = (code) => {
  child.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  process.exit(code);
};
process.on('SIGINT', () => bye(130));

const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) })).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const render = async (slug) => {
  const u =
    `${BASE}/api/proxy?url=${encodeURIComponent(`https://www.baozimh.com/comic/${slug}`)}` +
    '&mode=browser&waitFor=a.comics-chapters__item&timeoutMs=45000';
  const t0 = performance.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
  const html = await r.text();
  const ms = performance.now() - t0;
  const real = (html.match(/<a[^>]*comics-chapters__item/g) || []).length;
  return {
    ms,
    status: r.status,
    len: html.length,
    chapters: real,
    challenged: /正在验证浏览器|__gatekeeper_challenge|data-state="checking"/i.test(html),
  };
};

const line = (label, r) =>
  console.log(
    `${label.padEnd(38)} ${(r.ms / 1000).toFixed(2)}s  ${r.status} ${(String(r.len) + 'B').padStart(9)}` +
      `  真章节 ${String(r.chapters).padStart(3)}  质询壳=${r.challenged}`,
  );

/** 每本只用一次：渲染缓存 90 秒内会把同一个 slug 直接送出来，量不到真东西 */
const SLUGS = [
  'woduzishengji-duburedicestudio',
  'wosiqiandebaiwuyu-deyeanzi',
  'wodetaizifei-xilindefangzi',
  'chihuowopashui-fuzhouwoaidongman',
  'mianyangmianyangwoaini-woxiangchishousi',
  'wojiademaoxiangwogaobailiao-wodebaobeidu',
];

console.log(`空闲窗口压到 ${IDLE_MS}ms（生产默认 180000ms）\n`);
const cold = await render(SLUGS[0]);
line('第 1 次（浏览器全新启动 + 解质询）', cold);

const warm = await render(SLUGS[1]);
line('第 2 次（会话还在）', warm);

await new Promise((r) => setTimeout(r, IDLE_MS + 1500));
const afterIdle = await render(SLUGS[2]);
line('空闲关掉之后再开（cookie 没了）', afterIdle);

await new Promise((r) => setTimeout(r, IDLE_MS + 1500));
const again = await render(SLUGS[3]);
line('再空一次再开', again);

console.log(
  `\n会话还在 ${(warm.ms / 1000).toFixed(1)}s，空闲重起 ${(afterIdle.ms / 1000).toFixed(1)}s / ${(again.ms / 1000).toFixed(1)}s` +
    `  —— 差 ${((afterIdle.ms - warm.ms) / 1000).toFixed(1)}s，这就是"过几分钟再回来"的税`,
);
bye(0);
