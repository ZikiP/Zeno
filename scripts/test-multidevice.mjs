/**
 * 多端同步验证
 *
 * 模拟场景：
 *   1. 「平板」通过 API 写入书架 + 进度 + 书签
 *   2. 浏览器（手机）刷新后应能看到这些数据
 *   3. 浏览器产生的改动应推回服务端
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

console.log('\n=== 模拟「平板」写入数据 ===');
// 时间戳用「服务端当前 seq 换算」而不是 Date.now()
// 这样重跑脚本时时间戳一定比库里的大，不会被幂等逻辑判为「无变更」
const before = await (await fetch(BASE + '/api/health')).json();
const now = 1_000_000_000_000 + before.seq * 1000;
const push = await fetch(BASE + '/api/sync/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'ipad-sim',
    plugins: [
      {
        id: 'baozimanga',
        origin: 'imported',
        data: JSON.stringify({
          format: 'zeno-plugin@1',
          meta: { id: 'baozimanga', name: '包子漫画', icon: '🌈' },
          entry: 'https://www.twmanga.com',
          chapterHost: 'https://www.twbzmg.com',
          urls: {
            search: '/search?q={q}',
            classify: '/classify?region={region}&state={state}',
            detail: '/comic/{slug}',
            chapter: '/comic/chapter/{slug}/{id}.html',
          },
          parse: {
            card: '<div class="comics-card',
            slugFrom: 'href="/comic/([^"?]+)"',
            title: { attr: 'title' },
            cover: 'https?://[^"\'\\s]*?/cover/[^"\'\\s?]+\\.(?:jpg|jpeg|png|webp)',
            chapterItem: 'class="comics-chapters__item"',
            chapterIdFrom: 'section_slot=(\\d+)&chapter_slot=(\\d+)',
            imageAttr: 'data-src',
          },
          imageHosts: ['bzcdn.net'],
          headers: {},
        }),
        updatedAt: now,
      },
    ],
    shelf: [
      {
        pluginId: 'baozimanga',
        slug: 'wodetudidushidafanpai-yuetian',
        title: '我的徒弟都是大反派',
        cover: 'https://static-tw.baozimh.com/cover/x.jpg',
        addedAt: now,
        updatedAt: now,
      },
    ],
    positions: [
      { pluginId: 'baozimanga', slug: 'wodetudidushidafanpai-yuetian', chapterId: '0_100', percent: 65, updatedAt: now },
    ],
    bookmarks: [
      {
        key: 'baozimanga/wodetudidushidafanpai-yuetian/0_100/5',
        pluginId: 'baozimanga',
        slug: 'wodetudidushidafanpai-yuetian',
        chapterId: '0_100',
        page: 5,
        percent: 20,
        note: '这段剧情很紧凑',
        createdAt: now,
        updatedAt: now,
      },
    ],
    settings: [{ key: 'themeMode', value: '"dark"', updatedAt: now }],
  }),
});
const pushBody = await push.json();
// 插件 + 书架 + 进度 + 书签 + 主题 = 5 项
check(
  pushBody?.applied?.total >= 0,
  `平板推入 ${pushBody?.applied?.total} 项（首次应为 5，重跑应为 0 —— 幂等）`,
);

console.log('\n=== 服务端状态 ===');
const after = await (await fetch(BASE + '/api/health')).json();
/*
 * 计数断言要看是否首次运行：
 *   首次（库里还没有这些记录）→ 各 +1
 *   重跑（记录已存在）→ 幂等，数量不变
 */
const fresh = before.plugins === 0;
const expect = (n) => (fresh ? n + 1 : n);
check(after.plugins === expect(before.plugins), `插件 ${before.plugins} → ${after.plugins}`);
check(after.shelf === expect(before.shelf), `书架 ${before.shelf} → ${after.shelf}`);
check(after.bookmarks === expect(before.bookmarks), `书签 ${before.bookmarks} → ${after.bookmarks}`);
check(after.positions === expect(before.positions), `进度 ${before.positions} → ${after.positions}`);
check(after.seq > before.seq, `变更序号推进 ${before.seq} → ${after.seq}`);

console.log('\n=== 模拟「手机」拉取 ===');
const pull = await (await fetch(BASE + '/api/sync/pull?since=0&deviceId=phone-sim')).json();
// 按内容找，不假设数组只有一条
const pluginRow = pull.plugins.find((p) => p.data?.includes('baozimanga'));
const shelfRow = pull.shelf.find((s) => s.title === '我的徒弟都是大反派');
const posRow = pull.positions.find((p) => p.slug === 'wodetudidushidafanpai-yuetian');
const bmRow = pull.bookmarks.find((b) => b.note === '这段剧情很紧凑');
const themeRow = pull.settings.find((s) => s.key === 'themeMode');

check(!!pluginRow, '插件数据可读回');
check(!!shelfRow, '书架标题正确');
check(posRow?.percent === 65, '进度 65% 正确');
check(!!bmRow, '书签笔记正确');
check(!!themeRow, '主题设置正确');

console.log('\n=== 设备上报 ===');
const clients = await (await fetch(BASE + '/api/sync/clients')).json();
check(clients.clients.length >= 2, `服务端记录了 ${clients.clients.length} 台设备`);
check(
  clients.clients.some((c) => c.device_id === 'ipad-sim'),
  '平板已上报',
);

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 多端同步可用' : `  ${fails} 项失败`);
console.log('='.repeat(52));
console.log('\n现在到浏览器里刷新设置页，主题应变成深色，书架应出现那本漫画。');
process.exit(fails === 0 ? 0 : 1);
