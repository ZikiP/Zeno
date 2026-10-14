/**
 * 内容源插件类型
 *
 * 设计原则：**框架不内置任何具体插件。**
 * 插件是一份可导入导出的 JSON 描述文件，说明「去哪里、页面长什么样、怎么解析」。
 * 本项目只提供插件格式与加载机制，不附带任何现成插件。
 *
 * 这样既让站点适配可分享，也保证仓库与任何具体内容源无关。
 */

/** 标题提取方式：按属性名，或按标签名 */
export type TitleSource = { attr: string } | { tag: string };

/** 插件格式版本，用于将来做兼容 */
export const PLUGIN_FORMAT = 'zeno-plugin@1';

/** 一份内容源插件 */
export interface Plugin {
  /** 格式标识 + 版本 */
  format: typeof PLUGIN_FORMAT;

  /** 插件元信息 */
  meta: {
    /** 唯一标识，同一 id 视为同一个插件 */
    id: string;
    /** 展示名 */
    name: string;
    /** 一句话描述 */
    description?: string;
    /** 作者署名，导入他人插件时保留 */
    author?: string;
    /** 版本号 */
    version?: string;
    /** 主页或来源地址 */
    homepage?: string;
    /** 图标，可为 emoji 或 http(s) 图片地址 */
    icon?: string;
    /** 标签，用于分类与检索 */
    tags?: string[];
  };

  /** 入口地址 */
  entry: string;
  /** 章节页地址。留空则复用 entry。 */
  chapterHost?: string;

  /** 页面 URL 模板。{q}=搜索词，{slug}=漫画 slug，{id}=章节 id */
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
     *  填 CSS 选择器会连 `<style>` 里的 CSS 规则一起切进来。 */
    card: string;
    /** 卡片内提取 slug 的正则，需含一个捕获组 */
    slugFrom: string;
    /** 卡片内提取标题 */
    title: TitleSource;
    /** 卡片内提取封面 */
    cover: string;
    /** 章节条目标识。会出现在 <a> 的 class 里 */
    chapterItem: string;
    /**
     * 从章节链接里提取 id 的正则，需含**两个**捕获组：
     * 第 1 组 = section（分卷/分区号），第 2 组 = 章节序号。
     *
     * 为什么要两个？因为章节 URL 有两种常见形态：
     *   - 路径式：`/chapter/{slug}/0_562.html` → 直接从路径取
     *   - 参数式：`/page_direct?comic_id=X&section_slot=0&chapter_slot=562` → 必须从参数取
     * 两者的 id 都是「section_序号」的形式，统一拼成 `{section}_{index}`。
     */
    chapterIdFrom: string;
    /** 章节正文图片：真实 URL 所在属性。
     *  注意：不少站点用框架绑定属性（如 data-src），而 src 里是占位符，
     *  所以这里做成可配置而非硬编码。 */
    imageAttr: string;

    /**
     * 该站点「搜索无结果」的特征正则。留空则不启用。
     *
     * 有些站点会明确写「未找到」，程序已内置识别。
     * 但也有站点对查不到的查询直接塞推荐列表，**不留任何标记** ——
     * 这种情况下只能由插件作者观察该站实际行为后，填一个能识别它的正则。
     *
     * 例：结果区是个空 div 时填 `<div class="result-list"></div>`
     */
    noResultPattern?: string;
  };

  /** 图片 CDN 主机名后缀。用于代理白名单提示与离线缓存。 */
  imageHosts: string[];

  /**
   * 单章最多翻多少个内页。0 = 不限。
   * 站点把长章节拆成多个 URL 时（如 `0_271.html`、`0_271_2.html`…）需要逐页抓取。
   * 默认不限，因为硬性截断会让人误以为"读完了"而实际后面还有。
   */
  maxChapterPages?: number;

  /** 请求头。多数站点对非浏览器 UA 会返回降级内容或拒绝。 */
  headers?: Record<string, string>;
}

/** 新建空白插件时用的模板 */
export const PLUGIN_TEMPLATE: Omit<Plugin, 'meta'> = {
  format: PLUGIN_FORMAT,
  entry: 'https://example.com',
  urls: {
    search: '/search?q={q}',
    classify: '/classify?region={region}&state={state}',
    detail: '/comic/{slug}',
    chapter: '/comic/chapter/{slug}/{id}.html',
  },
  parse: {
    card: '<div class="comic-card',
    slugFrom: 'href="/comic/([^"?]+)"',
    title: { attr: 'title' },
    cover: 'https?://[^"\'\\s]*?/cover/[^"\'\\s?]+\\.(?:jpg|jpeg|png|webp)',
    chapterItem: 'class="chapter-item"',
    chapterIdFrom: 'section_slot=(\\d+)&chapter_slot=(\\d+)',
    imageAttr: 'data-src',
  },
  headers: {},
  imageHosts: [],
};

/** 校验插件，返回可读的错误列表。空数组 = 通过 */
export function validatePlugin(p: unknown): string[] {
  const errs: string[] = [];

  if (typeof p !== 'object' || p === null) {
    return ['文件不是有效的 JSON 对象'];
  }
  const pl = p as Partial<Plugin>;

  if (pl.format !== PLUGIN_FORMAT) {
    errs.push(`格式标识不对，应为 "${PLUGIN_FORMAT}"，实际为 "${String(pl.format)}"`);
  }
  if (!pl.meta?.id) errs.push('缺少 meta.id');
  if (!pl.meta?.name) errs.push('缺少 meta.name');

  try {
    const u = new URL(String(pl.entry ?? ''));
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
      errs.push('entry 建议使用 https');
    }
  } catch {
    errs.push('entry 不是合法 URL');
  }

  for (const k of ['search', 'classify', 'detail', 'chapter'] as const) {
    if (!pl.urls?.[k]) errs.push(`缺少 urls.${k}`);
  }

  if (!pl.parse?.card) errs.push('缺少 parse.card（卡片起始片段）');
  if (!pl.parse?.slugFrom) errs.push('缺少 parse.slugFrom（slug 提取正则）');
  if (!pl.parse?.chapterItem) errs.push('缺少 parse.chapterItem（章节条目标识）');
  if (!pl.parse?.chapterIdFrom) {
    errs.push('缺少 parse.chapterIdFrom（章节 id 提取正则，需两个捕获组：分区、序号）');
  } else {
    try {
      new RegExp(pl.parse.chapterIdFrom);
    } catch {
      errs.push('parse.chapterIdFrom 不是合法正则');
    }
  }
  if (!pl.parse?.imageAttr) errs.push('缺少 parse.imageAttr（图片属性名）');

  return errs;
}

/**
 * 从插件中提取代理需要放行的域名。
 * 供界面提示用户填写 ALLOWED_HOSTS 用。
 */
export function pluginHosts(p: Plugin): string[] {
  const hosts = new Set<string>();
  const add = (raw?: string) => {
    if (!raw) return;
    try {
      hosts.add(new URL(raw).hostname);
    } catch {
      /* 忽略非法地址 */
    }
  };
  add(p.entry);
  add(p.chapterHost);
  for (const h of p.imageHosts ?? []) {
    if (h) hosts.add(h);
  }
  return [...hosts];
}
