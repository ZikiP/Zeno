import type { Plugin } from './types';

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
 */
export function proxied(url: string): string {
  if (typeof window === 'undefined') return url;
  return `${PROXY_PATH}?url=${encodeURIComponent(url)}`;
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
 * 取上游页面的 HTML，带退避重试。
 *
 * 重试是必需的：实测同一 URL 连测 4 次都 200，但并发放几个请求时
 * 会偶发 `fetch failed`（站点掐短时间多连接）。3 次尝试足够覆盖。
 */
export async function fetchText(
  plugin: Plugin,
  url: string,
  timeoutMs = 20_000,
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(proxied(url), {
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
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`${(lastErr as Error)?.message ?? 'unknown'} — ${url}`);
}
