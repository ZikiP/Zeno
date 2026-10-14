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
    new URL(String(pl.entry ?? ''));
    // 这里原本把「非 https」也 push 进错误列表，但调用方把非空数组一律当
    // 阻断处理 —— 于是"建议使用 https"变成了硬拒绝，本地假源站（http://127.0.0.1）
    // 的插件根本导不进来。建议归建议，校验归校验。
  } catch {
    errs.push('entry 不是合法 URL');
  }
  if (pl.chapterHost) {
    try {
      new URL(pl.chapterHost);
    } catch {
      errs.push('chapterHost 不是合法 URL（留空表示复用 entry）');
    }
  }

  for (const k of ['search', 'classify', 'detail', 'chapter'] as const) {
    if (!pl.urls?.[k]) errs.push(`缺少 urls.${k}`);
    else validateTemplate(k, pl.urls[k], errs);
  }

  if (!pl.parse?.card) errs.push('缺少 parse.card（卡片起始片段）');
  if (!pl.parse?.slugFrom) errs.push('缺少 parse.slugFrom（slug 提取正则）');
  if (!pl.parse?.chapterItem) errs.push('缺少 parse.chapterItem（章节条目标识）');
  if (!pl.parse?.imageAttr) errs.push('缺少 parse.imageAttr（图片属性名）');

  /* 这几个字段会被直接喂给 new RegExp，写错一个括号就该在导入时拦住 */
  for (const field of ['slugFrom', 'cover', 'chapterIdFrom', 'noResultPattern'] as const) {
    const src = pl.parse?.[field];
    if (!src) continue;
    try {
      const groups = captureGroups(new RegExp(src));
      if (field === 'slugFrom' && groups < 1) {
        errs.push('parse.slugFrom 需要一个捕获组（取哪一段当 slug）');
      }
      if (field === 'chapterIdFrom' && groups < 2) {
        errs.push(
          'parse.chapterIdFrom 需要两个捕获组：第 1 组分区号、第 2 组章节序号。' +
            '少一个的话章节列表会是空的 —— 而且看上去像"这本书没章节"',
        );
      }
    } catch (e) {
      errs.push(`parse.${field} 不是合法正则：${(e as Error).message}`);
    }
  }

  const t = pl.parse?.title;
  if (!t || typeof t !== 'object') {
    errs.push('parse.title 应为 { attr: "属性名" } 或 { tag: "标签名" }');
  } else if (!('attr' in t ? t.attr : 'tag' in t ? t.tag : '')) {
    errs.push('parse.title 的 attr / tag 至少要有一个非空');
  }

  if (pl.imageHosts !== undefined) {
    if (!Array.isArray(pl.imageHosts)) {
      errs.push('imageHosts 应为字符串数组（图片 CDN 的域名后缀）');
    }
    for (const h of Array.isArray(pl.imageHosts) ? pl.imageHosts : []) {
      if (typeof h !== 'string' || !h.trim()) {
        errs.push('imageHosts 里有空值或非字符串');
      } else if (/[:/\\\s*@]/.test(h)) {
        errs.push(
          `imageHosts 只写域名后缀，不带协议和路径："${h}"（例："bzcdn.net"，前面可加点）`,
        );
      }
    }
  }

  if (pl.maxChapterPages !== undefined) {
    const n = pl.maxChapterPages;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      errs.push('maxChapterPages 应为非负整数（0 或不填 = 不限）');
    }
  }

  if (pl.fetch) {
    if (typeof pl.fetch !== 'object') {
      errs.push('fetch 应为对象');
    } else {
      const m = pl.fetch.mode;
      const isMode = (v: unknown) => v === 'fetch' || v === 'browser';
      if (m !== undefined && typeof m === 'string') {
        if (!isMode(m)) errs.push(`fetch.mode 只能是 "fetch" 或 "browser"，实际为 "${String(m)}"`);
      } else if (m !== undefined && typeof m === 'object' && m !== null) {
        for (const [k, v] of Object.entries(m)) {
          if (!['list', 'detail', 'chapter'].includes(k)) {
            errs.push(`fetch.mode 的键只能是 list / detail / chapter，出现 "${k}"`);
          }
          if (!isMode(v)) errs.push(`fetch.mode.${k} 只能是 "fetch" 或 "browser"`);
        }
      } else if (m !== undefined) {
        errs.push('fetch.mode 应为字符串或 { list, detail, chapter } 对象');
      }
      const w = pl.fetch.waitFor;
      if (w !== undefined && typeof w !== 'string' && (typeof w !== 'object' || w === null)) {
        errs.push('fetch.waitFor 应为 CSS 选择器字符串，或 { list, detail, chapter } 对象');
      }
      if (pl.fetch.timeoutMs !== undefined) {
        const ts = pl.fetch.timeoutMs;
        if (typeof ts !== 'number' || ts < 1000 || ts > 120_000) {
          errs.push('fetch.timeoutMs 应为 1000–120000 之间的毫秒数');
        }
      }
    }
  }

  return errs;
}

/**
 * 每种 URL 模板能用的占位符。
 *
 * 这是唯一一份定义 —— fillTemplate 的调用方（engine.ts）和导入校验都从这里取，
 * 不会出现在「引擎多支持了一个变量但校验还当它是错的」那种漂移。
 */
export const URL_VARS: Record<keyof Plugin['urls'], string[]> = {
  search: ['q'],
  classify: ['type', 'region', 'state'],
  detail: ['slug'],
  chapter: ['slug', 'id'],
};

/**
 * 检查一个 URL 模板。
 *
 * 为什么值得单独校验：fillTemplate 对认不出的占位符是**替换成空串**的。
 * 于是把 {slug} 写成 {slugg}、或者 detail 里干脆没有 {slug}，
 * 插件照样导得进来，但每一本漫画都会打开同一个页面 ——
 * 看上去像站点坏了，实际是配置里的一个打字错误。
 */
function validateTemplate(kind: keyof Plugin['urls'], tpl: string, errs: string[]) {
  const used = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const allowed = URL_VARS[kind];

  for (const v of used) {
    if (!allowed.includes(v)) {
      errs.push(`urls.${kind} 里有不认识的占位符 {${v}}，可用的是 ${allowed.map((a) => `{${a}}`).join(' ')}`);
    }
  }

  /*
   * detail 必须靠 {slug} 定位到具体漫画；chapter 必须靠 {id} 定位到具体章节。
   * 少了这些，所有请求都会打到同一个 URL 上。
   * {slug} 在 chapter 里是可选的 —— 有些站的章节地址只有 id。
   * classify 全部可选（有的站的分类页参数是固定写法）。
   */
  const required = kind === 'detail' ? ['slug'] : kind === 'chapter' ? ['id'] : [];
  for (const v of required) {
    if (!used.includes(v)) errs.push(`urls.${kind} 必须包含 {${v}}，否则每本书都会取到同一个地址`);
  }
}

/**
 * 数正则里有几个捕获组。
 *
 * 只看 `(` 后面是不是 `?`：`(?:` `(?=` `(?!` `(?<` 都不产生捕获。
 * 不处理字符类里的括号（`[(]`）—— 插件真写成那样属于自找，不值得为它加状态机。
 */
function captureGroups(re: RegExp): number {
  let n = 0;
  const s = re.source;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '(' && s[i + 1] !== '?') n++;
  }
  return n;
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
