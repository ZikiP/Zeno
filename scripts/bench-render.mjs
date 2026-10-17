/**
 * 冷渲染耗时基线 / 对比
 *
 * 每个 slug 只测一次（渲染缓存是进程内的，重启即清），
 * 所以对比要在同一次部署里用不同 slug，或重启前后各跑一轮。
 */
const BASE = process.env.ZENO_PROXY || 'http://127.0.0.1:8788';
const slugs = process.argv.slice(2);
for (const slug of slugs) {
  const url = `${BASE}/api/proxy?url=${encodeURIComponent(`https://www.baozimh.com/comic/${slug}`)}&mode=browser&waitFor=a.comics-chapters__item&timeoutMs=45000`;
  const t0 = Date.now();
  const res = await fetch(url);
  const html = await res.text();
  const items = (html.match(/comics-chapters__item/g) || []).length;
  console.log(
    `${slug.padEnd(42)} ${res.status} ${String(html.length).padStart(7)}B ${((Date.now() - t0) / 1000).toFixed(2)}s 锚点=${items}`,
  );
}
