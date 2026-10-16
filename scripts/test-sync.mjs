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
// 故意不给「默认打 8788」的退路：那正是生产端口，而本脚本不清理数据。
const BASE = process.env.BASE;
if (!BASE) {
  console.error('\n缺少 BASE。请用 `npm test` —— 它会为每个套件起独立端口和独立临时库。');
  console.error('直接跑本脚本会把测试数据写进你正在用的 data/zeno.db。\n');
  process.exit(2);
}

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

console.log('\n=== 5b. 书架手动顺序');
await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'phone',
    shelf: [
      { pluginId: 'baozimanga', slug: 'abc', title: '测试漫画', addedAt: 1000, updatedAt: 11000, order: 3 },
    ],
  }),
});
const withOrder = await api('/api/sync/pull?since=0&deviceId=x');
check(withOrder.body.shelf[0]?.sort_order === 3, `手动顺序存住并回读（实际 ${withOrder.body.shelf[0]?.sort_order}）`);

/*
 * 关键的一条：从没拖拽过的设备推上来的行**没有 order 字段**。
 * 服务端要是直接覆盖，它一同步就把别人排好的架子抹成 NULL 了。
 */
await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'tablet',
    shelf: [{ pluginId: 'baozimanga', slug: 'abc', title: '改了标题', addedAt: 1000, updatedAt: 12000 }],
  }),
});
const noOrder = await api('/api/sync/pull?since=0&deviceId=x');
check(noOrder.body.shelf[0]?.sort_order === 3, `没带 order 的推送不会抹掉已有顺序（实际 ${noOrder.body.shelf[0]?.sort_order}）`);
check(noOrder.body.shelf[0]?.title === '改了标题', '同一行的其它字段照常更新');

await api('/api/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: 'phone',
    shelf: [{ pluginId: 'baozimanga', slug: 'abc', title: '改了标题', addedAt: 1000, updatedAt: 13000, order: 0 }],
  }),
});
const reordered = await api('/api/sync/pull?since=0&deviceId=x');
check(reordered.body.shelf[0]?.sort_order === 0, `更新顺序生效（实际 ${reordered.body.shelf[0]?.sort_order}）`);

console.log('\n=== 6. 静态文件与 SPA 回退 ===');
const root = await fetch(BASE + '/');
check(root.ok, `根路径 200（${root.headers.get('content-type')}）`);
const deep = await fetch(BASE + '/comic/abc');
check(deep.ok && (await deep.text()).includes('<div id="root">'), '深链接回退到 index.html');

/*
 * 带扩展名的路径必须 404，不能回退成 HTML。
 * History 路由的 URL 没有扩展名，所以"像文件的路径"就是资源请求 ——
 * 回退会让浏览器把 HTML 当 JS 模块解析，白屏且极难归因。
 */
const asset = await fetch(BASE + '/nonexistent.js');
check(asset.status === 404, `未知 .js 返回 404 而不是 HTML（HTTP ${asset.status}）`);
const assetType = asset.headers.get('content-type') ?? '';
check(!assetType.includes('text/html'), `错误响应不是 HTML（${assetType}）`);

console.log('\n=== 6b. 请求体过大回 413 ===');
const huge = await fetch(BASE + '/api/sync/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'x', seq: 0, settings: [{ key: 'k', value: 'y'.repeat(9 * 1024 * 1024) }] }),
});
check(huge.status === 413, `超大 body 回 413 而不是 500（HTTP ${huge.status}）`);

console.log('\n=== 6c. health 的敏感字段 ===');
const hpub = await (await fetch(BASE + '/api/health')).json();
check(
  hpub.allowedHostsCount !== undefined,
  `公开可见 allowedHostsCount（${hpub.allowedHostsCount}）`,
);
check(
  Array.isArray(hpub.allowedHosts),
  '未设令牌时 allowedHosts 仍可见（auth() 放行，行为不变）',
);

console.log('\n=== 7. 代理白名单 ===');
const bad = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent('https://evil.example.com/'));
check(bad.status === 403, `非白名单被拒（HTTP ${bad.status}）`);
// 本用例推的插件只声明了 meta，没有任何域名 → 白名单为空 → 一切上游请求都该被拒。
// 「白名单内可转发」要发真实外网请求，那是 test-whitelist.mjs 的职责，不放这儿。
const wellKnown = await fetch(
  BASE + '/api/proxy?url=' + encodeURIComponent('https://www.example.com/'),
);
check(wellKnown.status === 403, `空白名单下合法域名也被拒（HTTP ${wellKnown.status}）`);

console.log('\n=== 8. 客户端上报 ===');
const clients = await api('/api/sync/clients');
check(clients.body.clients.length >= 2, `已记录 ${clients.body.clients.length} 台设备`);

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
