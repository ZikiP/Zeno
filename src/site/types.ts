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

/** 取源方式：直接 HTTP，还是用浏览器引擎渲染 */
export type FetchMode = 'fetch' | 'browser';

/** 需要取 HTML 的页面类型。图片不属于任何一类 —— 它永远走 fetch */
export type PageKind = 'list' | 'detail' | 'chapter';

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
     * 从章节链接里提取 id 的正则。捕获组个数决定 id 的形态：
     *
     *  - **两组** = 分区号 + 章节序号，拼成 `{section}_{index}`，并按序号排序。
     *    章节 URL 有路径式（`/chapter/{slug}/0_562.html`）和参数式
     *    （`/page_direct?comic_id=X&section_slot=0&chapter_slot=562`）两种常见形态，
     *    两者的 id 都是「section_序号」，所以用同一个正则覆盖。
     *  - **一组** = 整段匹配到的就是 id，不拆分区/序号，顺序按页面里出现的先后。
     *    给 UUID 这类没有"序号"概念的章节地址用
     *    （例 `/chapter/d2bb9687-f9a6-11ef-878e-fa163e02432f`）。
     *    注意这类站点的章节地址通常配不上 `_{page}` 的内页后缀，
     *    需要配 fetch.capture 一次取整章 —— 见下面 fetch 段的说明。
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

  /**
   * 取源方式，可按页面类型分别设置。
   *
   * - `'fetch'`（默认，省略即此）：服务端直接 HTTP 取 HTML。快，但拿不到需要
   *   执行 JS 才出内容的页面 —— 前端渲染的站点、以及带 JS 质询网关的站点都会失败。
   * - `'browser'`：服务端用一个真的浏览器引擎渲染后再取 HTML。慢、占内存，
   *   但能拿到 JS 渲染后的结果。
   *
   * **写成字符串 = 对所有页面类型用同一种方式，通常不是你要的。**
   * 实测包子漫画：质询只在 baozimh.com，章节页所在的 twmanga.com 根本没有，
   * 全局 browser 于是让每一页阅读都白付约 2s，还挤占抓取并发槽。
   * 分开写就是列表/详情用 browser、章节用 fetch。
   *
   * 只作用于 HTML 文档（列表 / 详情 / 章节页）。**图片永远走 fetch** ——
   * `<img>` 用不上渲染结果，给每张图开一次浏览器也不合理。
   */
  fetch?: {
    mode?: FetchMode | Partial<Record<PageKind, FetchMode>>;
    /**
     * browser 模式：渲染后等这个 CSS 选择器出现再取 HTML，缺省等 load。
     * 也可以按页面类型分别给（{ list, detail, chapter }）—— 列表页和详情页
     * 要等的东西本来就不是同一个，共用一个必然有一边等错。
     */
    waitFor?: string | Partial<Record<PageKind, string>>;
    /**
     * 选择器要**攒够几条**才算渲染到位，配合 waitFor 用，缺省 1（出现过即可）。
     *
     * 为什么需要它：不少站点的 SSR 壳里已经有一条真的章节链接。
     * 实测拷貝漫畫详情页服务端 HTML 里正好 1 条，等「出现过」就在几百毫秒收摊，
     * 用户看到的目录就只有第一章；等够 20 条时同一页能拿到 375 条。
     */
    minCount?: number | Partial<Record<PageKind, number>>;
    /**
     * 从页面 JS 解出来的数据里直接抓地址，而不是从 DOM 里抓。
     *
     * 用在哪：有的站点接口回文是加密的，它自己的代码解密后交给 JSON.parse，
     * 再逐张挂进 DOM —— 而且翻页式阅读器同一时刻只挂 3 张图。这种站从 HTML
     * 正则不出整章，**翻页也翻不出来**（URL 参数它根本不看）。
     *
     * 填法是**正则源码，需含一个捕获组**（第 1 组就是要的地址）：
     * `"chapter": "\"url\"\\s*:\\s*\"([^\"]+)\""`
     *
     * 机制：服务端在页面加载前包住 JSON.parse，把命中这条正则的值按出现顺序
     * 去重攒起来，攒到第一条就立刻返回 —— 不做任何解密，只是看站点自己的代码
     * 亲手算出来、并且已经交给它自己渲染的东西。
     *
     * 为什么放在 fetch 而不是 parse：**它和 waitFor 是互斥的判据**。声明了 capture
     * 就以它为准，选择器先出现不能算数（SSR 壳里那张占位图总是先出现）。
     * 所以必须按页面类型分别声明，通常只给 chapter 配。
     * 抓空了会自动回落取 HTML，parse.imageAttr 的老路仍然是兜底。
     */
    capture?: string | Partial<Record<PageKind, string>>;
    /** 单次取源上限，默认 20000ms */
    timeoutMs?: number;
  };

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
