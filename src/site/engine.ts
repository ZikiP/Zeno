import type { Plugin } from './types';
import { coverUrl, escapeRe, fetchText, proxied } from './fetch';
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
}

/** 搜索 / 分类列表 */
export async function listComics(
  plugin: Plugin,
  filter: { query?: string; type?: string; region?: string; state?: string } = {},
): Promise<ListResult> {
  const url = filter.query
    ? new URL(fillTemplate(plugin.urls.search, { q: filter.query }), plugin.entry).toString()
    : new URL(
        fillTemplate(plugin.urls.classify, {
          type: filter.type ?? 'all',
          region: filter.region ?? 'all',
          state: filter.state ?? 'all',
        }),
        plugin.entry,
      ).toString();

  const html = await fetchText(plugin, url, 'list');
  const comics = parseCards(html, plugin.parse);

  // 分类页永远是精确结果
  if (!filter.query) return { comics, exact: true };

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
 * 章节正文，自动翻完所有内页
 *
 * 长章节会拆成多个 URL：`0_271.html`、`0_271_2.html`…
 * 默认不限页数（插件可配 maxChapterPages），因为硬性截断会让人
 * 误以为「读完了」而实际后面还有。另有 500 页的硬性安全上限防死循环。
 */
export async function getChapter(
  plugin: Plugin,
  slug: string,
  chapterId: string,
  opts?: { signal?: AbortSignal },
): Promise<ChapterPage> {
  const configured = plugin.maxChapterPages ?? 0;
  const limit = configured > 0 ? configured : Number.POSITIVE_INFINITY;
  const HARD_CAP = 500;

  const base = plugin.chapterHost ?? plugin.entry;
  const images: string[] = [];
  const seen = new Set<string>();

  let totalPages = 1;
  let page = 1;

  while (page <= limit && page <= HARD_CAP) {
    if (opts?.signal?.aborted) break;

    const pageId = page === 1 ? chapterId : `${chapterId}_${page}`;
    let html: string;
    try {
      html = await fetchText(
        plugin,
        new URL(fillTemplate(plugin.urls.chapter, { slug, id: pageId }), base).toString(),
        'chapter',
      );
    } catch {
      break; // 到头了
    }

    // 页面里的总页数标记，形如标题中的 "(1/4)"
    const tp = html.match(/\((\d+)\/(\d+)\)/);
    if (tp) {
      const declared = Number(tp[2]) || 1;
      if (page === 1) totalPages = Math.max(totalPages, declared);
    }

    /*
     * 真实图片地址在插件配置的属性上。
     * 很多站点 src 里是框架绑定符号（如 `[src]="chapter00Src"`），
     * 真实地址在 data-src —— 所以这里做成可配置而非硬编码。
     */
    const re = new RegExp(
      `${escapeRe(plugin.parse.imageAttr)}="(https?://[^"]+?\\.(?:jpg|jpeg|png|webp))"`,
      'gi',
    );
    const found = [...html.matchAll(re)].map((x) => x[1]);

    if (found.length === 0) break;

    let added = 0;
    for (const u of found) {
      if (seen.has(u)) continue;
      seen.add(u);
      images.push(proxied(u));
      added++;
    }
    if (added === 0) break; // 本页全是重复，说明到头了

    if (totalPages > 1 && page >= totalPages) break;
    page++;
  }

  return { totalPages, images };
}
