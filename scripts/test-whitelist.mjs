/**
 * 白名单自动推导验证
 *
 * 验证流程：
 *   1. 空库启动 → 白名单应为 0，代理拒绝一切
 *   2. 装一个插件 → 白名单应自动出现该站点域名，代理放行
 *   3. 删插件 → 白名单应随之移除
 *
 * 全程不设 ALLOWED_HOSTS，验证「同一份信息不填两遍」。
 *
 * 源站用**本机回环地址**起，不打任何真实站点：
 *   - 仓库承诺不附带、不推荐任何内容源，测试里硬编码第三方域名本身就该修
 *   - 打外网的测试在站点改版/被墙/离线 CI 下会假失败
 * Windows 上整个 127.0.0.0/8 都绑在回环网卡上，所以能拿三个不同主机名，
 * 保住「entry / chapterHost / imageHosts 各推导一个域」的测试结构。
 */
import { createServer } from 'node:http';

// 故意不给「默认打 8788」的退路：那正是生产端口
const BASE = process.env.BASE;
if (!BASE) {
  console.error('\n缺少 BASE。请用 `npm test` 或 `npm run test:whitelist`。\n');
  process.exit(2);
}
const EVIL = 'https://evil.example.com';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/** 假装是个漫画站的假源站，监听所有回环地址 */
const origin = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><div class="comics-card">fake origin</div>');
});
await new Promise((r) => origin.listen(0, '0.0.0.0', r));
const ORIGIN_PORT = origin.address().port;

const ENTRY = `http://127.0.0.1:${ORIGIN_PORT}`;
const CHAPTER = `http://127.0.0.2:${ORIGIN_PORT}`;
const IMG_HOST = '127.0.0.3';

/** 这个测试断言「白名单为空」，所以要求空库。用 npm test（run-tests.mjs）跑即可。 */
{
  const h = await (await fetch(BASE + '/api/health')).json();
  if (h.plugins > 0) {
    console.error(`\n库里有 ${h.plugins} 个插件，白名单断言会不准确。`);
    console.error('别手动删生产库 —— 用 `npm test`，它会起一个独立的临时库。\n');
    origin.close();
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
  entry: ENTRY,
  chapterHost: CHAPTER,
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
  imageHosts: [IMG_HOST],
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
check((await tryProxy(ENTRY)) === 403, '代理拒绝目标站点（403）');

console.log('\n=== 2. 装上插件后（不设任何环境变量）===');
let res = await pushPlugin('install');
const hosts = res.allowedHosts ?? [];
check(hosts.includes('127.0.0.1'), `自动放行 entry：${hosts.join(', ')}`);
check(hosts.includes('127.0.0.2'), '自动放行 chapterHost');
check(hosts.includes(IMG_HOST), '自动放行 imageHosts');

h = await health();
check(h.allowedHosts.length >= 3, `health 也能看到白名单（${h.allowedHosts.length} 个）`);

console.log('\n=== 3. 代理实际放行情况（打本机假源站）===');
check((await tryProxy(ENTRY)) === 200, 'entry 放行并真的转发到源站');
check((await tryProxy(CHAPTER + '/comic/x')) === 200, 'chapterHost 放行');
check((await tryProxy(EVIL)) === 403, '非白名单仍被拒');

console.log('\n=== 4. 删掉插件后 ===');
res = await forgetPlugin();
check(res.removed === true, '删除操作被服务端接受');
check(
  (res.allowedHosts ?? []).length === 0,
  `白名单随之清空（${JSON.stringify(res.allowedHosts)}）`,
);
check((await tryProxy(ENTRY)) === 403, '代理重新拒绝该站点');

origin.close();
console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 白名单完全自动' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
