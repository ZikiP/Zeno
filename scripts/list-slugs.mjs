/**
 * 从包子漫画搜索页里取一批真实 slug，喂给 bench-render.mjs 做冷渲染对比。
 */
const BASE = process.env.ZENO_PROXY || 'http://127.0.0.1:8788';
const q = process.argv[2] || '我';
const url = `${BASE}/api/proxy?url=${encodeURIComponent(`https://www.baozimh.com/search?q=${encodeURIComponent(q)}`)}&mode=browser&waitFor=div.comics-card&timeoutMs=45000`;
const html = await (await fetch(url)).text();
const slugs = [...new Set([...html.matchAll(/href="\/comic\/([a-z0-9_-]+)"/g)].map((m) => m[1]))].filter(
  (s) => s !== 'sitemap',
);
console.log(slugs.slice(0, Number(process.argv[3] || 6)).join('\n'));
