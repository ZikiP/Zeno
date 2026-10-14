/**
 * 白名单自动推导验证
 *
 * 验证流程：
 *   1. 空库启动 → 白名单应为 0，代理拒绝一切
 *   2. 装一个插件 → 白名单应自动出现该站点域名，代理放行
 *   3. 删插件 → 白名单应随之移除
 *
 * 全程不设 ALLOWED_HOSTS，验证「同一份信息不填两遍」。
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const SITE = 'https://www.twmanga.com';
const EVIL = 'https://evil.example.com';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/**
 * ⚠️ 这个测试断言「白名单为空」，所以要求**空库**启动：
 * 服务端跑之前先 `rm -rf data/`。
 * 库里若已有别的插件，它们的域名会让白名单非空，断言就会失败。
 */
{
  const h = await (await fetch(BASE + '/api/health')).json();
  if (h.plugins > 0) {
    console.error(`\n库里有 ${h.plugins} 个插件，白名单断言会不准确。`);
    console.error('请先删除 data/ 目录再启动服务端。\n');
    process.exit(2);
  }
}

async function health() {
  return (await fetch(BASE + '/api/health')).json();
}
async function tryProxy(target) {
  const r = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent(target));
  return r.status;
}

const PLUGIN = {
  format: 'zeno-plugin@1',
  meta: { id: 'whitelist-test', name: '白名单测试源', icon: '🧪' },
  entry: SITE,
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
};

async function pushPlugin(action) {
  const body = {
    deviceId: 'whitelist-test',
    seq: 0,
    plugins:
      action === 'remove'
        ? []
        : [{ id: 'whitelist-test', origin: 'local', data: JSON.stringify(PLUGIN), updatedAt: Date.now() }],
  };
  const r = await fetch(BASE + '/api/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

/** 走真实删除接口 —— 前端删插件时调的就是它 */
async function forgetPlugin() {
  const r = await fetch(BASE + '/api/sync/forget-plugin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'whitelist-test', deviceId: 'whitelist-test' }),
  });
  return r.json();
}

console.log('\n=== 1. 未装插件时 ===');
let h = await health();
check(h.allowedHosts.length === 0, `白名单为空（${JSON.stringify(h.allowedHosts)}）`);
check((await tryProxy(SITE)) === 403, `代理拒绝目标站点（403）`);

console.log('\n=== 2. 装上插件后（不设任何环境变量）===');
let res = await pushPlugin('install');
const hosts = res.allowedHosts ?? [];
check(hosts.includes('www.twmanga.com'), `自动放行 entry：${hosts.join(', ')}`);
check(hosts.includes('www.twbzmg.com'), '自动放行 chapterHost');
check(hosts.includes('bzcdn.net'), '自动放行 imageHosts');

h = await health();
check(h.allowedHosts.length >= 3, `health 也能看到白名单（${h.allowedHosts.length} 个）`);

console.log('\n=== 3. 代理实际放行情况 ===');
const siteCode = await tryProxy(SITE);
check(siteCode === 200, `目标站点放行（HTTP ${siteCode}）`);
// 用站点真实存在的图片路径，避免拿编造的 URL 测出 404 误判成"没放行"
const cdnCode = await tryProxy('https://www.twmanga.com/favicon.ico');
check(cdnCode !== 403, `已放行的域名不返回 403（HTTP ${cdnCode}）`);
const evilCode = await tryProxy(EVIL);
check(evilCode === 403, `非白名单仍被拒（HTTP ${evilCode}）`);

console.log('\n=== 4. 删掉插件后 ===');
res = await forgetPlugin();
check(res.removed === true, '删除操作被服务端接受');
check(
  (res.allowedHosts ?? []).length === 0,
  `白名单随之清空（${JSON.stringify(res.allowedHosts)}）`,
);
check((await tryProxy(SITE)) === 403, '代理重新拒绝该站点');

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 白名单完全自动' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
