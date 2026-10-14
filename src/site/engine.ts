/**
 * 通用抓取引擎
 *
 * 全部站点相关行为都由 SiteConfig 驱动，代码本身不含任何站点信息。
 * 站点改版只需在设置里改配置，不动代码。
 */
import type { SiteConfig } from './types';

export interface Comic {
  slug: string;
  title: string;
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
  url: string;
}

export interface ChapterPage {
  totalPages: number;
  /** 已过代理的图片地址 */
  images: string[];
}

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/** HTML 实体解码 —— 很多站点（含 AMP）会把 / 编码成 &#x2F; */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** 去掉标签、压缩空白 */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 转义正则元字符，让用户填的选择器能安全进 RegExp */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** URL 模板填充 */
function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

/**
 * 代理路径。浏览器环境必走代理（目标站点通常无 CORS 头）；
 * Node 环境直连（本就没有跨域限制）。
 */
export const PROXY_PATH = '/api/proxy';

export function proxied(url: string): string {
  if (typeof window === 'undefined') return url;
  return `${PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

/** 封面地址：拼 CDN 尺寸参数后过代理 */
export function coverUrl(rawCover: string, w: number, h: number): string {
  if (!rawCover) return '';
  return proxied(`${rawCover}?w=${w}&h=${h}&q=85`);
}

/* ── 底层请求 ─────────────────────────────────────── */

async function fetchText(
  site: SiteConfig,
  url: string,
  timeoutMs = 20000,
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(proxied(url), {
        headers: {
          'User-Agent': site.headers?.['User-Agent'] ?? DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': site.headers?.['Accept-Language'] ?? 'zh-TW,zh;q=0.9',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decodeEntities(await res.text());
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`${(lastErr as Error)?.message ?? 'unknown'} — ${url}`);
}

/* ── 列表页 ───────────────────────────────────────── */

function parseCards(html: string, site: SiteConfig): Comic[] {
  // card 是一个「容器起始片段」，用它切分出每部漫画的 HTML 块。
  // 必须转义后作为字符串切分点 —— 用户可能填 class 选择器或标签名。
  const marker = escapeRe(site.parse.card);
  const blocks = html.split(marker).slice(1);

  const slugRe = new RegExp(site.parse.slugFrom);
  const coverRe = new RegExp(site.parse.cover);

  const seen = new Set<string>();
  const out: Comic[] = [];

  for (const block of blocks) {
    const m = block.match(slugRe);
    if (!m) continue;
    const slug = m[1] ?? m[0];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    let title = '';
    if ('attr' in site.parse.title && site.parse.title.attr) {
      title = block.match(new RegExp(`${escapeRe(site.parse.title.attr)}="([^"]+)"`))?.[1] ?? '';
    } else if ('tag' in site.parse.title && site.parse.title.tag) {
      const tag = site.parse.title.tag.replace(/[<>/\s]/g, '');
      title = stripTags(
        block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{0,200}?)</${tag}>`, 'i'))?.[1] ?? '',
      );
    }

    out.push({
      slug,
      title: title.trim() || slug,
      cover: block.match(coverRe)?.[0] ?? '',
      latestChapter: stripTags(
        block.match(/更新至\s*([^<]{1,30})/)?.[1] ?? '',
      ).trim() || undefined,
    });
  }
  return out;
}

export async function listComics(
  site: SiteConfig,
  filter: { query?: string; type?: string; region?: string; state?: string } = {},
): Promise<Comic[]> {
  const url = filter.query
    ? new URL(fill(site.urls.search, { q: filter.query }), site.entry).toString()
    : new URL(
        fill(site.urls.classify, {
          type: filter.type ?? 'all',
          region: filter.region ?? 'all',
          state: filter.state ?? 'all',
        }),
        site.entry,
      ).toString();

  return parseCards(await fetchText(site, url), site);
}

/* ── 详情页 ───────────────────────────────────────── */

export async function getComic(
  site: SiteConfig,
  slug: string,
): Promise<{ comic: Comic; chapters: Chapter[] }> {
  const html = await fetchText(site, new URL(fill(site.urls.detail, { slug }), site.entry).toString());

  const rawTitle = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? slug;
  const title = stripTags(rawTitle).replace(/[\s-]+\S{2,12}$/, '').trim() || slug;

  const cover =
    html.match(new RegExp(site.parse.cover))?.[0] ??
    html.match(/https?:\/\/[^"'\s]*?\/cover\/[^"'\s?]+\.(?:jpg|jpeg|png|webp)/i)?.[0] ??
    '';

  const descM =
    html.match(/class="[^"]*(?:desc|summary|intro)[^"]*"[^>]*>([\s\S]{0,2000}?)<\/div>/i)?.[1] ?? '';

  const tags = [...html.matchAll(/class="[^"]*tag[^"]*"[^>]*>([^<]{1,20})</g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .slice(0, 10);

  // 章节条目：把选择器转成「捕获该元素的 HTML 块」的宽松匹配
  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  const itemRe = new RegExp(
    `(${escapeRe(site.parse.chapterItem)})([\\s\\S]{0,300}?)<\\/a>`,
    'gi',
  );

  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html))) {
    const block = m[2] ?? '';
    const hrefM = block.match(/href="([^"]+)"/);
    if (!hrefM) continue;

    // 章节 id：优先从 href 里取数字组合，退化用 href 哈希
    const nums = hrefM[1].match(/(\d+)[^\d]*?(\d+)?\.html|chapter_slot=(\d+)/);
    const id =
      hrefM[1].match(/(\d+)_(\d+)(?:_(\d+))?\.html/)?.[0]?.replace(/\.html$/, '') ??
      hrefM[1].split('/').pop()?.replace(/\.html.*$/, '') ??
      m.index?.toString();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const chapterTitle = stripTags(
      block.match(/>([\s\S]{0,120}?)<\/a>/)?.[1] ?? block,
    ).slice(0, 80);

    chapters.push({
      id,
      index: Number(id.match(/(\d+)_(\d+)/)?.[2] ?? id.match(/(\d+)/)?.[1] ?? 0),
      title: chapterTitle || `第 ${id} 话`,
      url: new URL(fill(site.urls.chapter, { slug, id }), site.chapterHost ?? site.entry).toString(),
    });
    void nums;
  }

  chapters.sort((a, b) => a.index - b.index);

  return {
    comic: {
      slug,
      title,
      cover,
      description: descM ? stripTags(descM) : undefined,
      tags: tags.length ? tags : undefined,
      finished: /完結|完结|已完結/.test(stripTags(html.slice(0, 4000))),
      latestChapter: chapters.at(-1)?.title,
    },
    chapters,
  };
}

/* ── 章节正文 ─────────────────────────────────────── */

export async function getChapter(
  site: SiteConfig,
  slug: string,
  chapterId: string,
  opts?: { maxPages?: number },
): Promise<ChapterPage> {
  const maxPages = opts?.maxPages ?? 30;
  const base = site.chapterHost ?? site.entry;
  const images: string[] = [];
  const seen = new Set<string>();

  let totalPages = 1;
  let page = 1;

  while (page <= maxPages) {
    // 长章节会分页：首屏 {id}.html，后续 {id}_{n}.html
    const pageId = page === 1 ? chapterId : `${chapterId}_${page}`;
    let html: string;
    try {
      html = await fetchText(site, new URL(fill(site.urls.chapter, { slug, id: pageId }), base).toString());
    } catch {
      break; // 到头了
    }

    const tp = html.match(/\((\d+)\/(\d+)\)/);
    if (tp && page === 1) totalPages = Number(tp[2]) || 1;

    // 关键：真实 URL 在配置的属性上（很多站点 src 里是框架绑定符号）
    const re = new RegExp(
      `${escapeRe(site.parse.imageAttr)}="(https?://[^"]+?\\.(?:jpg|jpeg|png|webp))"`,
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
    if (added === 0) break;

    if (totalPages > 1 && page >= totalPages) break;
    page++;
  }

  return { totalPages, images };
}
