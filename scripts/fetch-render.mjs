/**
 * 取一次渲染结果存成文件，便于离线看结构。
 * 用法：node scripts/fetch-render.mjs <slug> <输出文件>
 */
import fs from 'node:fs';
const BASE = process.env.ZENO_PROXY || 'http://127.0.0.1:8788';
const slug = process.argv[2];
const out = process.argv[3];
const t0 = Date.now();
const url = `${BASE}/api/proxy?url=${encodeURIComponent(`https://www.baozimh.com/comic/${slug}`)}&mode=browser&waitFor=a.comics-chapters__item&timeoutMs=45000`;
const res = await fetch(url);
const html = await res.text();
fs.writeFileSync(out, html);
console.log(res.status, html.length, `${((Date.now() - t0) / 1000).toFixed(2)}s -> ${out}`);
