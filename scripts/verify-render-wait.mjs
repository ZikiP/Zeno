/**
 * 渲染"什么时候收摊"的差分验证（不起服务、不碰外网，纯本地源站）
 *
 * 三条都是实测过的形态，各自的错法都不一样：
 *  - hydration 慢于安静窗口的页：提前收摊就是"这个站没有内容"，比慢更糟。
 *  - 页面 200 但根本没有目录：等满 45s 把一格渲染并发钉死（全站 429 的来源）。
 *  - 文档自己 404：同上，而且答案一开始就知道。
 * 跑完即可删，不进测试套件（依赖本机浏览器）。
 */
import { createServer } from 'node:http';
import { renderHtml, shutdownBrowser } from '../server/render.mjs';

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

/*
 * 标记一律运行时拼出来。写在源码字面量里，原始 HTML 就能匹配上，
 * "等到内容"这条断言于是物理上不可能失败 —— verify-render.mjs 里已经
 * 为此踩过一次，这里的 CHECK 是拼好之后塞进 DOM 的文本。
 */
const INJECT = (text) => `
  var cls = ['comic','card'].join('-');
  var box = document.createElement('a');
  box.className = cls;
  box.textContent = ['${text}'].join('');
  document.getElementById('app').appendChild(box);
`;

/** /hydrate：2.0s 后才长出 .comic-card；/empty：永远长不出来；/gone：404 */
const ROUTES = {
  '/hydrate': [200, page(`<div id="app"></div><script>setTimeout(() => {${INJECT('到位了')}}, 2000);</script>`)],
  '/slow-sub': [
    200,
    page(`<img src="/hang" width="1" height="1"><div id="app"></div><script>setTimeout(() => {${INJECT('晚了但到了')}}, 4000);</script>`),
  ],
  '/empty': [200, page('<h1>这本书没有章节</h1>')],
  '/gone': [404, page('<h1>没这本</h1>')],
};

/**
 * 判据：DOM 里真的有一个 <a class="comic-card">，而不是源码里出现过这几个字符。
 * 类名在源码里是拆开拼的，所以这条断言只有"脚本跑过并把元素挂上去"才能成立。
 */
const hasCard = (html) => /<a class="comic-card">/.test(html);

const origin = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/hang') {
    // 永不返回的子资源：把 load 事件按住，让 readyState 停在 loading
    return;
  }
  const [status, body] = ROUTES[path] ?? [404, page('')];
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${origin.address().port}`;

const timed = async (path, opts) => {
  const t0 = Date.now();
  const r = await renderHtml(base + path, opts);
  return { ms: Date.now() - t0, ...r };
};

console.log('\n=== 1. hydration 比安静窗口慢一点点的页，仍要等到内容 ===');
const hydrate = await timed('/hydrate', { waitFor: '.comic-card', timeoutMs: 20_000 });
check(hasCard(hydrate.html), `真的等到运行时挂上去的元素（${hydrate.ms}ms，html ${hydrate.html.length}B）`);
check(hydrate.status === 200, `状态 ${hydrate.status}`);

console.log('\n=== 2. 子资源挂住 = load 不触发，安静判据不该抢跑 ===');
const slowSub = await timed('/slow-sub', { waitFor: '.comic-card', timeoutMs: 20_000 });
check(
  hasCard(slowSub.html),
  `没有提前收摊（${slowSub.ms}ms）—— 靠 load 还没到、readyState 不是 complete 兜住`,
);

console.log('\n=== 3. 页面正常但就是没有目录：别再等满预算 ===');
const empty = await timed('/empty', { waitFor: '.comic-card', timeoutMs: 20_000 });
check(empty.ms < 8_000, `${empty.ms}ms 就返回了（预算 20s）—— 槽没有被钉死`);
check(empty.status === 200, `空列表仍是 200（"没结果"不是失败），实得 ${empty.status}`);

console.log('\n=== 4. 文档自己 404 ===');
const gone = await timed('/gone', { waitFor: '.comic-card', timeoutMs: 20_000 });
check(gone.ms < 5_000, `${gone.ms}ms 就返回了`);
check(gone.status === 404, `状态透传成 404，实得 ${gone.status}`);

console.log('\n=== 5. 403 的质询壳不能被 404 早退顺手打死 ===');
/*
 * 跳转后的那份 HTML 必须 >3000 字节 —— waitOutChallenge 把"文档已 complete、
 * 有 body、且不只有几个字节"当成解开了的证据，导航中途的空白文档就是靠这条
 * 被挡掉的。造个短页会让测试在错的地方失败。
 */
ROUTES['/shell'] = [
  403,
  page(
    `<div id="s">正在验证浏览器，请稍后</div><script>setTimeout(()=>{location.replace('/from-shell')},1000)</script>`,
  ),
];
ROUTES['/from-shell'] = [
  200,
  page(`<a class="comic-card">质询过后的内容</a>${'<p>填充</p>'.repeat(400)}`),
];
const shell = await timed('/shell', { waitFor: '.comic-card', timeoutMs: 20_000 });
check(shell.status === 200, `解开后回 200，实得 ${shell.status}`);
check(shell.html.includes('质询过后的内容'), `等到跳转后的内容（${shell.ms}ms）`);

origin.close();
await shutdownBrowser();
console.log(fails ? `\n${fails} 条没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
