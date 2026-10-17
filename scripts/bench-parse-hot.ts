/**
 * 解析层在真实页面上的 CPU 开销
 *
 * 为什么要单独量：这些是纯字符串活，浏览器里跑在网络等待的空档里，
 * 所以"卡"和"慢"分不太清 —— 只有拿真实体积的页面量才知道值不值得动。
 * 页面从现网取一次存下来当固定输入，两次跑的输入一样，才叫对比。
 *
 * 用法：npx tsx scripts/bench-parse-hot.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChapters } from '../src/site/parse';
import { decodeEntities, stripTags } from '../src/site/text';

const BASE = process.env.ZENO_PROXY || 'http://127.0.0.1:8788';
const TMP = join(tmpdir(), 'zeno-bench-pages');
/** 取一次现网页面存成固定输入（渲染缓存只有 90 秒，不能每次都现取） */
async function page(kind: string, url: string, waitFor?: string) {
  const file = `${TMP}-${kind}.html`;
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const q =
    `${BASE}/api/proxy?url=${encodeURIComponent(url)}` +
    (waitFor ? `&mode=browser&waitFor=${encodeURIComponent(waitFor)}` : '');
  const html = await (await fetch(q)).text();
  writeFileSync(file, html);
  return html;
}

const list = await page('list', 'https://www.baozimh.com/');
const detail = await page('detail', 'https://www.baozimh.com/comic/woduzishengji-duburedicestudio', 'a.comics-chapters__item');
const chapter = await page('chapter', 'https://www.twmanga.com/comic/chapter/woduzishengji-duburedicestudio/0_5.html');

console.log(`输入：列表 ${(list.length / 1024) | 0}KB / 详情 ${(detail.length / 1024) | 0}KB / 章节 ${(chapter.length / 1024) | 0}KB`);

const run = (label: string, n: number, fn: () => unknown) => {
  fn(); // 预热，别让首次 JIT 冒充成本
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const ms = (performance.now() - t0) / n;
  console.log(`  ${label.padEnd(30)} ${ms.toFixed(2)}ms`);
  return ms;
};

console.log('\n=== decodeEntities：现在这条（9 次全文替换） ===');
for (const [name, html] of [['列表', list], ['详情', detail], ['章节', chapter]] as const) {
  run(`${name} ${(html.length / 1024) | 0}KB`, 20, () => decodeEntities(html));
}

/**
 * 一趟扫完的写法。逐条比对输出必须完全一致才敢换 ——
 * 有个真实的差别要先看清：现在这条是**顺序**扫的，`&amp;#47;` 这种
 * "转义过的转义"会被解两遍变成 `/`；一趟的写法只解外层，留 `&#47;`。
 * 一趟才是对的（内层那串本来是被当作数据转义进来的），但差别有没有落到
 * 真实页面上，得靠下面那条"输出一致"的比对说话。
 */
const ONE_PASS = /&(?:amp|lt|gt|quot|nbsp);|&#x2F;|&#(\d+);/gi;
const NAMED: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&nbsp;': ' ',
  '&#x2f;': '/',
};
function decodeEntitiesFast(s: string) {
  return s.replace(ONE_PASS, (m, dec?: string) => {
    if (dec) return String.fromCharCode(Number(dec));
    return NAMED[m.toLowerCase()] ?? m;
  });
}

console.log('\n=== 换成一趟扫描 ===');
for (const [name, html] of [['列表', list], ['详情', detail], ['章节', chapter]] as const) {
  const same = decodeEntities(html) === decodeEntitiesFast(html);
  const ms = run(`${name} ${(html.length / 1024) | 0}KB`, 20, () => decodeEntitiesFast(html));
  console.log(`     输出一致 = ${same}${same ? '' : ' ← 不一致就不能换'}`);
  void ms;
}

console.log('\n=== 解析一章的目录 ===');
run('parseChapters 183 条', 20, () =>
  parseChapters(detail, {
    chapterItem: 'comics-chapters__item',
    chapterIdFrom: 'section_slot=(\\d+)&chapter_slot=(\\d+)',
  } as never),
);
run('stripTags 整份列表页', 10, () => stripTags(list));
