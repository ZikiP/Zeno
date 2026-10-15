import { PLUGIN_FORMAT, type Plugin } from './types';
import { validateTemplate } from './url-template';

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
      if (field === 'chapterIdFrom') {
        if (groups < 1) {
          errs.push('parse.chapterIdFrom 至少需要一个捕获组（取哪一段当章节 id）');
        } else if (groups > 2) {
          errs.push(
            `parse.chapterIdFrom 只用 1 或 2 个捕获组，现在 ${groups} 个 —— ` +
              '多出来的组会混进 id，章节列表会指向打不开的地址',
          );
        }
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

      /*
       * minCount：等选择器攒够几条。0 和负数会让"等够 N 条"永远成立，
       * 等于没等，还比什么都不写更早收摊。
       */
      const mc = pl.fetch.minCount;
      if (mc !== undefined) {
        const vals =
          typeof mc === 'number'
            ? [mc]
            : mc && typeof mc === 'object'
              ? Object.values(mc)
              : null;
        if (!vals) {
          errs.push('fetch.minCount 应为正整数，或 { list, detail, chapter } 对象');
        } else {
          for (const n of vals) {
            if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
              errs.push('fetch.minCount 每一项都应是 >= 1 的整数（等够几条才算渲染到位）');
            }
          }
          if (mc && typeof mc === 'object') {
            for (const k of Object.keys(mc)) {
              if (!['list', 'detail', 'chapter'].includes(k)) {
                errs.push(`fetch.minCount 的键只能是 list / detail / chapter，出现 "${k}"`);
              }
            }
          }
        }
      }

      /*
       * capture：从页面 JS 解出来的数据里直接抓地址。
       * 这条正则会**在站点自己的页面里**编译执行，所以括号、组数都得对；
       * 更要紧的是它只在渲染模式下有意义 —— 直接 HTTP 取 HTML 时没有页面 JS，
       * 这条会整条被静默忽略，作者只会看到"章节是空的"。
       */
      const cap = pl.fetch.capture;
      const modeOf = (k: 'list' | 'detail' | 'chapter') => {
        const m = pl.fetch?.mode;
        if (!m) return 'fetch';
        return typeof m === 'string' ? m : (m[k] ?? 'fetch');
      };
      if (cap !== undefined) {
        if (typeof cap === 'string') {
          errs.push(
            'fetch.capture 必须按页面类型写，例 { "chapter": "..." }：' +
              '它和 waitFor 是互斥判据，写成全局会让列表页也去抢捕获',
          );
        } else if (typeof cap !== 'object' || cap === null) {
          errs.push('fetch.capture 应为 { list, detail, chapter } 对象');
        } else {
          for (const [k, v] of Object.entries(cap)) {
            if (!['list', 'detail', 'chapter'].includes(k)) {
              errs.push(`fetch.capture 的键只能是 list / detail / chapter，出现 "${k}"`);
              continue;
            }
            const kind = k as 'list' | 'detail' | 'chapter';
            if (typeof v !== 'string' || !v) {
              errs.push(`fetch.capture.${kind} 应为非空正则源码`);
            } else {
              try {
                if (captureGroups(new RegExp(v)) < 1) {
                  errs.push(
                    `fetch.capture.${kind} 需要一个捕获组 —— 第 1 组就是要取的地址，` +
                      '没有组的话抓到的是整段匹配文本',
                  );
                }
              } catch (e) {
                errs.push(`fetch.capture.${kind} 不是合法正则：${(e as Error).message}`);
              }
            }
            if (modeOf(kind) !== 'browser') {
              errs.push(
                `fetch.capture.${kind} 声明了，但 fetch.mode.${kind} 不是 "browser" —— ` +
                  '不渲染就没有页面 JS 可捕获，这条会整条被忽略',
              );
            }
          }
        }
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
