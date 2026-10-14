/**
 * 插件格式校验的行为验证
 *
 * 校验规则本身不重要，重要的是它**拦住了什么**：
 * 这里每条 case 都对应一类"插件导得进来、但用起来是坏的"的实际形态 ——
 * 越晚发现，用户越容易以为是站点挂了而不是配置写错。
 */
import { PLUGIN_FORMAT, PLUGIN_TEMPLATE, URL_VARS, validatePlugin, type Plugin } from '../src/site/types';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const base: Plugin = {
  ...PLUGIN_TEMPLATE,
  format: PLUGIN_FORMAT,
  meta: { id: 't', name: '测试源' },
};

/** 有错就报出来，方便定位是哪条规则误伤了 */
const expectOk = (p: Plugin, label: string) => {
  const errs = validatePlugin(p);
  check(errs.length === 0, `${label}${errs.length ? ` —— ${errs.join('；')}` : ''}`);
};
const expectErr = (p: Plugin, label: string, hint: string) => {
  const errs = validatePlugin(p);
  check(
    errs.some((e) => e.includes(hint)),
    `${label}（实际：${errs[0] ?? '没有报错'}）`,
  );
};

console.log('\n=== 1. 该放行的必须放行 ===');
expectOk(base, '内置模板可导入（用户点"新建"拿到的就是它）');
expectOk(
  {
    ...base,
    entry: 'http://127.0.0.1:9000',
    imageHosts: ['127.0.0.1'],
  },
  '本地 http 假源站可导入（曾被"建议用 https"当成硬错误拦死）',
);
expectOk(
  {
    ...base,
    urls: {
      ...base.urls,
      classify: '/classify?type={type}&region={region}&state={state}&filter=*',
      chapter: '/read/{id}.html',
    },
    imageHosts: ['.bzcdn.net', 'static-tw.baozimh.com'],
    fetch: { mode: { list: 'browser', detail: 'browser', chapter: 'fetch' }, timeoutMs: 45000 },
  },
  '真实形态的插件（分类页带通配符、章节地址不含 slug、按页型分别设 mode）',
);

console.log('\n=== 2. 正则以页型写错要挡住 ===');
expectErr({ ...base, parse: { ...base.parse, slugFrom: 'href="/c/(["?' } }, 'slugFrom 括号没闭合', '不是合法正则');
/* 注意 `a{2,` 是**合法**正则（JS 把不闭合的量词当字面量），别拿它当反例 */
expectErr({ ...base, parse: { ...base.parse, cover: 'https?://(x' } }, 'cover 分组没闭合', '不是合法正则');
expectErr(
  { ...base, parse: { ...base.parse, chapterIdFrom: 'chapter_slot=(\\d+)' } },
  'chapterIdFrom 只给一个捕获组',
  '两个捕获组',
);
expectErr(
  { ...base, parse: { ...base.parse, slugFrom: 'href="/comic/\\w+"' } },
  'slugFrom 没有捕获组',
  '一个捕获组',
);
expectErr(
  { ...base, parse: { ...base.parse, noResultPattern: '([未找到' } },
  'noResultPattern 写坏',
  '不是合法正则',
);

console.log('\n=== 3. URL 模板 ===');
expectErr({ ...base, urls: { ...base.urls, detail: '/comic/fixed-slug' } }, 'detail 里没有 {slug}', '必须包含 {slug}');
expectErr({ ...base, urls: { ...base.urls, chapter: '/c/{slug}/{idx}.html' } }, 'chapter 里 {id} 拼错', '必须包含 {id}');
expectErr({ ...base, urls: { ...base.urls, search: '/s?q={querry}' } }, 'search 里出现不认识的占位符', '不认识的占位符');
check(
  Object.values(URL_VARS).every((v) => v.length > 0),
  'URL_VARS 每一项都声明了可用占位符',
);
/*
 * 模板与占位符表必须同步：TEMPLATE 里用了 URL_VARS 没列的变量，
 * 校验会把用户自己写的同款模板判成错的。
 */
const tplVars = new Set(
  Object.values(PLUGIN_TEMPLATE.urls).flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1])),
);
check(
  [...tplVars].every((v) => Object.values(URL_VARS).some((list) => list.includes(v))),
  `模板用到的占位符都在 URL_VARS 里（实际：${[...tplVars].join(' ')}）`,
);

console.log('\n=== 4. 其余字段 ===');
expectErr({ ...base, chapterHost: 'not a url' }, 'chapterHost 非法', 'chapterHost');
expectErr({ ...base, parse: { ...base.parse, title: {} as never } }, 'title 空对象', 'parse.title');
expectErr({ ...base, imageHosts: ['https://cdn.example.com/img'] }, 'imageHosts 写成完整 URL', '只写域名后缀');
expectErr({ ...base, maxChapterPages: -5 }, 'maxChapterPages 负数', '非负整数');
expectErr({ ...base, format: 'zeno-plugin@2' as never }, '格式标识不对', '格式标识');
expectErr({ ...base, fetch: { mode: 'render' as never } }, 'fetch.mode 取值非法', '只能是');

console.log('\n=== 5. 坏输入不能把校验本身弄崩 ===');
for (const bad of [null, undefined, 42, 'string', [], {}]) {
  let errs: string[] | null = null;
  try {
    errs = validatePlugin(bad);
  } catch (e) {
    errs = null;
    check(false, `validatePlugin(${JSON.stringify(bad)}) 抛异常了：${(e as Error).message}`);
  }
  if (errs !== null) check(errs.length > 0, `validatePlugin(${JSON.stringify(bad)}) 报错而不是静默通过`);
}

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 插件校验行为正确' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
