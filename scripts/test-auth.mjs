/**
 * 鉴权验证（自管服务端生命周期）
 *
 * 必须单独一个套件：它要的是 **设了 SYNC_TOKEN** 的服务端，
 * 而其它套件都跑在未设令牌的实例上 —— 也就永远测不到
 * 「代理漏了 auth()」这类问题。
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8878);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-abc123';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbPath = join(tmpdir(), `zeno-auth-${Date.now()}.db`);
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    SYNC_TOKEN: TOKEN,
    ALLOWED_HOSTS: 'example.com',
  },
});

const H = (extra = {}) => ({
  'Content-Type': 'application/json',
  ...(extra.bearer ? { Authorization: `Bearer ${extra.bearer}` } : {}),
});

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(700) })).ok;
    } catch {
      await sleep(200);
    }
  }
  if (!up) throw new Error('测试服务端起不来');

  console.log('\n=== 1. 同步端点要令牌 ===');
  const pullNoAuth = await fetch(`${BASE}/api/sync/pull?since=0&deviceId=x`);
  check(pullNoAuth.status === 401, `无令牌 pull → 401（${pullNoAuth.status}）`);
  const pullAuth = await fetch(`${BASE}/api/sync/pull?since=0&deviceId=x`, {
    headers: H({ bearer: TOKEN }),
  });
  check(pullAuth.status === 200, `带令牌 pull → 200（${pullAuth.status}）`);
  const badTok = await fetch(`${BASE}/api/sync/pull?since=0&deviceId=x`, {
    headers: H({ bearer: TOKEN + 'x' }),
  });
  check(badTok.status === 401, `错令牌 → 401（${badTok.status}）`);

  console.log('\n=== 2. 代理也要令牌（这里以前漏了 auth()）===');
  const proxyNoAuth = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('https://example.com/')}`);
  check(
    proxyNoAuth.status === 401,
    `白名单内 + 无令牌 → 401 而不是被当开放中继（${proxyNoAuth.status}）`,
  );
  const proxyAuth = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('https://example.com/')}`, {
    headers: H({ bearer: TOKEN }),
  });
  check(
    proxyAuth.status !== 401,
    `白名单内 + 带令牌 → 不再被鉴权挡住（${proxyAuth.status}）`,
  );

  console.log('\n=== 3. health 的敏感字段按令牌分级 ===');
  const hPub = await (await fetch(`${BASE}/api/health`)).json();
  check(hPub.ok === true, '无令牌仍能看到服务活着');
  check(hPub.dbPath === undefined, `无令牌看不到 dbPath（${JSON.stringify(hPub.dbPath)}）`);
  check(
    hPub.allowedHosts === undefined,
    `无令牌看不到白名单内容（等于"你在读哪些站点"）`,
  );
  check(hPub.allowedHostsCount === 1, `无令牌能看到计数（${hPub.allowedHostsCount}）`);

  const hAuth = await (
    await fetch(`${BASE}/api/health`, { headers: H({ bearer: TOKEN }) })
  ).json();
  check(typeof hAuth.dbPath === 'string', `带令牌看得到 dbPath（排查 cwd 要用）`);
  check(
    Array.isArray(hAuth.allowedHosts) && hAuth.allowedHosts.includes('example.com'),
    `带令牌看得到白名单：${JSON.stringify(hAuth.allowedHosts)}`,
  );
} catch (e) {
  check(false, `异常：${e.message}`);
} finally {
  child.kill();
  await sleep(400);
  for (const s of ['', '-wal', '-shm']) {
    try {
      rmSync(dbPath + s, { force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 鉴权覆盖到位' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
