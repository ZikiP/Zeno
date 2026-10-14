const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

async function look(url: string, label: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
  let html = await res.text();
  html = html.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/');
  console.log(`\n########## ${label}`);
  console.log(`url=${url}`);
  console.log(`status=${res.status} bytes=${html.length}`);
  console.log(`含 "comics-card" 次数: ${(html.match(/comics-card/g) || []).length}`);
  console.log(`含 "comic/" 链接次数: ${(html.match(/href="\/comic\//g) || []).length}`);
  console.log(`含 "__NUXT__": ${html.includes('__NUXT__')}`);
  console.log(`含 "nuxt": ${/nuxt/i.test(html)}`);
  console.log(`含 "window.__": ${/window\.__/.test(html)}`);

  const i = html.indexOf('comics-card');
  if (i >= 0) {
    console.log('\n--- comics-card 前后 400 字符 ---');
    console.log(JSON.stringify(html.slice(Math.max(0, i - 200), i + 400)));
  } else {
    const j = html.indexOf('/comic/');
    if (j >= 0) {
      console.log('\n--- /comic/ 前后 400 字符 ---');
      console.log(JSON.stringify(html.slice(Math.max(0, j - 200), j + 400)));
    } else {
      console.log('\n--- 页面开头 600 字符 ---');
      console.log(JSON.stringify(html.slice(0, 600)));
    }
  }
}

await look('https://www.twmanga.com/search?q=%E7%82%8E%E7%81%AB', '搜索炎火');
await look('https://www.twmanga.com/classify?type=xuanhuan&region=cn&state=all&filter=*', '玄幻+国漫');
