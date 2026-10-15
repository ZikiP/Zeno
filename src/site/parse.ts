import { escapeRe, stripTags } from './text';

/**
 * 解析层
 *
 * 从 HTML 里挖出结构化数据。所有规则都来自插件配置，
 * 代码本身不含任何站点信息。
 */

export interface Comic {
  slug: string;
  title: string;
  /** 裸封面 URL（未过代理），渲染时用 coverUrl() 转换 */
  cover: string;
  tags?: string[];
  description?: string;
  finished?: boolean;
  latestChapter?: string;
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
  /** 章节页完整地址。由 engine 用 URL 模板拼好后填上 */
  url: string;
}

/** 解析阶段还没有 url 时的中间形态 */
type ParsedChapter = Omit<Chapter, 'url'>;

/** 插件里跟解析相关的部分 */
export interface ParseRules {
  card: string;
  slugFrom: string;
  title: { attr: string } | { tag: string };
  cover: string;
  chapterItem: string;
  chapterIdFrom: string;
  imageAttr: string;
  noResultPattern?: string;
}

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

/**
 * 解析漫画卡片列表
 *
 * 关键：parse.card 是**字符串切分点**，不是 CSS 选择器。
 * 很多页面的 <style> 里也有同名 class 规则，填选择器会把 CSS 一起切进来。
 * 所以必须锚定真实标签开头，如 `<div class="comic-card`。
 */
export function parseCards(html: string, parse: ParseRules): Comic[] {
  const marker = escapeRe(parse.card);
  const blocks = html.split(marker).slice(1);

  const slugRe = new RegExp(parse.slugFrom);
  const coverRe = new RegExp(parse.cover);

  const seen = new Set<string>();
  const out: Comic[] = [];

  for (const block of blocks) {
    const m = block.match(slugRe);
    if (!m) continue;
    const slug = (m[1] ?? m[0]).trim();
    if (!slug || seen.has(slug)) continue;

    /*
     * 过滤未渲染的模板占位符。有些站点在 HTML 里留下原始插值
     * （如 `{{comic_id}}`），长得像正常 slug 但拼不出可用 URL。
     */
    if (/[{}<>]/.test(slug)) continue;
    seen.add(slug);

    let title = '';
    if ('attr' in parse.title && parse.title.attr) {
      title = block.match(new RegExp(`${escapeRe(parse.title.attr)}="([^"]+)"`))?.[1] ?? '';
    } else if ('tag' in parse.title && parse.title.tag) {
      const tag = parse.title.tag.replace(/[<>/\s]/g, '');
      title = stripTags(
        block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{0,200}?)</${tag}>`, 'i'))?.[1] ?? '',
      );
    }
    title = title.trim();
    if (/[{}]/.test(title)) title = '';

    out.push({
      slug,
      title: title || slug,
      cover: block.match(coverRe)?.[0] ?? '',
      latestChapter: stripTags(block.match(/更新至\s*([^<]{1,30})/)?.[1] ?? '').trim() || undefined,
    });
  }
  return out;
}

/**
 * 解析章节列表
 *
 * 匹配 `<a ... chapterItem ...>...</a>`，要求 `<a` 之后**紧邻**条目标识 ——
 * 否则会匹配到 <style> 里的 `.comics-chapters__item{...}`。
 */
export function parseChapters(html: string, parse: ParseRules): ParsedChapter[] {
  const chapters: ParsedChapter[] = [];
  const seen = new Set<string>();

  const itemRe = new RegExp(
    `<a[^>]*${escapeRe(parse.chapterItem)}[^>]*>([\\s\\S]{0,300}?)</a>`,
    'gi',
  );
  const idRe = new RegExp(parse.chapterIdFrom);

  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html))) {
    const inner = m[1] ?? '';
    // href 可能在 <a> 上，也可能在内层元素上
    const attrs = m[0].slice(0, m[0].indexOf('>'));
    const hrefM = attrs.match(/href="([^"]+)"/) ?? inner.match(/href="([^"]+)"/);
    if (!hrefM) continue;

    const href = hrefM[1].replace(/&amp;/g, '&').replace(/&#x2F;/g, '/');
    const idM = href.match(idRe);
    if (!idM) continue;

    /*
     * 组的个数决定章节地址的形态，运行时看 match 数组长度最准：
     *  - 两组：`section_slot=0&chapter_slot=562` → id 拼成 `0_562`，
     *    第二组是序号，拿来排序（页面顺序未必是章节顺序）。
     *  - 一组：整段就是 id。这类站（UUID 形态的章节地址）根本没有
     *    "分区/序号"的概念，序号只能按它们在页面里出现的先后排 ——
     *    实测拷貝漫畫的目录 DOM 顺序就是第 01 话在前，按出现顺序是对的。
     */
    const numbered = idM.length >= 3;
    const raw = numbered ? idM[2] : idM[1];
    if (!raw) continue;
    const id = numbered ? `${idM[1] ?? '0'}_${raw}` : raw;
    if (seen.has(id)) continue;
    seen.add(id);

    chapters.push({
      id,
      index: numbered ? Number(raw) || 0 : chapters.length + 1,
      title: stripTags(inner).slice(0, 80) || `第 ${raw} 话`,
    });
  }

  chapters.sort((a, b) => a.index - b.index);
  return chapters;
}

/**
 * 提取页面标题里的章节名，去掉站点后缀。
 * 形如「268 帝境神通(1/4) - 頂級氣運... - 包子漫畫」
 */
export function parseTitle(html: string, fallback: string): string {
  const raw = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? fallback;
  return stripTags(raw).replace(/[\s-]+\S{2,12}$/, '').trim() || fallback;
}

/** 找页面里的「未找到」类提示 */
const NO_RESULT_HINTS =
  /沒有找到|没有找到|無搜尋結果|无搜索结果|找不到相關|找不到相关|查無此書|查无此书|沒有相關|没有相关|no\s*result/i;

/**
 * 判断搜索结果是否可信
 *
 * 这一段踩过坑，务必读完再改：
 *
 * 实测某站点搜「炎火」89 部，搜完全不存在的东西 **91 部** —— 数量几乎一样；
 * 页面没有任何「未找到」字样；`<title>` 里照样带着查询词。
 * 逐条比对标题匹配率也没用 —— 搜「炎火」精确命中 0%，因为它匹配简介和标签。
 *
 * 结论：**该站点根本没有「无结果」这个状态**，返回的是推荐列表，
 * HTML 层面无法与真实结果区分。客户端的启发式判断都是瞎猜。
 *
 * 所以只认两种可确证的信号：页面明说「未找到」，或插件作者提供了
 * `noResultPattern`。都没有时诚实返回 exact: true，由界面提示「模糊匹配」。
 */
export function isSearchExact(html: string, parse: ParseRules, count: number): boolean {
  if (count === 0) return false;
  if (NO_RESULT_HINTS.test(html)) return false;
  if (parse.noResultPattern) {
    try {
      if (new RegExp(parse.noResultPattern).test(html)) return false;
    } catch {
      /* 正则写错了就当没配 */
    }
  }
  return true;
}
