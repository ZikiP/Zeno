import type { Plugin } from './types';
import {
  captureFor,
  coverUrl,
  fetchCaptured,
  FetchError,
  fetchText,
  modeFor,
  proxied,
} from './fetch';
import { escapeRe } from './text';
import {
  fillTemplate,
  isSearchExact,
  parseCards,
  parseChapters,
  parseTitle,
  type Chapter,
  type Comic,
} from './parse';
export { coverUrl, proxied };
// 类型从 parse 层导出，消费方只需要认识 engine 一个入口
export type { Chapter, Comic } from './parse';

/**
 * 公开 API
 *
 * 三个函数对应三件事：列漫画、看详情、读章节。
 * 请求在 fetch.ts，解析在 parse.ts，这里只做编排。
 */

/** 列表查询结果 */
export interface ListResult {
  comics: Comic[];
  /**
   * 结果是否可信。
   *
   * 有些站点搜索查不到时不返回空列表，而是塞一堆推荐内容。
   * 那时 comics 里全是无关作品，必须让调用方知道，
   * 否则用户会以为「搜到了」但其实全不对。
   *
   * 判定逻辑在 parse.ts 的 isSearchExact —— 那里记录了为什么
   * 不能靠数量或标题来判断。
   */
  exact: boolean;
}

export interface ChapterPage {
  totalPages: number;
  /** 已过代理的图片地址 */
  images: string[];
  /**
   * 内页没取完就中断了（网络失败、渲染超时），而不是这一章真的只有这么多页。
   * 少了这个标记，"短了一截的一章"和"本来就短的一章"在界面上完全一样 ——
   * 用户会以为漫画就这么点内容。
   */
  truncated?: boolean;
}

/**
 * 没声明 filters 的老插件里，这三个名字历史上由框架代填 all。
 * 新插件请自己在 filters 里写 default —— 空值和不传在实测的站点上是等价的。
 */
const LEGACY_CLASSIFY_DEFAULTS: Record<string, string> = { type: 'all', region: 'all', state: 'all' };

/** 拼分类页的变量表：界面给的 > 插件声明的 default > 内置兜底 */
function classifyVars(plugin: Plugin, given: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of plugin.filters ?? []) {
    out[f.key] = given[f.key] ?? f.default ?? '';
  }
  for (const [k, v] of Object.entries(given)) {
    if (v !== undefined && !(k in out)) out[k] = v;
  }
  for (const { 1: name } of plugin.urls.classify.matchAll(/\{(\w+)\}/g)) {
    if (!(name in out) && name in LEGACY_CLASSIFY_DEFAULTS) out[name] = LEGACY_CLASSIFY_DEFAULTS[name];
  }
  return out;
}

/**
 * 搜索 / 分类列表。
 *
 * `filter` 里除 `query` 之外的键就是 `urls.classify` 的占位符名 —— 有哪些维度
 * 由插件的 `filters` 说了算，这里不认识任何具体的站点参数。
 */
export async function listComics(
  plugin: Plugin,
  filter: { query?: string } & Record<string, string | undefined> = {},
): Promise<ListResult> {
  const { query, ...given } = filter;
  const url = query
    ? new URL(fillTemplate(plugin.urls.search, { q: query }), plugin.entry).toString()
    : new URL(fillTemplate(plugin.urls.classify, classifyVars(plugin, given)), plugin.entry).toString();

  const html = await fetchText(plugin, url, 'list');
  const comics = parseCards(html, plugin.parse);

  // 分类页永远是精确结果
  if (!query) return { comics, exact: true };

  return { comics, exact: isSearchExact(html, plugin.parse, comics.length) };
}

/** 漫画详情 + 章节列表 */
export async function getComic(
  plugin: Plugin,
  slug: string,
): Promise<{ comic: Comic; chapters: Chapter[] }> {
  const html = await fetchText(
    plugin,
    new URL(fillTemplate(plugin.urls.detail, { slug }), plugin.entry).toString(),
    'detail',
  );

  const rawChapters = parseChapters(html, plugin.parse);
  const base = plugin.chapterHost ?? plugin.entry;

  const chapters: Chapter[] = rawChapters.map((c) => ({
    ...c,
    url: new URL(fillTemplate(plugin.urls.chapter, { slug, id: c.id }), base).toString(),
  }));

  /*
   * 标签：页面里同一个标签可能出现在多处（标签云 + 详情区），要去重，
   * 否则 UI 里 React key 会冲突。
   */
  const tags = [
    ...new Set(
      [...html.matchAll(/class="[^"]*tag[^"]*"[^>]*>([^<]{1,20})</g)].map((m) => m[1].trim()),
    ),
  ]
    .filter(Boolean)
    .slice(0, 10);

  const descM =
    html.match(/class="[^"]*(?:desc|summary|intro)[^"]*"[^>]*>([\s\S]{0,2000}?)<\/div>/i)?.[1] ?? '';

  return {
    comic: {
      slug,
      title: parseTitle(html, slug),
      cover:
        html.match(new RegExp(plugin.parse.cover))?.[0] ??
        html.match(/https?:\/\/[^"'\s]*?\/cover\/[^"'\s?]+\.(?:jpg|jpeg|png|webp)/i)?.[0] ??
        '',
      description: descM ? stripTagsSafe(descM) : undefined,
      tags: tags.length ? tags : undefined,
      finished: /完結|完结|已完結/.test(html.slice(0, 4000)),
      latestChapter: chapters.at(-1)?.title,
    },
    chapters,
  };
}

function stripTagsSafe(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 从 HTML 里按 parse.imageAttr 抓正文图片地址。
 *
 * 这是老路，也是 fetch.capture 落空时的兜底。很多站点 src 里放的是框架
 * 绑定符号（如 `[src]="chapter00Src"`），真实地址在 data-src —— 所以属性名
 * 由插件配置而不是写死。
 */
function imageUrlsFromHtml(html: string, plugin: Plugin): string[] {
  const re = new RegExp(
    `${escapeRe(plugin.parse.imageAttr)}="(https?://[^"]+?\\.(?:jpg|jpeg|png|webp))"`,
    'gi',
  );
  return [...html.matchAll(re)].map((x) => x[1]);
}

/**
 * 章节正文，自动翻完所有内页
 *
 * 长章节会拆成多个 URL：`0_271.html`、`0_271_2.html`…
 * 默认不限页数（插件可配 maxChapterPages），因为硬性截断会让人
 * 误以为「读完了」而实际后面还有。另有 500 页的硬性安全上限防死循环。
 *
 * 但有一类站点根本没有"内页"这个概念：正文地址只存在于它自己 JS 解出来的
 * 数据里（插件声明了 fetch.capture）。这类站的翻页参数它自己的 App 都不读
 * （实测 ?page=6 指示器仍是 1 / 57），所以一次渲染取全表就收工，
 * 绝不进下面那个靠 404 收尾的循环 —— 进去只会被 404 当成"这章只有一页"。
 */
export async function getChapter(
  plugin: Plugin,
  slug: string,
  chapterId: string,
  opts?: { signal?: AbortSignal },
): Promise<ChapterPage> {
  const base = plugin.chapterHost ?? plugin.entry;
  const urlFor = (id: string) =>
    new URL(fillTemplate(plugin.urls.chapter, { slug, id }), base).toString();

  if (captureFor(plugin, 'chapter') && modeFor(plugin, 'chapter') === 'browser') {
    const firstUrl = urlFor(chapterId);
    const { images, html } = await fetchCaptured(plugin, firstUrl, 'chapter', opts);
    const urls = [...new Set(images.length ? images : imageUrlsFromHtml(html, plugin))];
    /*
     * 空表必须抛，不能返回 []。一张图都没有却被当成"取到了"，
     * 界面上就是翻开一章白页，而且看上去一切正常。
     */
    if (!urls.length) throw new FetchError('这一章没有解析出任何图片地址', firstUrl);
    return { totalPages: urls.length, images: urls.map((u) => proxied(u)) };
  }

  const configured = plugin.maxChapterPages ?? 0;
  const limit = configured > 0 ? configured : Number.POSITIVE_INFINITY;
  const HARD_CAP = 500;

  const images: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const addImages = (html: string) => {
    let added = 0;
    for (const u of imageUrlsFromHtml(html, plugin)) {
      if (seen.has(u)) continue;
      seen.add(u);
      images.push(proxied(u));
      added++;
    }
    return added;
  };

  /*
   * 页码标记形如标题里的 "(1/3)"。**只认第一个数是 1 的那种**：
   * 它必须是"本页是整章的第 1 页"这个意思，而不是章节标题里恰好出现的
   * 一串括号（"第2话 (3/5)" 那种会把我们骗到只取 5 页中的第 1 页去）。
   */
  const declaredPages = (html: string) => {
    const m = html.match(/\(1\/(\d+)\)/);
    return m ? Math.max(1, Number(m[1]) || 1) : null;
  };

  const firstUrl = urlFor(chapterId);
  const firstHtml = await fetchText(plugin, firstUrl, 'chapter');
  const totalPages = declaredPages(firstHtml) ?? 1;
  addImages(firstHtml);

  /*
   * 站点自己说了这一章一共几页，就没什么好探的：剩下的页并发取。
   *
   * 之前这里是"一页一页串着取，取到 404 或重复为止"，于是一章的耗时是
   * 每页上游往返的**和**（实测包子漫画单页 0.83s，三页章 2.9s）。
   * 更要紧的是原来那条 `totalPages > 1 && page >= totalPages` 的收尾条件：
   * 标称 1 页的章它不成立，于是照样多发一次"下一页"的请求 —— 而这类站点
   * 对不存在的下一页根本不安抚地回 404，实测 twmanga 把第一页原样又回了一遍
   * （200 + 同样的 128KB），只能靠去重认出来，白花一个往返。
   *
   * 没有标记的章不在这条路上：它们没有可信任的页数，只能继续探。
   */
  if (totalPages > 1) {
    const last = Math.min(totalPages, limit, HARD_CAP);
    const rest = await Promise.all(
      Array.from({ length: last - 1 }, (_, i) => i + 2).map(async (p) => {
        if (opts?.signal?.aborted) return null;
        try {
          return await fetchText(plugin, urlFor(`${chapterId}_${p}`), 'chapter');
        } catch (e) {
          const status = e instanceof FetchError ? e.status : undefined;
          // 标称和实际不一致（站点自己数错了）：到这就算读完，不算截断
          if (status !== 404 && status !== 410) truncated = true;
          return null;
        }
      }),
    );
    for (const html of rest) if (html) addImages(html);
    return { totalPages, images, truncated };
  }

  let page = 2;
  while (page <= limit && page <= HARD_CAP) {
    if (opts?.signal?.aborted) break;

    const pageId = `${chapterId}_${page}`;
    let html: string;
    try {
      html = await fetchText(plugin, urlFor(pageId), 'chapter');
    } catch (e) {
      const status = e instanceof FetchError ? e.status : undefined;
      /*
       * 404/410 = 这个内页真的不存在，章节到此为止。绝大多数单页章节都走这条，
       * 是正常的结束方式，不是错误。
       *
       * 后面的页失败且不是 404（超时、5xx、渲染不出来），返回已有部分但标记
       * truncated：把网络抖动当成"这章就这么短"，用户读到最后也不会起疑。
       */
      if (status === 404 || status === 410) break;
      truncated = true;
      break;
    }

    if (addImages(html) === 0) break; // 本页全是重复，说明到头了
    page++;
  }

  return { totalPages, images, truncated };
}
