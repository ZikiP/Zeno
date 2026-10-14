const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const url = 'https://www.twmanga.com/search?q=' + encodeURIComponent('炎火');

console.log('url:', url);
for (let i = 1; i <= 4; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
    const h = await r.text();
    const cards = (h.match(/class="comics-card/g) || []).length;
    console.log(`try ${i}: HTTP ${r.status}, ${h.length} bytes, ${Date.now() - t0}ms, cards=${cards}`);
  } catch (e) {
    console.log(`try ${i}: FAIL after ${Date.now() - t0}ms -> ${e.name}: ${e.message}`);
    if (e.cause) console.log(`        cause: ${e.cause.code ?? ''} ${e.cause.message ?? ''}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
