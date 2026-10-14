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
const BASE_PORT = Number(process.env.TEST_PORT_BASE || 8899);

const ALL_SUITES = ['test-sync.mjs', 'test-multidevice.mjs', 'test-whitelist.mjs'];
const suites = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => (s.endsWith('.mjs') ? s : `test-${s}.mjs`))
  : ALL_SUITES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(port, dbPath) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ALLOWED_HOSTS: '' },
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
for (const [i, suite] of suites.entries()) {
  const port = BASE_PORT + i;
  const dbPath = resolve(tmpdir(), `zeno-test-${port}-${Date.now()}.db`);
  console.log(`\n${'='.repeat(56)}\n${suite}  (port ${port}, 独立临时库)\n${'='.repeat(56)}`);

  let srv;
  try {
    srv = await startServer(port, dbPath);
  } catch (e) {
    console.error(`  [X] 起不来：${e.message}`);
    failed++;
    continue;
  }

  const code = await new Promise((res) => {
    const p = spawn(process.execPath, [`scripts/${suite}`], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, BASE: srv.base },
    });
    p.on('exit', (c) => res(c ?? 1));
  });

  await stopServer(srv.child, dbPath);
  if (code !== 0) {
    console.log(`  [X] ${suite} 退出码 ${code}`);
    failed++;
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(failed === 0 ? '  全部套件通过' : `  ${failed}/${suites.length} 个套件失败`);
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
