/**
 * 某一类页面该怎么取源
 *
 * 抽出来是因为有**两个**消费方：追更要取详情页数章节条数，追漫要取章节页拿图片地址表。
 * 两边问的是同一套规则 ——「这个站的这一类页面是 fetch 还是 browser、要等什么选择器、
 * 要等够几条、要不要从 JSON 里抓表」。抄成两份的话，迟早有一份漏掉 minCount，
 * 而那个坑实测踩过两次：SSR 壳里先挂 1 条占位、JS 再灌进 20+ 条，
 * 只等"出现过"就拿回 1 条，跟客户端解析出的条数一比反而是负的，徽章永远消不掉。
 */
import { headersFor } from './allowlist.mjs';
import { renderHtml } from './render.mjs';

/**
 * 站点声明的头优先，UA 默认给桌面：实测某站只给桌面 UA 返回服务端渲染的列表，
 * 手机 UA 一律 302 到 JS 壳 —— 那种页拿手机 UA 去取，必须花三秒渲染而还取不全。
 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 25_000;

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 地址模板里的 {slug} / {id} 占位。跟客户端 engine.ts 的 fill 同一个写法 */
export const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));

/** 某一类页面该用哪种取源方式。跟客户端 modeFor/waitForFor 同一套读法 */
export function modeFor(plugin, kind) {
  const m = plugin.fetch?.mode;
  if (!m) return 'fetch';
  return typeof m === 'string' ? m : (m[kind] ?? 'fetch');
}

export function waitForFor(plugin, kind) {
  const w = plugin.fetch?.waitFor;
  if (!w) return undefined;
  return typeof w === 'string' ? w : w[kind];
}

export function minCountFor(plugin, kind) {
  const m = plugin.fetch?.minCount;
  if (m === undefined) return undefined;
  return typeof m === 'number' ? m : m[kind];
}

/** 从页面 JS 交给 JSON.parse 的数据里直接抓地址的正则（翻页式阅读器才需要） */
export function captureFor(plugin, kind) {
  const c = plugin.fetch?.capture;
  if (!c) return undefined;
  return typeof c === 'string' ? c : c[kind];
}

/**
 * 取某一类页面的正文。
 *
 * 回的是 `{html, images}`：browser 模式且站点声明了 capture 时，渲染可能直接交出
 * 整张地址表（那时 html 是空的，别再序列化一遍 DOM —— 实测省掉一次 75 KB）；
 * 其余情况拿到的是 HTML，由调用方自己按 parse 规则解。
 *
 * 两种形态都给了才叫拿到：`images` 非空 **或** `html` 非空。都为空就是没取到，
 * 调用方该按失败处理，不能拿空串去写"这页没有内容"。
 */
export async function fetchPage(plugin, url, kind) {
  const host = new URL(url).hostname.toLowerCase();
  if (modeFor(plugin, kind) === 'browser') {
    const r = await renderHtml(url, {
      waitFor: waitForFor(plugin, kind),
      minCount: minCountFor(plugin, kind),
      capture: captureFor(plugin, kind),
      timeoutMs: plugin.fetch?.timeoutMs,
      userAgent: plugin.headers?.['user-agent'] ?? plugin.headers?.['User-Agent'] ?? DESKTOP_UA,
    });
    if (r.format === 'json') return { html: '', images: r.captured ?? [] };
    return { html: r.html ?? '', images: [] };
  }

  const res = await fetch(url, {
    headers: { 'user-agent': plugin.headers?.['user-agent'] ?? plugin.headers?.['User-Agent'] ?? DESKTOP_UA, ...headersFor(host) },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), images: [] };
}
