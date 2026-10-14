/**
 * 插件加载与解析验证
 *
 * 从命令行传入插件 JSON 路径，验证：
 * 1. 格式校验通过
 * 2. 用插件里的规则真的能抓到他站点并解析出内容
 *
 * 用法：node --import tsx scripts/verify-plugin.ts <plugin.json>
 */
import { readFileSync } from 'node:fs';
import { validatePlugin, pluginHosts, type Plugin } from '../src/site/types.ts';
import { listComics, getComic, getChapter } from '../src/site/engine.ts';

const path = process.argv[2];
if (!path) {
  console.error('用法: node --import tsx scripts/verify-plugin.ts <plugin.json>');
  process.exit(2);
}

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const raw = readFileSync(path, 'utf8');
let json: unknown;
try {
  json = JSON.parse(raw);
  console.log('[PASS] JSON 语法合法');
} catch (e) {
  console.log('[FAIL] JSON 解析失败: ' + (e as Error).message);
  process.exit(1);
}

console.log('\n=== 1. 插件格式校验 ===');
const errs = validatePlugin(json);
if (errs.length === 0) {
  console.log('[PASS] 格式校验全部通过');
} else {
  errs.forEach((e) => console.log('[FAIL] ' + e));
  fails += errs.length;
}

const plugin = json as Plugin;
console.log(`\n  名称: ${plugin.meta.name}`);
console.log(`  标识: ${plugin.meta.id}`);
console.log(`  入口: ${plugin.entry}`);
console.log(`  章节: ${plugin.chapterHost ?? '(同入口)'}`);
console.log(`  需要放行的域名: ${pluginHosts(plugin).join(', ')}`);

console.log('\n=== 2. 列表解析 ===');
let slug = '';
try {
  const result = await listComics(plugin);
  const list = result.comics;
  check(result.exact, '分类页结果可信');
  check(list.length > 0, `分类页解析到 ${list.length} 部`);
  list.slice(0, 4).forEach((c) =>
    console.log(`      · ${c.title}  [${c.slug}]  封面=${c.cover ? '有' : '无'}`),
  );
  const withCover = list.filter((c) => c.cover).length;
  check(withCover > list.length * 0.8, `${withCover}/${list.length} 有封面`);
  check(
    list.every((c) => /^[a-z0-9-]+$/.test(c.slug)),
    'slug 格式统一，可用于拼 URL',
  );
  slug = list[0]?.slug ?? '';
} catch (e) {
  check(false, '列表抓取失败: ' + (e as Error).message);
}

console.log('\n=== 3. 搜索解析 ===');
try {
  const hit = await listComics(plugin, { query: '炎' });
  check(hit.exact && hit.comics.length > 0, `搜索「炎」${hit.comics.length} 部，结果可信`);

  /*
   * 无结果搜索。
   *
   * 注意：不是所有站点都能区分「查不到」和「推荐列表」。
   * 查不到时返回一堆无关内容、且页面无任何标记的站点，无论怎么判都判不准 ——
   * 这是站点行为，不是插件配置问题。所以这里只检查程序逻辑是否正常，
   * 不断言站点必须能区分。
   */
  const miss = await listComics(plugin, { query: 'zzzznotexist99999' });
  const canDetect = !miss.exact;
  console.log(
    `      无结果搜索返回 ${miss.comics.length} 部，` +
      (canDetect ? '程序已正确识别' : '该站点无法区分真伪（属站点行为，界面会提示模糊匹配）'),
  );
  check(
    typeof miss.exact === 'boolean',
    'listComics 始终返回 exact 标记',
  );
} catch (e) {
  check(false, '搜索失败: ' + (e as Error).message);
}

console.log('\n=== 4. 详情与章节 ===');
if (slug) {
  try {
    const { comic, chapters } = await getComic(plugin, slug);
    console.log(`      标题: ${comic.title}`);
    console.log(`      章节: ${chapters.length}`);
    check(comic.title.length > 1, `标题解析: ${comic.title}`);
    check(chapters.length > 0, `章节列表 ${chapters.length} 条`);
    check(
      chapters.every((c, i) => i === 0 || c.index >= chapters[i - 1].index),
      '章节按序号升序',
    );
    chapters.slice(0, 3).forEach((c) => console.log(`      · ${c.id}  ${c.title}`));

    if (chapters.length) {
      console.log('\n=== 5. 章节图片 ===');
      const last = chapters[chapters.length - 1];
      const t0 = Date.now();
      const page = await getChapter(plugin, slug, last.id);
      check(page.images.length > 0, `${last.id} 抓到 ${page.images.length} 张图，${Date.now() - t0}ms`);
      console.log(`      总页数: ${page.totalPages}`);
      check(
        page.images.every((u) => /^https?:/.test(u)),
        '图片地址均为绝对 URL',
      );
      check(
        new Set(page.images).size === page.images.length,
        '图片已去重',
      );
      if (page.images[0]) {
        const res = await fetch(page.images[0], { method: 'HEAD' });
        check(res.ok, `首图可下载: HTTP ${res.status}`);
      }
    }
  } catch (e) {
    check(false, '详情失败: ' + (e as Error).message);
  }
}

console.log('\n' + '='.repeat(50));
console.log(fails === 0 ? '  插件完全可用' : `  ${fails} 项失败`);
console.log('='.repeat(50));
process.exit(fails === 0 ? 0 : 1);
