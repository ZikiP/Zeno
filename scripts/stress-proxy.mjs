/**
 * 代理稳定性压测：并发拉大量图片，中途可能有 CDN 断连。
 * 目的是确认代理**不会被打死** —— 这是修复前的真实故障模式。
 */
const BASE = 'http://127.0.0.1:8788/api/proxy?url=';

// 从真实插件里拿几个图片 URL
const plugin = JSON.parse(
  await import('node:fs').then((fs) => fs.readFileSync('baozimanga-plugin.json', 'utf8')),
);
const entry = plugin.entry;

console.log('预取图片地址…');
const searchUrl = BASE + encodeURIComponent(`${entry}/search?q=${encodeURIComponent('炎')}`);
const html = await (await fetch(searchUrl)).text();
const covers = [
  ...new Set(
    [...html.matchAll(/https:\/\/[^"'\s?]+\/cover\/[^"'\s?]+\.(?:jpg|jpeg|png|webp)/gi)].map(
      (m) => m[0],
    ),
  ),
].slice(0, 30);

console.log(`拿到 ${covers.length} 个封面地址`);

async function alive() {
  try {
    const r = await fetch('http://127.0.0.1:8788/health', { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

console.log(`\n压测前代理存活: ${await alive()}`);

// 3 轮并发拉取，每轮 40 个请求（远超 MAX_CONCURRENT=6）
for (let round = 1; round <= 3; round++) {
  const urls = Array.from({ length: 40 }, (_, i) => BASE + encodeURIComponent(covers[i % covers.length]));
  const t0 = Date.now();
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        return r.ok ? r.status : r.status;
      } catch (e) {
        return `ERR`;
      }
    }),
  );
  const ok = results.filter((r) => r === 200).length;
  console.log(
    `round ${round}: ${ok}/${results.length} 成功, ${Date.now() - t0}ms, 代理存活=${await alive()}`,
  );
}

console.log(`\n压测后代理存活: ${await alive()}`);
process.exit((await alive()) ? 0 : 1);
