/**
 * 同步 API 往返测试
 *
 * 验证：
 *   1. 推送 → 拉取，数据完整回来
 *   2. 幂等：同样数据推两次，第二次不应产生变更
 *   3. 冲突：两边都改同一条，时间戳新的胜
 *   4. 已读完的进度不被小值覆盖
 *   5. 静态文件与 SPA 回退
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

async function api(path, opts) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return { status: r.status, body: await r.json() };
}

console.log('\n=== 1. 推送 + 拉取 ===');
const push = await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'phone',
    seq: 0,
    plugins: [
      {
        id: 'baozimanga',
        origin: 'imported',
        data: JSON.stringify({ format: 'zeno-plugin@1', meta: { id: 'baozimanga', name: '包子漫画' } }),
        updatedAt: 1000,
      },
    ],
    shelf: [
      { pluginId: 'baozimanga', slug: 'abc', title: '测试漫画', cover: 'http://x/c.jpg', addedAt: 1000, updatedAt: 1000 },
    ],
    positions: [
      { pluginId: 'baozimanga', slug: 'abc', chapterId: '0_1', percent: 42, updatedAt: 1000 },
    ],
    lastChapter: [
      { pluginId: 'baozimanga', slug: 'abc', chapterId: '0_1', updatedAt: 1000 },
    ],
    bookmarks: [
      { key: 'baozimanga/abc/0_1/3', pluginId: 'baozimanga', slug: 'abc', chapterId: '0_1', page: 3, percent: 30, createdAt: 1000, updatedAt: 1000, note: '这一页画得好看' },
    ],
    settings: [{ key: 'themeMode', value: '"dark"', updatedAt: 1000 }],
  }),
});
check(push.status === 200, `推送 200（收到 ${JSON.stringify(push.body?.applied?.total ?? {})}）`);
check(push.body?.applied?.total === 6, `接受 6 项变更，实际 ${push.body?.applied?.total}`);

const pull = await api('/api/sync/pull?since=0&deviceId=tablet');
check(pull.body.plugins.length === 1, `插件回读 ${pull.body.plugins.length} 条`);
check(pull.body.shelf.length === 1, `书架回读 ${pull.body.shelf.length} 条`);
check(pull.body.positions.length === 1, `进度回读 ${pull.body.positions.length} 条`);
check(pull.body.bookmarks.length === 1, `书签回读 ${pull.body.bookmarks.length} 条`);
check(pull.body.bookmarks[0]?.note === '这一页画得好看', '笔记内容保真');
check(pull.body.settings.length === 1, `设置回读 ${pull.body.settings.length} 条`);
check(pull.body.seq > 0, `变更序号 ${pull.body.seq}`);

console.log('\n=== 2. 幂等：重推同样数据 ===');
const again = await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'phone',
    seq: pull.body.seq,
    plugins: [{ id: 'baozimanga', origin: 'imported', data: '{}', updatedAt: 1000 }],
    shelf: [{ pluginId: 'baozimanga', slug: 'abc', title: 'x', updatedAt: 1000 }],
    positions: [{ pluginId: 'baozimanga', slug: 'abc', chapterId: '0_1', percent: 42, updatedAt: 1000 }],
    bookmarks: [],
    settings: [],
  }),
});
check(again.body?.applied?.total === 0, `重推不产生变更（实际 ${again.body?.applied?.total}）`);

console.log('\n=== 3. 冲突：较旧的更新被忽略 ===');
const stale = await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'tablet',
    shelf: [{ pluginId: 'baozimanga', slug: 'abc', title: '旧标题', updatedAt: 500 }],
  }),
});
const afterStale = await api('/api/sync/pull?since=0&deviceId=x');
check(afterStale.body.shelf[0]?.title === '测试漫画', `旧数据未覆盖（现为「${afterStale.body.shelf[0]?.title}」）`);
check(stale.body?.applied?.shelf === 0, '旧数据被丢弃');

console.log('\n=== 4. 冲突：较新的更新生效 ===');
await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'tablet',
    shelf: [{ pluginId: 'baozimanga', slug: 'abc', title: '新标题', updatedAt: 9999 }],
  }),
});
const afterNew = await api('/api/sync/pull?since=0&deviceId=x');
check(afterNew.body.shelf[0]?.title === '新标题', `新数据生效（现为「${afterNew.body.shelf[0]?.title}」）`);

console.log('\n=== 5. 已读完的进度不被拉回 ===');
await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'phone',
    positions: [{ pluginId: 'baozimanga', slug: 'abc', chapterId: '0_1', percent: 100, updatedAt: 10000 }],
  }),
});
const revert = await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'tablet',
    positions: [{ pluginId: 'baozimanga', slug: 'abc', chapterId: '0_1', percent: 50, updatedAt: 20000 }],
  }),
});
const afterDone = await api('/api/sync/pull?since=0&deviceId=x');
check(
  afterDone.body.positions[0]?.percent === 100,
  `已读完仍为 ${afterDone.body.positions[0]?.percent}%（期望 100）`,
);
check(revert.body?.applied?.positions === 0, '覆盖被拒绝');

console.log('\n=== 6. 静态文件与 SPA 回退 ===');
const root = await fetch(BASE + '/');
check(root.ok, `根路径 200（${root.headers.get('content-type')}）`);
const deep = await fetch(BASE + '/comic/abc');
check(deep.ok && (await deep.text()).includes('<div id="root">'), '深链接回退到 index.html');
const asset = await fetch(BASE + '/nonexistent.js');
check(asset.status === 200, '未知 JS 路径也回退（避免路由 404）');

console.log('\n=== 7. 代理白名单 ===');
const bad = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent('https://evil.example.com/'));
check(bad.status === 403, `非白名单被拒（HTTP ${bad.status}）`);
const good = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent('https://www.twmanga.com/search?q=t'));
check(good.ok, `白名单内可转发（HTTP ${good.status}）`);

console.log('\n=== 8. 客户端上报 ===');
const clients = await api('/api/sync/clients');
check(clients.body.clients.length >= 2, `已记录 ${clients.body.clients.length} 台设备`);

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
