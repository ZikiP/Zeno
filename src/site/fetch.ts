import type { FetchMode, PageKind, Plugin } from './types';

/**
 * 请求层
 *
 * 负责「怎么把一个 URL 变成 HTML 文本」，以及代理包装。
 * 解析逻辑在 engine.ts，两者分开是因为请求失败的处理方式和解析完全不同。
 */

export const PROXY_PATH = '/api/proxy';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/**
 * 把上游地址包进代理。
 *
 * 浏览器环境一定走代理（目标站点通常无 CORS 头，直连必被拦）。
 * Node 环境默认直连 —— 探针脚本在那边跑，没有跨域限制。
 *
 * 但 Node 直连拿不到 `fetch.mode="browser"` 的效果：渲染是服务端做的。
 * 所以设了 ZENO_PROXY 时 Node 也走代理，命令行验证插件才能覆盖到
 * 需要渲染的站点（否则 browser 模式的插件在脚本里永远是 0 条结果，
 * 看着像站点坏了）。
 *
 * mode='browser' 让服务端用浏览器引擎渲染后再回 HTML。只有取文档时才传；
 * 图片走 coverUrl / 章节图片列表，永远是默认的 fetch。
 *
 * waitFor 必须一起传 —— 服务端渲染时要等这个选择器出现，否则只能靠
 * waitForLoadState('load') 赌注入时机，内容稍慢一点就抓回空壳。
 * （实测过：同一份插件，一次拿到 10 张卡片，一次 0 张，就是这个原因。）
 */
export function proxied(
  url: string,
  mode: 'fetch' | 'browser' = 'fetch',
  waitFor?: string,
): string {
  const base = nodeProxyBase();
  if (typeof window === 'undefined' && !base) return url;
  const origin = typeof window === 'undefined' ? base! : '';
  let out = `${origin}${PROXY_PATH}?url=${encodeURIComponent(url)}`;
  if (mode !== 'browser') return out;
  out += `&mode=browser`;
  if (waitFor) out += `&waitFor=${encodeURIComponent(waitFor)}`;
  return out;
}

/** Node 端有没有指定要经过的代理地址。浏览器构建里 process 不存在 */
function nodeProxyBase(): string {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.ZENO_PROXY?.replace(/\/+$/, '') ?? '';
}

/**
 * 封面地址：拼 CDN 的尺寸参数后过代理。
 *
 * 不能无条件 `url + '?w=...'` —— 很多站的封面本来就带 query
 * （包子漫画是 `...jpg?w=285&h=375&q=100`），那样拼出来是
 * `...jpg?w=285&h=375&q=100?w=300&h=400&q=85`，第二个 ? 落在值里，
 * 参数全废。用 URL 设置参数才会正确合并。
 */
export function coverUrl(rawCover: string, w: number, h: number): string {
  if (!rawCover) return '';
  let url = rawCover;
  try {
    const u = new URL(rawCover);
    u.searchParams.set('w', String(w));
    u.searchParams.set('h', String(h));
    u.searchParams.set('q', '85');
    url = u.toString();
  } catch {
    url = `${rawCover}${rawCover.includes('?') ? '&' : '?'}w=${w}&h=${h}&q=85`;
  }
  return proxied(url);
}

/** HTML 实体解码 —— AMP 之类会把 / 编码成 &#x2F;，不解码就取不到 URL */
export function decodeEntities(s: string): string {
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

/** 去掉标签、压缩空白。用于把富文本简介变成纯文本 */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 转义正则元字符，让插件里填的选择器能安全进 RegExp */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析某类页面该用哪种取源方式。
 *
 * fetch.mode 可以是一个字符串（所有页面同一种），也可以是
 * { list, detail, chapter } 对象（分别指定，缺省的那项回落到 fetch）。
 * 支持分开写是因为实测发现质询常常只挂在主站域名上，章节页在另一个域、
 * 根本不需要渲染 —— 全局 browser 会让最高频的操作白付几秒并挤占并发槽。
 */
export function modeFor(plugin: Plugin, kind: PageKind): FetchMode {
  const m = plugin.fetch?.mode;
  if (!m) return 'fetch';
  if (typeof m === 'string') return m;
  return m[kind] ?? 'fetch';
}

/** waitFor 同样支持字符串或按页面类型分别给 */
export function waitForFor(plugin: Plugin, kind: PageKind): string | undefined {
  const w = plugin.fetch?.waitFor;
  if (!w) return undefined;
  if (typeof w === 'string') return w;
  return w[kind];
}

/**
 * 取源失败。
 *
 * `status` 只在上游真的回了 HTTP 状态时才有，它是「这个页面不存在」和
 * 「网络/渲染出问题了」唯一的区分依据 —— 翻页循环把后者当前者，
 * 表现就是一章莫名其妙短了几页而界面上一切正常。
 */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(`${message} — ${url}`);
    this.name = 'FetchError';
  }
}

/** 取上游页面的 HTML，带退避重试。
 *
 * 重试是必需的：实测同一 URL 连测 4 次都 200，但并发放几个请求时
 * 会偶发 `fetch failed`（站点掐短时间多连接）。3 次尝试足够覆盖。
 *
 * browser 模式只试一次 —— 一次渲染就要几秒，而它失败的原因（页面确实没
 * 渲染出内容 / 被质询挡住）重试也不会变，三次串起来只是把一次卡死放大三倍。
 *
 * 404/410 也不重试：那是"这个 URL 就是没有"，重试只会把失败拖成三倍久。
 */
export async function fetchText(
  plugin: Plugin,
  url: string,
  kind: PageKind = 'list',
  timeoutMs = plugin.fetch?.timeoutMs ?? 20_000,
): Promise<string> {
  let lastErr: unknown;
  const mode = modeFor(plugin, kind);
  const attempts = mode === 'browser' ? 1 : 3;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(proxied(url, mode, mode === 'browser' ? waitForFor(plugin, kind) : undefined), {
        headers: {
          // Node 端（探针）直连，需要伪装 UA；浏览器端设了也无效，代理已带
          'User-Agent': plugin.headers?.['User-Agent'] ?? DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': plugin.headers?.['Accept-Language'] ?? 'zh-TW,zh;q=0.9,zh-CN;q=0.8',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
      return decodeEntities(await res.text());
    } catch (e) {
      lastErr = e;
      const status = e instanceof FetchError ? e.status : undefined;
      const retryable = status !== 404 && status !== 410;
      if (retryable && attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastErr instanceof FetchError) throw lastErr;
  throw new FetchError((lastErr as Error)?.message ?? 'unknown', url);
}
