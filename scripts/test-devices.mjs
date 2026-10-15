/**
 * 设备标识与角色
 *
 * 自己起服务端：要测「从别的地址进来算客户端」和「老库补列」，
 * 都得控制端口和 DB_PATH，跑器再套一层反而碍事。
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8856);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'zeno-devices-'));

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(dbPath) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, SYNC_TOKEN: '' },
  });
  return { child };
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(700) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

async function push(body, headers = {}) {
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return r.status;
}
const clients = async () => {
  const r = await fetch(`${BASE}/api/sync/clients`);
  const b = await r.json();
  return Object.fromEntries(b.clients.map((c) => [c.device_id, c]));
};
/** 中文名字要走编码头 —— 不编码 fetch 会直接抛 Invalid header value */
const labelHeader = (v) => encodeURIComponent(v);

/* ── 1. 新库：上报、保留、判定 ── */

const dbPath = join(DIR, 'a.db');
const s1 = start(dbPath);
try {
  if (!(await waitUp())) throw new Error('服务端起不来');

  console.log('\n=== 1. 设备名与角色随同步上报 ===');
  const code = await push(
    { deviceId: 'dev-loopback', seq: 0 },
    { 'X-Device-Label': labelHeader('手机 · 安卓'), 'X-Client-Host': 'localhost' },
  );
  check(code === 200, '推送成功');
  let rows = await clients();
  check(rows['dev-loopback']?.label === '手机 · 安卓', '中文名从编码头里解回来了', rows['dev-loopback']?.label);
  check(rows['dev-loopback']?.role === 'server', '回环地址进来的算服务端本机', rows['dev-loopback']?.role);

  console.log('\n=== 2. 名字不会被一次沉默抹掉 ===');
  await push({ deviceId: 'dev-loopback', seq: 0 }); // 老客户端：不带任何新头
  rows = await clients();
  check(rows['dev-loopback']?.label === '手机 · 安卓', '没带 label 时保留原来的名字');
  check(rows['dev-loopback']?.role === 'server', '同理，角色也不会被抹成空');

  console.log('\n=== 3. 非回环来源要算客户端 ===');
  // 需要一个不是 127.0.0.1 的本机地址。没有可用网卡（CI）就只能跳过这条
  const { networkInterfaces, hostname } = await import('node:os');
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.address.startsWith('127.'));
  if (!lan) {
    console.log('  [SKIP] 这台机器没有非回环 IPv4，客户端那条判不了');
  } else {
    const viaLan = `http://${lan.address}:${PORT}`;
    await fetch(`${viaLan}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Host': lan.address },
      body: JSON.stringify({ deviceId: 'dev-lan', seq: 0 }),
    });
    await fetch(`${viaLan}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Host': hostname() },
      body: JSON.stringify({ deviceId: 'dev-selfname', seq: 0 }),
    });
    rows = await clients();
    check(rows['dev-lan']?.role === 'client', '从局域网地址进来、host 也对不上 → 客户端', rows['dev-lan']?.role);
    check(
      rows['dev-selfname']?.role === 'server',
      '上报的 hostname 就是服务端自己的主机名 → 服务端本机',
      rows['dev-selfname']?.role,
    );
  }
} finally {
  s1.child.kill();
  await sleep(400);
}

/* ── 4. 老库补列 ── */

console.log('\n=== 4. 老库升级要补上 label / role 两列 ===');
const oldPath = join(DIR, 'old.db');
{
  const d = new DatabaseSync(oldPath);
  // 手工搭一份"没有这两列"的旧表，模拟部署过一版的机器
  d.exec(`CREATE TABLE client_state (
    device_id TEXT PRIMARY KEY,
    last_pulled_seq INTEGER NOT NULL DEFAULT 0,
    last_push_at INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT
  )`);
  d.prepare('INSERT INTO client_state (device_id, last_push_at, user_agent) VALUES (?, ?, ?)').run(
    'dev-old',
    Date.now(),
    '旧版本上报的',
  );
  d.close();
}
const s2 = start(oldPath);
try {
  const up = await waitUp();
  check(up, '带着旧库也能正常启动（补列没把 openDb 弄崩）');
  if (up) {
    const rows = await clients();
    check(!!rows['dev-old'], '旧行还在，没被迁移弄丢');
    check(rows['dev-old']?.label === null && rows['dev-old']?.role === null, '旧行的新列是空的而不是报错');
    await push({ deviceId: 'dev-old', seq: 0 }, { 'X-Device-Label': labelHeader('补名') });
    const after = await clients();
    check(after['dev-old']?.label === '补名', '补完列就能正常写入名字', after['dev-old']?.label);
  }
} finally {
  s2.child.kill();
  await sleep(400);
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 还占着就交给系统清理 */
  }
}

console.log('\n' + '='.repeat(56));
if (fails) {
  console.log(`  ${fails} 项失败`);
  process.exit(1);
}
console.log('  全部通过 — 设备标识与角色正确');
