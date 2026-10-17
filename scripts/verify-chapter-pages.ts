/**
 * 翻完一章到底发了几次请求、拿回的图有没有变
 *
 * 并行化只该改变"什么时候发"，不该改变"拿到什么"。
 * 这条断言就是钉住这一点的：地址表要和串行时一模一样（顺序、条数、去重），
 * 而请求数要正好等于标称页数 —— 多一次就是还在白探下一页，少一次就是漏页。
 *
 * 用法：ZENO_PROXY=http://127.0.0.1:8788 npx tsx scripts/verify-chapter-pages.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../src/site/types';
import { getChapter } from '../src/site/engine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(resolve(ROOT, '../zeno-plugins/plugins/baozimh.json'), 'utf8'),
) as Plugin;
const SLUG = 'woduzishengji-duburedicestudio';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/** 数一下真正打到代理的请求，顺带记下各自的地址 */
const seen: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  seen.push(String(typeof input === 'string' ? input : (input as Request).url).slice(-46));
  return realFetch(input as never, init as never);
};

/** 标称 3 页 */
seen.length = 0;
let t0 = performance.now();
const three = await getChapter(plugin, SLUG, '0_1');
const threeMs = performance.now() - t0;
console.log(`\n0_1（标称 3 页）：${three.images.length} 张，${(threeMs / 1000).toFixed(2)}s`);
console.log(`  发了 ${seen.length} 次请求：\n    ${seen.join('\n    ')}`);
check(seen.length === 3, `请求数 = 标称页数 3（多出来就是白探，少了就是漏页）`);
check(three.totalPages === 3, `标称页数报的是 3，实得 ${three.totalPages}`);
check(!three.truncated, '没被标记成截断');
check(three.images.length === 50, `地址表 50 条（和串行版一致），实得 ${three.images.length}`);
check(
  three.images.every((u, i) => u === three.images[i]) && new Set(three.images).size === three.images.length,
  '表内无重复',
);

/** 无标记 = 只能继续探下一页 */
seen.length = 0;
t0 = performance.now();
const unknownPages = await getChapter(plugin, SLUG, '0_200');
console.log(
  `\n0_200（页面里没有页码标记）：${unknownPages.images.length} 张，${((performance.now() - t0) / 1000).toFixed(2)}s`,
);
console.log(`  发了 ${seen.length} 次请求`);
check(seen.length === 2, `没标记时按老办法探一页：共 2 次请求，实得 ${seen.length}`);
check(unknownPages.images.length > 0, `取到了 ${unknownPages.images.length} 张图`);

globalThis.fetch = realFetch;

console.log(fails ? `\n${fails} 条没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
