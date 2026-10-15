/**
 * 解析层的行为验证（纯逻辑，不碰网络）
 *
 * 重点是章节 id 的两种形态：两组正则 = `section_序号` 并按序号排序，
 * 一组 = 整段就是 id、顺序只能按页面里出现的先后。这两种拼错任一条，
 * 表现都是"目录只有一章"或者"下一话跳到奇怪的地方"，而界面上看不出错。
 */
import { type Plugin, PLUGIN_FORMAT, PLUGIN_TEMPLATE } from '../src/site/types';
import { parseChapters } from '../src/site/parse';
import { captureFor, minCountFor, settleOpts, waitForFor } from '../src/site/fetch';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const rules = (chapterIdFrom: string) => ({ ...PLUGIN_TEMPLATE.parse, chapterIdFrom });

const link = (href: string, text: string) => `<a class="chapter-item" href="${href}">${text}</a>`;

console.log('\n=== 1. 两组：section_序号，按序号排序 ===');
const numbered = parseChapters(
  link('/comic/x/chapter/0_5.html?section_slot=0&chapter_slot=5', '第5话') +
    link('/comic/x/chapter/0_3.html?section_slot=0&chapter_slot=3', '第3话'),
  rules('section_slot=(\\d+)&chapter_slot=(\\d+)'),
);
check(numbered.length === 2, `取到 ${numbered.length} 条`);
check(
  numbered.map((c) => c.id).join(',') === '0_3,0_5',
  `页面顺序倒着放也按序号排（实际 ${numbered.map((c) => c.id).join(',')}）`,
);
check(numbered.every((c) => /^\d+_\d+$/.test(c.id)), 'id 是 section_序号 形态');

console.log('\n=== 2. 一组：整段就是 id，顺序按页面出现先后 ===');
const UUID_A = 'd2bb9687-f9a6-11ef-878e-fa163e02432f';
const UUID_B = '46f6f7ce-f45c-11ea-8ec5-00163e0ca5bd';
const oneGroup = parseChapters(
  link(`/comic/x/chapter/${UUID_A}`, '第01話') + link(`/comic/x/chapter/${UUID_B}`, '第02話'),
  rules('chapter/([0-9a-f-]{36})'),
);
check(oneGroup.length === 2, `取到 ${oneGroup.length} 条`);
check(
  oneGroup.map((c) => c.id).join(',') === `${UUID_A},${UUID_B}`,
  'id 原样保留，没被拆成 section_index',
);
check(
  oneGroup.map((c) => c.index).join(',') === '1,2',
  `序号按页面顺序补齐（实际 ${oneGroup.map((c) => c.index).join(',')}）—— 上一话/下一话靠它`,
);

console.log('\n=== 3. 同一条链接重复出现只留一次 ===');
const dup = parseChapters(
  link(`/comic/x/chapter/${UUID_A}`, '第01話') + link(`/comic/x/chapter/${UUID_A}`, '第01話'),
  rules('chapter/([0-9a-f-]{36})'),
);
check(dup.length === 1, `重复条目合并（实际 ${dup.length} 条）`);

console.log('\n=== 4. 判据按页面类型取，capture 不吃全局写法 ===');
const plugin = {
  ...PLUGIN_TEMPLATE,
  format: PLUGIN_FORMAT,
  meta: { id: 'p', name: 'p' },
  fetch: {
    mode: { list: 'fetch', detail: 'browser', chapter: 'browser' },
    waitFor: 'a.card',
    minCount: { detail: 20 },
    capture: { chapter: '"url":"([^"]+)"' },
  },
} as Plugin;
check(waitForFor(plugin, 'list') === 'a.card', 'waitFor 字符串对所有渲染页生效');
check(minCountFor(plugin, 'detail') === 20, 'minCount 按类型取');
check(minCountFor(plugin, 'chapter') === undefined, '没声明的类型不编下限');
check(captureFor(plugin, 'chapter') === '"url":"([^"]+)"', 'capture 按类型取');
check(captureFor(plugin, 'detail') === undefined, '没声明的类型不捕获');
check(
  captureFor({ ...plugin, fetch: { ...plugin.fetch, capture: 'x' as never } }, 'chapter') ===
    undefined,
  'capture 写成全局字符串时不生效（校验会另拦，这里是双保险）',
);
check(
  Object.keys(settleOpts(plugin, 'list')).length === 0,
  'fetch 模式的页面不带任何渲染判据',
);
const chapterOpts = settleOpts(plugin, 'chapter');
check(
  chapterOpts.waitFor === 'a.card' && chapterOpts.capture === '"url":"([^"]+)"',
  '章节页的判据完整传给服务端',
);

console.log(`\n${fails === 0 ? '全部通过 — 解析行为正确' : `${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
