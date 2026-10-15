/**
 * 捕获路径探针（直连真站，不经过 Zeno 服务）
 *
 * 验三件事：整章图片地址能不能一次拿全、拿全后是不是真的省掉了 DOM 序列化、
 * 抓空时能不能老实回落到 HTML。
 *
 * 用法：node scripts/verify-capture.mjs
 */
import { renderHtml, renderCacheStats, shutdownBrowser } from '../server/render.mjs';

const CHAPTER_URL =
  'https://www.mangacopy.com/comic/buxihuannverfanerxihuanmamawoma/chapter/46f6f7ce-f45c-11ea-8ec5-00163e0ca5bd';
const DETAIL_URL = 'https://www.mangacopy.com/comic/buxihuannverfanerxihuanmamawoma';
/** 页面自己解密后交给 JSON.parse 的那张表：[{"url": "..."}, ...] */
const PATTERN = '"url"\\s*:\\s*"([^"]+)"';

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const timed = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  console.log(`     ${label}: ${Math.round(performance.now() - t0)}ms`);
  return r;
};

console.log('=== 1. 章节：一次渲染拿整张表');
const first = await timed('首次渲染', () =>
  renderHtml(CHAPTER_URL, { capture: PATTERN, timeoutMs: 30_000 }),
);
check(first.format === 'json', `返回格式 ${first.format}（期望 json，即不再序列化 DOM）`);
check(first.captured.length === 21, `捕获 ${first.captured.length} 个地址（页面指示器是 1 / 21）`);
check(first.captured.every((u) => /^https:\/\/[^/]+\/b\//.test(u)), `每个都是 https 的图片地址`);
check(new Set(first.captured).size === first.captured.length, '没有重复');
check(first.html === '', '命中捕获时 html 是空的（没为用不上的 DOM 付钱）');

console.log('\n=== 2. 同一章第二次应当命中缓存');
const again = await timed('缓存命中', () => renderHtml(CHAPTER_URL, { capture: PATTERN, timeoutMs: 30_000 }));
check(again.captured.length === first.captured.length, `条数一致 ${again.captured.length}`);
const stat = renderCacheStats();
check(stat.hits >= 1, `缓存命中计数 ${stat.hits}，容量 ${stat.size}/${stat.ttlMs}ms`);

console.log('\n=== 3. 抓空时必须回落到 HTML，而不是返回空 JSON');
const missUrl = CHAPTER_URL + '?x=1';
const miss = await renderHtml(missUrl, {
  capture: '"thisKeyDoesNotExist"\\s*:\\s*"([^"]+)"',
  timeoutMs: 20_000,
});
check(miss.format === 'html', `返回格式 ${miss.format}`);
check(miss.captured.length === 0, '捕获为空');
check(miss.html.length > 2000, `HTML 有 ${miss.html.length} 字节可供老路径解析`);

/*
 * 抓空的那次不许进缓存 —— 之前它被当正常结果存了 90 秒，
 * 于是重试永远拿到同一份空壳，一次抖动被钉死。
 */
const t2 = performance.now();
const miss2 = await renderHtml(missUrl, {
  capture: '"thisKeyDoesNotExist"\\s*:\\s*"([^"]+)"',
  timeoutMs: 20_000,
});
const againMs = Math.round(performance.now() - t2);
check(miss2.format === 'html', `重试仍然是"重新渲染"的形态（${againMs}ms）`);
check(againMs > 3000, `重试没有命中空壳缓存（${againMs}ms，命中会 <100ms）`);

console.log('\n=== 4. minCount：详情章节列表要等够数量才算稳定');
const shallow = await renderHtml(DETAIL_URL, { waitFor: 'a[href*="/chapter/"]', timeoutMs: 20_000 });
const shallowCount = (shallow.html.match(/href="\/comic\/[^"]*\/chapter\//g) || []).length;
const deep = await renderHtml(DETAIL_URL, {
  waitFor: 'a[href*="/chapter/"]',
  minCount: 20,
  timeoutMs: 30_000,
});
const deepCount = (deep.html.match(/href="\/comic\/[^"]*\/chapter\//g) || []).length;
check(deepCount > shallowCount, `minCount 把 ${shallowCount} 条提到 ${deepCount} 条`);
check(deepCount >= 20, `拿到 ${deepCount} 条章节链接（>= 20）`);

console.log('\n=== 5. 浏览器已热、URL 未缓存时开一章要多久');
const OTHER =
  'https://www.mangacopy.com/comic/baoliwansui/chapter/d2bb9687-f9a6-11ef-878e-fa163e02432f';
const warm = await timed('热浏览器首章', () => renderHtml(OTHER, { capture: PATTERN, timeoutMs: 30_000 }));
check(warm.captured.length === 57, `另一部作品的长章节：捕获 ${warm.captured.length} 个（指示器 1 / 57）`);
check(warm.status === 200, `状态 ${warm.status}`);

await shutdownBrowser();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
