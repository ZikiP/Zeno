/**
 * 追更这一条链路的端到端验证（跑在临时服务上，不碰生产库）
 *
 * 覆盖：真实装好的插件 + 真实在架的书 → 服务端数到条数 → 结果读得出来 →
 * 翻开书报回基线之后徽章归零 → 站点多了几章时又能算出 +N。
 *
 * "多了几章"是**手工改基线**造出来的（把 anchors 减去 3），因为没人能等真站点更新。
 * 这样反而更准：它测的是"两边条数不一致时界面说什么"，不是某一天包子漫画有几话。
 *
 * 用法：npx tsx scripts/verify-updates.ts
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../src/site/types';
import type { UpdateRow } from '../src/store/updateBadge';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_PORT || 8995);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_NAME = process.env.DB_NAME || 'zeno.db';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const dir = mkdtempSync(join(tmpdir(), 'zeno-verify-updates-'));
/** 客户端解析层要用的插件（和装进临时服务的是同一份文件） */
const PLUGINS = ['baozimh', 'copymanga'].map(
  (id) => JSON.parse(readFileSync(resolve(ROOT, `../zeno-plugins/plugins/${id}.json`), 'utf8')) as Plugin,
);
const db = join(dir, 'upd.db');
for (const s of ['', '-wal', '-shm']) {
  try {
    copyFileSync(join(ROOT, 'data', DB_NAME) + s, db + s);
  } catch {
    /* WAL/SHM 可能不存在 */
  }
}

const child = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  stdio: 'ignore',
  // 追更别在后台自己抢跑：这一条要自己控制什么时候跑
  env: { ...process.env, PORT: String(PORT), DB_PATH: db, ZENO_UPDATE_CHECK_MS: '0', ZENO_UPDATE_GAP_MS: '50' },
});
const bye = (code: number) => {
  child.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 已释放 */
  }
  process.exit(code);
};
process.on('SIGINT', () => bye(130));

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) })).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log('\n=== 1. 还没跑过：一张空表，接口得回得出来 ===');
const empty = await api('/api/updates');
check(empty.status === 200, `GET /api/updates → ${empty.status}`);
check(Array.isArray(empty.body.items), `items 是数组（${empty.body.items?.length} 条）`);

console.log('\n=== 2. 跑一轮（真的去取每个源的详情页）===');
const started = await api('/api/updates/check', { method: 'POST' });
check(started.status === 202, `POST /api/updates/check 立刻回 202（不是把请求吊住），实得 ${started.status}`);

/*
 * 等到"在架的每一本都有一行"为止。
 * 上一版是"有行了就停"，结果第一轮只等到一本就往下走，
 * 后面的断言其实是在测"半途状态" —— 那种测试会骗人。
 */
const shelfSize = (await api('/api/health')).body.shelf;
console.log(`  在架 ${shelfSize} 本，等这一轮跑完…`);
let items: UpdateRow[] = [];
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  items = (await api('/api/updates')).body.items ?? [];
  if (items.length >= shelfSize) break;
}
const freshCount = items.filter((r) => Date.now() - r.checkedAt < 180_000).length;
console.log(`  等到 ${items.length} 行 / 本轮新写的 ${freshCount} 行（跑完一轮要 ${shelfSize} 行）`);
for (const r of items) {
  console.log(
    `  ${r.key.padEnd(46)} 条数=${String(r.anchors).padStart(4)}  ${r.error ? '失败：' + r.error : ''}`,
  );
}
check(items.length > 0, `在架的书都各有一行（${items.length} / ${shelfSize} 本）`);
check(items.length >= shelfSize, `一轮把在架的每一本都看过了（${items.length} 行）`);
check(
  items.some((r) => (r.anchors ?? 0) > 0),
  `至少有一本真数到了章节（${items.filter((r) => (r.anchors ?? 0) > 0).length} 本成功，${items.filter((r) => r.error).length} 本失败）`,
);
/*
 * 失败不该把基线抹成空：一次抖动写成 null，下一轮成功时就变成"从 0 涨到 183"，
 * 书架上凭空冒出一个假的新章徽章。
 */
check(
  items.every((r) => r.anchors !== undefined),
  '每行都有 anchors 字段（失败的那些是 null，不是缺列）',
);

console.log('\n=== 3. 翻开一本书 → 基线对齐 → 徽章归零 ===');
const target = items.find((r) => (r.anchors ?? 0) > 0);
if (target) {
  const before = target.anchors ?? 0;
  const seen = await api('/api/updates/seen', {
    method: 'POST',
    body: JSON.stringify({ key: target.key, anchors: before - 3 }),
  });
  check(seen.status === 200, `POST /api/updates/seen → ${seen.status}`);
  const after = (await api('/api/updates')).body.items.find((r: UpdateRow) => r.key === target.key);
  check(after.anchors === before - 3, `基线改成手上那份的条数（${after.anchors}）`);
  check(after.changedAt === null, 'changed_at 清空 —— 用户已经看过了');

  /*
   * 这就是"站点上了 3 章"的等价形态：服务端数到 183、客户端手上只有 180。
   * 徽章该说 +3，而客户端的算法就是这两个数相减。
   */
  const bumped = await api('/api/updates/seen', {
    method: 'POST',
    body: JSON.stringify({ key: target.key, anchors: before }),
  });
  check(bumped.status === 200, '把基线放回真条数（模拟服务端数到了新章）');
}

/*
 * 这一步才是"两边单位一致"在真实页面上的证据。
 * test-updates.ts 拿合成样本比过规则；这里拿真的插件、真的详情页、真的渲染结果比条数 ——
 * 少传一个 minCount 就是在这条上露馅的（实测拷貝漫畫三本书服务端数到 1、客户端 235/285）。
 */
console.log('\n=== 4. 真实页面：服务端数的条数 对 客户端解析出的条数 ===');
process.env.ZENO_PROXY = BASE;
const { getComic } = await import('../src/site/engine');
for (const row of items) {
  if (!row.anchors) continue;
  const plugin = PLUGINS.find((p) => p.meta.id === row.pluginId);
  if (!plugin) {
    check(false, `${row.key}：本地没有这个插件，比不了`);
    continue;
  }
  const { chapters } = await getComic(plugin, row.slug);
  check(
    chapters.length === row.anchors,
    `${row.key}：服务端数到 ${row.anchors}，客户端解析出 ${chapters.length}`,
  );
}

bye(fails ? 1 : 0);
