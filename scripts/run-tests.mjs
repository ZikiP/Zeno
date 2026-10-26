/**
 * 测试编排：每个套件跑在**独立端口 + 独立临时库**上。
 *
 * 存在的理由：三个测试脚本的 BASE 默认值是 8788，也就是生产端口，
 * 而且它们自己不清理数据。直接 `npm test` 会把假插件写进真实部署的库，
 * 假插件的域名还会被推导进抓取白名单。test-multidevice 的计数断言
 * 也会被 test-sync 留下的数据带偏 —— 之前就是这么误判成 3 个失败的。
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 端口基线：每个套件拿 BASE+i（16 套 → 45000~45015，个别套件还占一个 +1 的假源站）。
 *
 * 为什么是 45000 而不是原来那个 8899：这台 Windows 的动态端口段量出来是
 * `netsh int ipv4 show dynamicport tcp` → 启动端口 1024、端口数 13977，也就是
 * **1024~15000 整段都是系统临时端口**，测试端口全在里面。被某个应用的出站连接
 * 临时占掉时，跑器起的 server bind 不上，报的是「起不来：服务端提前退出（code 1）」，
 * 看着像刚改的代码弄坏了启动 —— 2026-10-19 和 2026-10-20 各误判过一次。
 * 撞的时候 `netstat -ano | grep :8899` 往往已经空了（那是瞬时占用），所以"没人用"
 * 不能用来排除这个原因。要换就换到 15000 以上。
 */
const BASE_PORT = Number(process.env.TEST_PORT_BASE || 45000);

const ALL_SUITES = [
  'test-sync.mjs',
  'test-multidevice.mjs',
  'test-deletes.mjs',
  'test-whitelist.mjs',
  'test-ssrf.mjs',
  'test-auth.mjs',
  'test-cache.mjs',
  'test-warm.mjs',
  'test-devices.mjs',
  // 直接测 src/ 里的纯逻辑（不碰 DOM、不碰网络），所以用 tsx 跑而不是编译产物
  'test-validation.ts',
  'test-parse.ts',
  'test-updates.ts',
  'test-pull.ts',
  'test-enhance.ts',
  'test-paging.ts',
  'test-prefs.ts',
  'test-enabled.ts',
];
const suites = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => (/\.(mjs|ts)$/.test(s) ? s : `test-${s}.mjs`))
  : ALL_SUITES;

/** .ts 套件直接跑 src 里的源码，需要 tsx 的 CLI。走文件路径而不是 .bin 里的 shim，Windows 上少一层 shell 解析 */
const TSX_CLI = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(port, dbPath, extraEnv = {}) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ALLOWED_HOSTS: '', ...extraEnv },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`服务端提前退出（code ${child.exitCode}）`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(700) });
      if (r.ok) {
        const h = await r.json();
        // 断言隔离生效，否则后面所有「白名单为空」的检查都是假的
        if (h.plugins !== 0 || h.allowedHosts.length !== 0) {
          throw new Error(`隔离库不干净：plugins=${h.plugins} hosts=${h.allowedHosts.length}`);
        }
        return { child, base };
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`服务端 ${port} 启动超时`);
}

async function stopServer(child, dbPath) {
  child.kill();
  await sleep(300); // 等 WAL/SHM 释放，Windows 上不等一下删不掉
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* 已被释放或本来就不在 */
    }
  }
}

let failed = 0;
/** 自己管理服务端生命周期的套件（需要特殊 env，跑器再套一层反而干扰） */
const SELF_HOSTED = new Set([
  'test-ssrf.mjs',
  'test-auth.mjs',
  'test-cache.mjs',
  'test-warm.mjs',
  'test-devices.mjs',
]);

for (const [i, suite] of suites.entries()) {
  const port = BASE_PORT + i;
  const dbPath = resolve(tmpdir(), `zeno-test-${port}-${Date.now()}.db`);
  console.log(`\n${'='.repeat(56)}\n${suite}  (port ${port}, 独立临时库)\n${'='.repeat(56)}`);

  let srv;
  if (!SELF_HOSTED.has(suite)) {
    try {
      // 白名单套件的假源站跑在 127.0.0.1，会被 SSRF 防护拦下 —— 那是它在
      // 生产环境该有的行为，测试里必须显式放行，否则测不到"转发真的发生"。
      const extra = suite === 'test-whitelist.mjs' ? { ALLOW_PRIVATE_HOSTS: '1' } : {};
      srv = await startServer(port, dbPath, extra);
    } catch (e) {
      console.error(`  [X] 起不来：${e.message}`);
      failed++;
      continue;
    }
  }

  const code = await new Promise((res) => {
    /* .ts 套件跑 src 里的真源码，要经 tsx；.mjs 由 node 直接执行 */
    const argv = suite.endsWith('.ts') ? [TSX_CLI, `scripts/${suite}`] : [`scripts/${suite}`];
    const p = spawn(process.execPath, argv, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...(srv ? { BASE: srv.base } : {}) },
    });
    p.on('exit', (c) => res(c ?? 1));
  });

  if (srv) await stopServer(srv.child, dbPath);
  if (code !== 0) {
    console.log(`  [X] ${suite} 退出码 ${code}`);
    failed++;
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(failed === 0 ? '  全部套件通过' : `  ${failed}/${suites.length} 个套件失败`);
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
