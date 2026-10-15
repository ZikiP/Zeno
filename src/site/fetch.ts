import type { FetchMode, PageKind, Plugin } from './types';
import { decodeEntities } from './text';

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
/** waitFor / minCount / capture 三个"等到什么才算取到位"的判据 */
export interface SettleOpts {
  waitFor?: string;
  minCount?: number;
  capture?: string;
  timeoutMs?: number;
}

export function proxied(
  url: string,
  mode: 'fetch' | 'browser' = 'fetch',
  opts: SettleOpts | string = {},
): string {
  const base = nodeProxyBase();
  if (typeof window === 'undefined' && !base) return url;
  const origin = typeof window === 'undefined' ? base! : '';
  let out = `${origin}${PROXY_PATH}?url=${encodeURIComponent(url)}`;
  if (mode !== 'browser') return out;
  out += `&mode=browser`;
  // 第三参历史上是 waitFor 字符串，留着这个写法免得探针脚本全改一遍
  const o: SettleOpts = typeof opts === 'string' ? { waitFor: opts } : opts;
  if (o.waitFor) out += `&waitFor=${encodeURIComponent(o.waitFor)}`;
  if (o.minCount && o.minCount > 1) out += `&minCount=${o.minCount}`;
  if (o.capture) out += `&capture=${encodeURIComponent(o.capture)}`;
  if (o.timeoutMs) out += `&timeoutMs=${o.timeoutMs}`;
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

/** minCount 同上：字符串=所有类型共用，对象=按页面类型分别给 */
export function minCountFor(plugin: Plugin, kind: PageKind): number | undefined {
  const m = plugin.fetch?.minCount;
  if (m === undefined) return undefined;
  if (typeof m === 'number') return m;
  return m[kind];
}

/**
 * capture 同上。这里刻意**不做**"字符串时所有类型共用"的回落：
 * 服务端把 capture 当作比 waitFor 更硬的判据（选择器先出现不算数），
 * 一个全局 capture 会让列表页和详情页也一起去抢那张占位图之前的时间。
 * 所以只有按类型声明的那些页面才启用捕获。
 */
export function captureFor(plugin: Plugin, kind: PageKind): string | undefined {
  const c = plugin.fetch?.capture;
  if (!c || typeof c === 'string') return undefined;
  return c[kind];
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

/**
 * 请求层里"放弃这次 HTTP"要比服务端"放弃等内容"晚一点。
 *
 * 两边用同一个数的话就是同时到期，而客户端的 abort 先落在自己头上 ——
 * 于是永远拿不到服务端那份"没等够但也算渲染完了"的结果，
 * 空列表的搜索从一个"没结果"变成一次超时错误。
 */
const HTTP_MARGIN_MS = 10_000;

/**
 * 按页面类型凑出交给服务端的"等到什么才算到位"判据。
 * fetch 模式一个都不带 —— 那几个条件只有渲染时才存在。
 */
export function settleOpts(plugin: Plugin, kind: PageKind): SettleOpts {
  if (modeFor(plugin, kind) !== 'browser') return {};
  return {
    waitFor: waitForFor(plugin, kind),
    minCount: minCountFor(plugin, kind),
    capture: captureFor(plugin, kind),
    timeoutMs: plugin.fetch?.timeoutMs,
  };
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
    const timer = setTimeout(() => ctrl.abort(), timeoutMs + HTTP_MARGIN_MS);
    try {
      const res = await fetch(proxied(url, mode, settleOpts(plugin, kind)), {
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

/**
 * 取"从页面 JS 里捕获"的结果。
 *
 * 服务端命中 capture 时回 `{ images: [...] }`，没命中就回整页 HTML ——
 * 这里把两种都接下来：命中给地址表，没命中把 HTML 原样带回，
 * 让调用方能拿**同一次渲染**回落到 DOM 正则，而不是再渲染一遍。
 *
 * 只试一次，理由和 fetchText 里 browser 模式一样：一次渲染就要几秒，
 * 它失败的原因（页面确实没这份数据）重试也不会变。
 */
export async function fetchCaptured(
  plugin: Plugin,
  url: string,
  kind: PageKind,
  opts?: { signal?: AbortSignal },
): Promise<{ images: string[]; html: string }> {
  const settle = settleOpts(plugin, kind);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (settle.timeoutMs ?? 20_000) + HTTP_MARGIN_MS);
  const onAbort = () => ctrl.abort();
  opts?.signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(proxied(url, 'browser', settle), {
      headers: {
        'User-Agent': plugin.headers?.['User-Agent'] ?? DEFAULT_UA,
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': plugin.headers?.['Accept-Language'] ?? 'zh-TW,zh;q=0.9,zh-CN;q=0.8',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
    const text = await res.text();
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      return { images: [], html: decodeEntities(text) };
    }
    const parsed = JSON.parse(text) as { images?: unknown };
    const images = Array.isArray(parsed.images)
      ? parsed.images.filter((u): u is string => typeof u === 'string')
      : [];
    return { images, html: '' };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError((e as Error)?.message ?? 'capture failed', url);
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
  }
}
