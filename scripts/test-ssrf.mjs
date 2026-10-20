/**
 * SSRF 防护验证
 *
 * 两部分：
 *   1. 纯函数：地址段判定、可疑主机名
 *   2. 集成：让 127.0.0.1 **通过域名白名单**，确认被地址策略拦下 ——
 *      这就是"恶意插件把 entry 填成内网地址"的真实路径，
 *      只测纯函数测不到它在代理里真的生效。
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isBlockedV4,
  isBlockedV6,
  isBlockedIp,
  isBlockedHostname,
  isHardBlockedIp,
} from '../server/ssrf.mjs';
import { pluginHostsOf } from '../server/plugins.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8877);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

console.log('\n=== 1. IPv4 段判定 ===');
for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.116.1.8', '0.0.0.0', '224.0.0.5']) {
  check(isBlockedV4(ip), `拒绝 ${ip}`);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '100.63.0.1', '100.128.0.1']) {
  check(!isBlockedV4(ip), `放行 ${ip}`);
}
check(!isBlockedV4('999.1.1.1'), '非法字面量不当它是内网（交给解析报错）');

console.log('\n=== 2. IPv6 段判定 ===');
for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::34', 'ff02::1', '::ffff:127.0.0.1']) {
  check(isBlockedV6(ip), `拒绝 ${ip}`);
}
check(!isBlockedV6('2606:4700:4700::1111'), '放行公网 IPv6');
check(isBlockedIp('127.0.0.1') && !isBlockedIp('8.8.8.8'), 'isBlockedIp 双栈分派正确');

console.log('\n=== 2b. 嵌入 IPv4 的 IPv6（mapped / NAT64 / 6to4）===');
for (const ip of ['::ffff:169.254.169.254', '::ffff:127.0.0.1', '2002:7f00:1::', '64:ff9b::a9fe:a9fe']) {
  check(isHardBlockedIp(ip), `域名档也拒绝 ${ip}`);
}
check(!isHardBlockedIp('2400:cb00::1'), '放行公网 IPv6（域名档）');

console.log('\n=== 3. 可疑主机名 ===');
for (const h of ['localhost', 'foo.localhost', 'x.internal', 'api.local', 'metadata', 'metadata.google.internal', 'nvme0']) {
  check(isBlockedHostname(h), `拒绝 ${h}`);
}
check(!isBlockedHostname('example.com'), '放行 example.com');

console.log('\n=== 3b. 插件声明的域名后缀 ===');
check(!pluginHostsOf({ imageHosts: ['com'] }).includes('com'), '拒绝单标签后缀 com');
check(!pluginHostsOf({ imageHosts: ['co.uk'] }).includes('co.uk'), '拒绝公共后缀 co.uk');
check(
  pluginHostsOf({ imageHosts: ['mangafunb.fun'] }).includes('mangafunb.fun'),
  '保留正常的 CDN 后缀 mangafunb.fun',
);

/* ── 集成：走真实代理 ───────────────────────────── */
const dbPath = join(tmpdir(), `zeno-ssrf-${Date.now()}.db`);
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  // 关键：把 127.0.0.1 放进域名白名单，且不设 ALLOW_PRIVATE_HOSTS。
  // 于是唯一还能拦下它的，只有地址策略。
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, ALLOWED_HOSTS: '127.0.0.1' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

  console.log('\n=== 4. 代理集成：白名单放行但地址被拒 ===');
  const r = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('http://127.0.0.1:80/x')}`);
  const body = await r.json().catch(() => ({}));
  check(r.status === 403, `回环地址被拒（HTTP ${r.status}）`);
  check(body.error === 'blocked address', `错误类型是 blocked address（实际 ${body.error}）`);
  check(/127\.0\.0\.1/.test(body.reason ?? ''), `理由里点出了地址：${body.reason}`);

  const meta = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
  check(meta.status === 403, `云元数据地址被拒（HTTP ${meta.status}）`);

  const localhostName = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('http://localhost:80/x')}`);
  check(localhostName.status === 403, `localhost 主机名被拒（HTTP ${localhostName.status}）`);

  console.log('\n=== 5. 显式开关仍然可用（白名单套件依赖它）===');
  console.log('  （由 run-tests.mjs 给 test-whitelist 注入 ALLOW_PRIVATE_HOSTS=1 覆盖）');
} catch (e) {
  check(false, `集成阶段异常：${e.message}`);
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
console.log(fails === 0 ? '  全部通过 — SSRF 防护有效' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
