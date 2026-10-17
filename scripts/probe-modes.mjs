/**
 * 现网各页面的渲染耗时与判据命中情况（跑在部署实例上，不是本地）。
 * 用法：node scripts/probe-modes.mjs
 */
const B = (process.env.ZENO_PROXY || 'http://127.0.0.1:8788') + '/api/proxy';

const CASES = [
  ['baozimh 首页', 'https://www.baozimh.com/', 'div.comics-card'],
  ['baozimh 搜索', 'https://www.baozimh.com/search?q=%E9%AD%94%E6%91%A9', 'div.comics-card'],
  ['baozimh 无目录的书', 'https://www.baozimh.com/comic/xiatianmeiqiuhewodebushe-woniao', 'a.comics-chapters__item'],
  ['baozimh 不存在的书', 'https://www.baozimh.com/comic/definitely-not-here-xyz', 'a.comics-chapters__item'],
  ['copymanga 分类', 'https://www.mangacopy.com/comics?theme=1&region=1&status=0&ordering=2', 'div.exemptComic_Item', 20],
  ['copymanga 搜索空', 'https://www.mangacopy.com/search?q=zzzzzzqqqq', 'div.exemptComic_Item', 2],
];

for (const [name, u, sel, min] of CASES) {
  const q =
    `${B}?url=${encodeURIComponent(u)}&mode=browser&waitFor=${encodeURIComponent(sel)}` +
    (min ? `&minCount=${min}` : '') +
    '&timeoutMs=45000';
  const t = Date.now();
  let line;
  try {
    const r = await fetch(q, { signal: AbortSignal.timeout(70_000) });
    const h = await r.text();
    // 数的是 class 里的标记，不是选择器整串 —— 'div.comics-card' 在 HTML 里
    // 根本不成词，拿它 split 永远得 0，把"没内容"和"数错了"看成同一件事。
    const cls = sel.replace(/^[a-z]*/i, '').replace(/[.\[]/, '.').slice(1).split(/[>\s[]/)[0];
    const hits = (h.match(new RegExp(`class="[^"]*${cls}`, 'g')) || []).length;
    line = `${r.status} ${String(h.length).padStart(7)}B class=${cls} 命中=${hits}`;
  } catch (e) {
    line = `抛出 ${e.message}`;
  }
  console.log(name.padEnd(16), `${((Date.now() - t) / 1000).toFixed(2)}s`, line);
}
