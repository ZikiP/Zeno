/**
 * 一次性差分验证：同一个"内容由 JS 注入"的页面，
 * fetch 模式拿不到、browser 模式拿得到。
 * 跑完即可删，不进测试套件（依赖本机浏览器，CI 上会假失败）。
 */
import { createServer } from 'node:http';
import { renderHtml } from '../server/render.mjs';

const PAGE = `<!doctype html><html><head><title>js-only</title></head>
<body><div id="app"></div>
<script>
  // 标记必须运行时拼接 —— 否则它明文躺在 <script> 源码里，
  // 原始 HTML 也能匹配上，差分就无从谈起了（第一版就栽在这）。
  var marker = ['JS', 'RENDERED', 'OK'].join('-');
  document.getElementById('app').innerHTML =
    '<div class="comic-card">href="/comic/' + marker + '"</div>';
</script></body></html>`;

const origin = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${origin.address().port}/`;

const MARKER = 'JS-RENDERED-OK';
const plain = await (await fetch(url)).text();
console.log('fetch  模式：含 JS 注入内容 =', plain.includes(MARKER));

const rendered = await renderHtml(url, { waitFor: '.comic-card' });
console.log('browser模式：含 JS 注入内容 =', rendered.html.includes(MARKER),
  '| status =', rendered.status, '| 长度 =', rendered.html.length);

console.log('\n渲染结果片段：');
console.log(rendered.html.match(/<div class="comic-card">[^<]*/)?.[0] ?? '（没找到）');

origin.close();
const { shutdownBrowser } = await import('../server/render.mjs');
await shutdownBrowser();

const pass = !plain.includes(MARKER) && rendered.html.includes(MARKER);
console.log(pass ? '\n结论：browser 模式确实补上了 fetch 拿不到的内容' : '\n结论：差分不成立，需排查');
process.exit(pass ? 0 : 1);
