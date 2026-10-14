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
 * 浏览器环境走代理（目标站点通常无 CORS 头，直连必被拦）；
 * Node 环境直连（探针脚本在那边跑，没有跨域限制）。
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
  if (typeof window === 'undefined') return url;
  if (mode !== 'browser') return `${PROXY_PATH}?url=${encodeURIComponent(url)}`;
  let out = `${PROXY_PATH}?url=${encodeURIComponent(url)}&mode=browser`;
  if (waitFor) out += `&waitFor=${encodeURIComponent(waitFor)}`;
  return out;
}

/** 封面地址：拼 CDN 的尺寸参数后过代理 */
export function coverUrl(rawCover: string, w: number, h: number): string {
  if (!rawCover) return '';
  return proxied(`${rawCover}?w=${w}&h=${h}&q=85`);
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
 * 取上游页面的 HTML，带退避重试。
 *
 * 重试是必需的：实测同一 URL 连测 4 次都 200，但并发放几个请求时
 * 会偶发 `fetch failed`（站点掐短时间多连接）。3 次尝试足够覆盖。
 *
 * browser 模式只试一次 —— 一次渲染就要几秒，而它失败的原因（页面确实没
 * 渲染出内容 / 被质询挡住）重试也不会变，三次串起来只是把一次卡死放大三倍。
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decodeEntities(await res.text());
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`${(lastErr as Error)?.message ?? 'unknown'} — ${url}`);
}
