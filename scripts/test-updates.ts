/**
 * 服务端数章节 与 客户端解析章节 必须一模一样
 *
 * 为什么要有这条：书架徽章上的"N 章更新"= 服务端数到的条数 − 客户端解析出来的条数。
 * 两边只要有一条规则没对齐（服务端不做整份实体解码、或者不去重），
 * 差值就是一个永远消不掉的假数字 —— 每本书都挂着一个"+4"，看着还像真有新章。
 *
 * 所以两边跑同一份输入比结果，而且客户端那条走**真实管线**：
 * fetchText 拿到 HTML 先整份 decodeEntities，再交给 parseChapters。
 * 全程不碰网络：这一层本来就是纯字符串活。
 */
import { parseChapters } from '../src/site/parse';
import { decodeEntities } from '../src/site/text';
import { shelfUpdate, type UpdateRow } from '../src/store/updateBadge';
import { countChapters, listChapters } from '../server/updates.mjs';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/** 两组捕获：section_slot/chapter_slot → id 拼成 `0_5` */
const numbered = {
  chapterItem: 'comics-chapters__item',
  chapterIdFrom: 'section_slot=(\\d+)&chapter_slot=(\\d+)',
} as never;
/** 一组捕获：整段就是 id（拷贝漫画那种 UUID 形态） */
const single = { chapterItem: 'chapter-item', chapterIdFrom: 'chapter/([0-9a-f-]+|\\d+)' } as never;

const link = (href: string, text = '第x话') =>
  `<a href="${href}" class="comics-chapters__item"><div>${text}</div></a>`;
const one = (href: string) => `<a class="chapter-item" href="${href}">x</a>`;

const CASES: [string, string, number, never][] = [
  ['普通三条', [link('a?section_slot=0&chapter_slot=1'), link('a?section_slot=0&chapter_slot=2'), link('a?section_slot=0&chapter_slot=3')].join(''), 3, numbered],
  ['href 里的 & 转义成 &amp;', [link('a?section_slot=0&amp;chapter_slot=1'), link('a?section_slot=0&amp;chapter_slot=2')].join(''), 2, numbered],
  ['斜杠写成 &#x2F;（不解码就一条都数不到）', [one('/comic/x/chapter&#x2F;12.html'), one('/comic/x/chapter&#x2F;13.html')].join(''), 2, single],
  ['斜杠写成十进制的 &#47;', one('/comic/x/chapter&#47;14.html'), 1, single],
  ['实体编号通配那条兜底（&amp; 写成 &#38;）', [link('a?section_slot=0&#38;chapter_slot=21'), link('a?section_slot=0&#38;chapter_slot=22')].join(''), 2, numbered],
  ['同一个 id 出现两次要去重', [link('a?section_slot=0&chapter_slot=5'), link('a?section_slot=0&chapter_slot=5')].join(''), 1, numbered],
  ['href 挂在内层元素上', '<a class="comics-chapters__item"><div><a href="a?section_slot=0&chapter_slot=7">x</a></div></a>', 1, numbered],
  ['CSS 里也有同名 class，不能算进去', '<style>.comics-chapters__item{height:36px}</style>' + link('a?section_slot=0&chapter_slot=9'), 1, numbered],
  ['对不上 chapterIdFrom 的不算', link('a?page=1'), 0, numbered],
  ['一条都没有', '<div>什么都没有</div>', 0, numbered],
  /*
   * 下面两条钉的是**顺序**，不是条数：追漫靠 listChapters 的数组顺序决定
   * "最近 K 章"是哪 K 章。页面把新章挂在前面是常态，所以 DOM 顺序不等于阅读顺序 ——
   * 两边必须都按 index 升序，谁哪天漏了那次 sort，条数照样对得上、窗口却会摆到几百章之前。
   */
  ['DOM 倒着挂（3、1、2），两边都得按 index 升序', [link('a?section_slot=0&chapter_slot=3'), link('a?section_slot=0&chapter_slot=1'), link('a?section_slot=0&chapter_slot=2')].join(''), 3, numbered],
  ['跨分区：0 区 12 章要排在 1 区 3 章前面', [link('a?section_slot=1&chapter_slot=3'), link('a?section_slot=0&chapter_slot=12'), link('a?section_slot=0&chapter_slot=11')].join(''), 3, numbered],
  ['UUID 形态没有序号，只能按页面出现顺序', [one('/comic/x/chapter/aaa1.html'), one('/comic/x/chapter/bbb2.html'), one('/comic/x/chapter/ccc3.html')].join(''), 3, single],
];

/** 客户端的真实管线：先整份解码，再解析 */
const clientCount = (html: string, rules: never) => parseChapters(decodeEntities(html), rules).length;
/** 只留 id 与 index：标题两边取法不同（服务端不解正文），那是客户端的事 */
const clientList = (html: string, rules: never) =>
  parseChapters(decodeEntities(html), rules).map((c) => ({ id: c.id, index: c.index }));

console.log('\n=== 服务端 countChapters 对 客户端（解码 → parseChapters） ===');
for (const [name, html, expect, rules] of CASES) {
  const mine = countChapters(html, rules);
  const theirs = clientCount(html, rules);
  check(mine === expect && theirs === expect, `${name}：服务端 ${mine} / 客户端 ${theirs} / 应为 ${expect}`);
  const a = JSON.stringify(listChapters(html, rules));
  const b = JSON.stringify(clientList(html, rules));
  check(a === b, `  ↳ 同一份输入，id 与顺序逐条相同 ${a === b ? '' : `服务端 ${a} / 客户端 ${b}`}`);
}

console.log('\n=== 真实形态：混合两种写法的长目录 ===');
const mixed = Array.from({ length: 183 }, (_, i) =>
  i % 7 === 0 ? link(`a?section_slot=0&amp;chapter_slot=${i}`) : link(`a?section_slot=0&chapter_slot=${i}`),
).join('');
check(
  countChapters(mixed, numbered) === 183 && clientCount(mixed, numbered) === 183,
  `183 章、其中三成用 &amp; 写法：服务端 ${countChapters(mixed, numbered)} / 客户端 ${clientCount(mixed, numbered)}`,
);

console.log('\n=== 两边的条数怎么变成书架上的"+N" ===');
const row = (anchors: number | null, changedAt: number | null = Date.now()): UpdateRow => ({
  key: 'p/s',
  pluginId: 'p',
  slug: 's',
  anchors,
  checkedAt: 1,
  changedAt,
  error: null,
});
const three = shelfUpdate(row(183), 180);
check(!!three && three.kind === 'count' && three.n === 3, '手上 180、服务端 183 → +3');
check(shelfUpdate(row(183), 183) === null, '条数一样 → 什么都不说');
check(shelfUpdate(row(183), 190) === null, '站点撤章（手上反而多）→ 不说，也不报负数');
check(shelfUpdate(row(null), 180) === null, '服务端没数到 → 不说');
check(shelfUpdate(undefined, 180) === null, '这本没被检查过 → 不说');
check(shelfUpdate(row(183), undefined)?.kind === 'changed', '手上没有章节表 → 只说"有更新"，不编一个数字出来');
check(shelfUpdate(row(183, null), undefined) === null, '也没数过、也没表 → 不说');

console.log(fails ? `\n${fails} 条没过` : '\n全部通过 — 两边单位一致，减法也只有一种说法');
process.exit(fails ? 1 : 0);
