/**
 * twmanga / 包子漫畫 站点适配层
 *
 * 站点是 AMP + Vue 3 混合架构，纯 HTTP 可抓，不需要浏览器。
 *
 * 实测情报（2026-10-14）：
 *   搜索    GET /search?q=关键词
 *   详情    /comic/{拼音slug}   章节项 class="comics-chapters__item"
 *   跳板    /user/page_direct?comic_id=X&section_slot=S&chapter_slot=C  → 302
 *   章节页  twbzmg.com/comic/chapter/{slug}/{section}_{chapter}.html
 *   图片    真实 URL 在 data-src 属性里（src 是 Vue 绑定符号 [src]="chapter00Src"）
 *   防盗链  无，无 Referer 也能取到
 */

export const SITE = {
  /** 入口域名：搜索、分类、漫画详情 */
  entry: 'https://www.twmanga.com',
  /** 章节页实际域名（跳板 302 的落点） */
  chapter: 'https://www.twbzmg.com',
  /** 图片 CDN 前缀（用于 PWA 运行时缓存规则匹配） */
  imageHosts: ['bzcdn.net'],
  coverHosts: ['baozimh.com', 'xgcartoon.com', 'ttkan.co'],
} as const;

/** 图片 CDN 主机名在浏览器里不可枚举，这里仅用于判定，不参与请求 */
const IMAGE_URL_RE =
  /https:\/\/[a-z0-9.-]*(bzcdn\.net|baozimh\.com|xgcartoon\.com|ttkan\.co)\/[^\s"'<>]+/gi;

export interface Comic {
  /** 拼音 slug，全站唯一标识，如 dingjiqiyunqiaoqiaoxiulianqiannian-yuewenmanhua */
  slug: string;
  title: string;
  cover: string;
  /** 作者/来源标签 */
  author?: string;
  /** 分类标签 */
  tags?: string[];
  /** 简介 */
  description?: string;
  /** 是否完结 */
  finished?: boolean;
  /** 最新章节名 */
  latestChapter?: string;
}

export interface Chapter {
  /** 全站唯一标识，形如 "0_271" */
  id: string;
  /** 章节序号（从 1 开始，便于排序显示） */
  index: number;
  title: string;
  /** 完整章节页 URL */
  url: string;
}

export interface ChapterPage {
  /** 当前页码，从 1 开始 */
  page: number;
  /** 总页数 */
  totalPages: number;
  images: string[];
  /** 下一章的 id，没有则 undefined */
  nextChapterId?: string;
  /** 上一章的 id */
  prevChapterId?: string;
}

/** HTML 实体解码 —— AMP 输出会把 / 编码成 &#x2F;，& 编码成 &amp; */
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

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

async function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,zh-CN;q=0.8',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return decodeEntities(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/** 去掉 HTML 标签并压缩空白，用于把富文本简介变成纯文本 */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从卡片 HTML 抽取一部漫画。
 * 卡片结构：<div class="comics-card"><a href="/comic/{slug}" title="{标题}" class="comics-card__poster">
 *            <amp-img src="{封面}?w=..">...</amp-img></a><a class="comics-card__info">...</a></div>
 *
 * 注意：不能用 split(/comics-card/) —— 页面的 <style> 里也有 .comics-card 规则（实测 370 处，
 * 其中 350+ 在 CSS 里）。必须锚定 <div class="comics-card 这个真实标签开头。
 */
const CARD_RE = /<div class="comics-card[^"]*"[\s\S]*?(?=<div class="comics-card|<\/section>|<\/body>|$)/g;

function parseCards(html: string): Comic[] {
  const seen = new Set<string>();
  const out: Comic[] = [];

  for (const m of html.matchAll(CARD_RE)) {
    const block = m[0];
    const hrefM = block.match(/href="\/comic\/([^"?]+)"/);
    if (!hrefM) continue;
    const slug = hrefM[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const title =
      block.match(/title="([^"]+)"/)?.[1] ??
      block.match(/aria-label="([^"]+)"/)?.[1] ??
      block.match(/alt="([^"]+)"/)?.[1];

    // 封面：static-xx.x.com/cover/{slug}.jpg?w=..&h=..
    const coverM = block.match(
      /https:\/\/[^"'\s]*?\/cover\/[^"'\s?]+\.(?:jpg|jpeg|png|webp)/i,
    );
    // 最新章节：卡片信息里通常形如 "更新至 285  大軍撤退"
    const latestM = block.match(/更新至\s*([^<]{1,30})/);

    out.push({
      slug,
      title: title ? title.trim() : slug,
      cover: coverM?.[0] ?? '',
      latestChapter: latestM ? stripTags(latestM[1]).trim() : undefined,
    });
  }
  return out;
}

/** 搜索 / 分类列表页：抽取全部漫画卡片 */
export async function listComics(input: {
  query?: string;
  type?: string;
  region?: string;
  state?: string;
}): Promise<Comic[]> {
  const { query, type, region, state } = input;

  let url: string;
  if (query) {
    url = `${SITE.entry}/search?q=${encodeURIComponent(query)}`;
  } else {
    const p = new URLSearchParams({
      type: type ?? 'all',
      region: region ?? 'all',
      state: state ?? 'all',
      filter: '*',
    });
    url = `${SITE.entry}/classify?${p.toString()}`;
  }

  const html = await fetchHtml(url);
  return parseCards(html);
}

/** 拉一部漫画的完整详情（含章节列表） */
export async function getComic(slug: string): Promise<{ comic: Comic; chapters: Chapter[] }> {
  const html = await fetchHtml(`${SITE.entry}/comic/${slug}`);

  // 标题：<title>🍼頂級氣運，悄悄修煉千年 - 包子漫畫</title>
  const rawTitle = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? slug;
  const title = stripTags(rawTitle).replace(/[\s-]+(包子漫畫|包子漫画)$/, '').trim();

  // 封面
  const cover =
    html.match(/https:\/\/[^"'\s]*?\/cover\/[^"'\s?]+\.(?:jpg|jpeg|png|webp)/i)?.[0] ?? '';

  // 简介
  const descM =
    html.match(/class="comics-detail__description"[^>]*>([\s\S]{0,2000}?)<\/div>/)?.[1] ??
    html.match(/id="comic-desc"[^>]*>([\s\S]{0,2000}?)<\/div>/)?.[1];

  // 标签：分类面包屑
  const tags = [...html.matchAll(/class="comics-tags__item[^"]*"[^>]*>([^<]{1,20})</g)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  // 章节：<a href="/user/page_direct?comic_id=X&section_slot=S&chapter_slot=C"
  //       class="comics-chapters__item">268 帝境神通</a>
  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  const chapRe =
    /href="\/user\/page_direct\?comic_id=([^"&]+)(?:&amp;|&)section_slot=(\d+)(?:&amp;|&)chapter_slot=(\d+)"[^>]*class="comics-chapters__item"[^>]*>([\s\S]{0,120}?)<\/a>/g;

  let m: RegExpExecArray | null;
  while ((m = chapRe.exec(html))) {
    const [, , section, slot, rawTitle2] = m;
    const id = `${section}_${slot}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chapters.push({
      id,
      index: Number(slot),
      title: stripTags(rawTitle2) || `第 ${slot} 话`,
      url: `${SITE.chapter}/comic/chapter/${slug}/${id}.html`,
    });
  }

  // 站点章节顺序是倒序（新→旧），升序排回来便于阅读
  chapters.sort((a, b) => a.index - b.index);

  const finished = /已完結|完結|完结/.test(stripTags(html.slice(0, 4000)));

  return {
    comic: {
      slug,
      title,
      cover,
      description: descM ? stripTags(descM) : undefined,
      tags: tags.length ? tags : undefined,
      finished,
      latestChapter: chapters.length ? chapters[chapters.length - 1].title : undefined,
    },
    chapters,
  };
}

/**
 * 拉一章的全部图片（自动翻完所有内页）。
 * 页面 URL 形如 .../0_271.html，第 2 页起变成 .../0_271_2.html
 */
export async function getChapter(
  slug: string,
  chapterId: string,
  opts?: { maxPages?: number },
): Promise<ChapterPage> {
  const maxPages = opts?.maxPages ?? 20;
  const images: string[] = [];
  const seen = new Set<string>();

  let totalPages = 1;
  let page = 1;

  while (page <= maxPages) {
    const pageUrl =
      page === 1
        ? `${SITE.chapter}/comic/chapter/${slug}/${chapterId}.html`
        : `${SITE.chapter}/comic/chapter/${slug}/${chapterId}_${page}.html`;

    let html: string;
    try {
      html = await fetchHtml(pageUrl);
    } catch {
      break; // 404 说明没有下一页了
    }

    // 总页数藏在标题的 (1/4) 里
    const tp = html.match(/\((\d+)\/(\d+)\)/);
    if (tp && page === 1) totalPages = Number(tp[2]) || 1;

    // 真实图片在 data-src 里；src 是 Vue 绑定符号，不能用
    const imgs = [
      ...html.matchAll(/data-src="(https:\/\/[^"]+?\.(?:jpg|jpeg|png|webp))"/gi),
    ].map((x) => x[1]);

    if (imgs.length === 0) break;

    let added = 0;
    for (const u of imgs) {
      if (seen.has(u)) continue;
      seen.add(u);
      images.push(u);
      added++;
    }
    if (added === 0) break; // 本页图片全部重复，说明到头了

    // 优先信标题里的总页数，否则看有没有"下一页"链接
    if (totalPages > 1 && page >= totalPages) break;
    const hasNext = /class="[^"]*(?:next|下一)[^"]*"[\s\S]{0,200}?href="[^"]*_\d+\.html"/.test(html);
    if (!hasNext && totalPages <= 1) break;

    page++;
  }

  return { page: 1, totalPages, images };
}

/** 一次性取多张图的尺寸，用于剔除 140px 的分隔页 */
export async function getImageSizes(
  urls: string[],
): Promise<Record<string, { w: number; h: number }>> {
  const out: Record<string, { w: number; h: number }> = {};
  await Promise.all(
    urls.slice(0, 60).map(async (u) => {
      try {
        const res = await fetch(u, { headers: { 'User-Agent': MOBILE_UA } });
        if (!res.ok) return;
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        out[u] = { w: bmp.width, h: bmp.height };
        bmp.close();
      } catch {
        /* 尺寸拿不到不影响阅读，跳过 */
      }
    }),
  );
  return out;
}

/** 分类定义（从站点 /classify 页面实测得到） */
export const CATEGORIES = {
  region: [
    { key: 'all', label: '全部' },
    { key: 'cn', label: '国漫' },
    { key: 'jp', label: '日本' },
    { key: 'kr', label: '韩国' },
    { key: 'en', label: '欧美' },
  ],
  state: [
    { key: 'all', label: '全部' },
    { key: 'serial', label: '连载中' },
    { key: 'pub', label: '已完结' },
  ],
  type: [
    { key: 'all', label: '全部' },
    { key: 'lianai', label: '恋爱' },
    { key: 'chunai', label: '纯爱' },
    { key: 'gufeng', label: '古风' },
    { key: 'yineng', label: '异能' },
    { key: 'xuanyi', label: '悬疑' },
    { key: 'juqing', label: '剧情' },
    { key: 'kehuan', label: '科幻' },
    { key: 'qihuan', label: '奇幻' },
    { key: 'xuanhuan', label: '玄幻' },
    { key: 'chuanyue', label: '穿越' },
    { key: 'mouxian', label: '魔仙' },
    { key: 'tuili', label: '推理' },
    { key: 'wuxia', label: '武侠' },
    { key: 'gedou', label: '格斗' },
    { key: 'zhanzheng', label: '战争' },
    { key: 'rexie', label: '热血' },
  ],
} as const;

/** 剔除广告后能拿到的站点资源白名单（说明这些是内容，其余一律不要） */
export const CONTENT_ONLY = {
  /** 保留：漫画正文图 */
  keepImageHosts: ['bzcdn.net'],
  /** 剔除：追踪与广告 */
  blockHosts: [
    'googletagmanager.com',
    'statcounter.com',
    'outbrain.com',
    'doubleclick.net',
    'googlesyndication.com',
    'adnxs.com',
    'criteo.com',
  ],
  /** 站点自身的广告容器 class（若需浏览器渲染时用） */
  adSelectors: ['#div_top_ads', '.div_adhost', '.mobadsq', '.ad-container', 'amp-ad'],
} as const;
