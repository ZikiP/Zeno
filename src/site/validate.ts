import { PLUGIN_FORMAT, type Plugin } from './types';

/**
 * 插件格式的导入期校验
 *
 * 从 types.ts 拆出来：那边是「格式长什么样」（被半个项目 import），
 * 这边是「怎么判断一份 JSON 合不合格」。混在一起时改一条校验规则
 * 都要在 300 行类型定义里翻。
 *
 * 原则：只拦"导得进来但一定用不了"的写法。
 * 能容错的（比如某个可选字段没填）不报错 —— 拦太严会让用户以为是框架挑站点。
 */

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
