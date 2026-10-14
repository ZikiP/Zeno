/**
 * 站点配置类型
 *
 * 设计原则：**框架不内置任何具体站点。**
 * 使用者自行填写站点地址与解析规则，仓库里不出现任何真实站点的域名或选择器。
 * 这既是技术上的解耦（站点改版只改配置不改代码），
 * 也是版权上的自我约束 —— 本项目只提供通用能力，不指向任何特定内容源。
 */

/** 标题提取方式：按属性名，或按标签名 */
export type TitleSource = { attr: string } | { tag: string };

/** 单个漫画站点的完整配置 */
export interface SiteConfig {
  /** 站点唯一标识，同时作为本地存储的命名空间 */
  id: string;
  /** 展示名 */
  name: string;
  /** 入口域名，例：https://example.com */
  entry: string;
  /** 章节页域名。留空则复用 entry。 */
  chapterHost?: string;

  /** 各页面的 URL 模板。{q}=搜索词，{slug}=漫画 slug，{id}=章节 id */
  urls: {
    /** 搜索，例：/search?q={q} */
    search: string;
    /** 分类列表。{type} {region} {state} */
    classify: string;
    /** 漫画详情，例：/comic/{slug} */
    detail: string;
    /** 章节正文。{slug} {id} */
    chapter: string;
  };

  /** HTML 解析规则 */
  parse: {
    /** 漫画卡片容器，按此切分出每部漫画。
     *  注意：这是字符串切分点，必须填标签开头（如 `<div class="card`），
     *  填 CSS 选择器会连 `<style>` 里的规则一起切进来。 */
    card: string;
    /** 卡片内提取 slug 的正则，需含一个捕获组 */
    slugFrom: string;
    /** 卡片内提取标题 */
    title: TitleSource;
    /** 卡片内提取封面 */
    cover: string;
    /** 章节条目选择器 */
    chapterItem: string;
    /** 章节正文图片：真实 URL 所在属性。
     *  注意：不少站点用框架绑定属性（如 data-src），而 src 里是占位符，
     *  所以这里做成可配置而非硬编码。 */
    imageAttr: string;
  };

  /** 图片 CDN 主机名后缀，用于离线缓存的运行时匹配规则 */
  imageHosts: string[];

  /**
   * 请求头。多数站点对非浏览器 UA 会返回降级内容或拒绝。
   */
  headers?: Record<string, string>;
}

/** 内置的空站点模板 —— 新建站点时以此为模板 */
export const SITE_TEMPLATE: Omit<SiteConfig, 'id' | 'name'> = {
  entry: 'https://example.com',
  urls: {
    search: '/search?q={q}',
    classify: '/classify?type={type}&region={region}&state={state}',
    detail: '/comic/{slug}',
    chapter: '/comic/chapter/{slug}/{id}.html',
  },
  parse: {
    card: '<div class="comic-card',
    slugFrom: 'href="/comic/([^"?]+)"',
    title: { attr: 'title' },
    cover: 'https?://[^"\'\\s]*?/cover/[^"\'\\s?]+\\.(?:jpg|jpeg|png|webp)',
    chapterItem: 'class="chapter-item"',
    imageAttr: 'data-src',
  },
  imageHosts: [],
  headers: {},
};

/** 校验用户填的配置，给出可读的错误 */
export function validateSite(c: SiteConfig): string[] {
  const errs: string[] = [];

  try {
    const u = new URL(c.entry);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
      errs.push('站点地址建议使用 https');
    }
  } catch {
    errs.push('站点地址不是合法 URL');
  }

  for (const key of ['search', 'classify', 'detail', 'chapter'] as const) {
    if (!c.urls[key]) errs.push(`缺少 URL 模板：urls.${key}`);
  }

  if (!c.parse.card) errs.push('缺少卡片选择器：parse.card');
  if (!c.parse.chapterItem) errs.push('缺少章节选择器：parse.chapterItem');
  if (!c.parse.imageAttr) errs.push('缺少图片属性名：parse.imageAttr');

  return errs;
}
