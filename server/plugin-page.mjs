/**
 * 某一类页面该怎么取源
 *
 * 抽出来是因为有**两个**消费方：追更要取详情页数章节条数，追漫要取章节页拿图片地址表。
 * 两边问的是同一套规则 ——「这个站的这一类页面是 fetch 还是 browser、要等什么选择器、
 * 要等够几条、要不要从 JSON 里抓表」。抄成两份的话，迟早有一份漏掉 minCount，
 * 而那个坑实测踩过两次：SSR 壳里先挂 1 条占位、JS 再灌进 20+ 条，
 * 只等"出现过"就拿回 1 条，跟客户端解析出的条数一比反而是负的，徽章永远消不掉。
 */
import { headersFor, hostAllowed } from './allowlist.mjs';
import { renderHtml } from './render.mjs';
import { assertPublicTarget } from './ssrf.mjs';

/**
 * 站点声明的头优先，UA 默认给桌面：实测某站只给桌面 UA 返回服务端渲染的列表，
 * 手机 UA 一律 302 到 JS 壳 —— 那种页拿手机 UA 去取，必须花三秒渲染而还取不全。
 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 25_000;
/** 只给本地测试用；生产路径和代理一样受白名单 + 地址策略约束 */
const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';
const MAX_REDIRECTS = 5;
/** 后台抓的 HTML 上限。正常详情页几十 KB，超过这个数多半不是页面 */
const MAX_PAGE_BYTES = Number(process.env.PAGE_MAX_BYTES || 8 * 1024 * 1024);

/** 流式读到上限，别让一个异常上游把 Node 的内存吃光 */
async function readTextLimited(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    throw new Error(`页面过大（${declared} 字节）`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`页面过大（超过 ${MAX_PAGE_BYTES} 字节）`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * 后台抓取也要过和代理相同的两道闸。
 *
 * 以前这里直接 fetch / 直接 render：插件的 detail/chapter URL 指向 127.0.0.1
 * 或公网域名 302 到内网，追更和追漫就替它去访问了。代理里的
 * assertPublicTarget + 逐跳复检必须复用，不能只守 /api/proxy 一个入口。
 */
async function assertSafePageUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('页面地址不合法');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不支持的协议 ${u.protocol}`);
  }
  if (!hostAllowed(u.hostname.toLowerCase())) {
    throw new Error(`host not allowed: ${u.hostname}`);
  }
  if (!ALLOW_PRIVATE_HOSTS) {
    const guard = await assertPublicTarget(u);
    if (!guard.ok) throw new Error(`blocked address: ${guard.reason}`);
  }
  return u;
}

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
export async function fetchPage(plugin, url, kind, opts = {}) {
  const first = await assertSafePageUrl(url);
  const ua = plugin.headers?.['user-agent'] ?? plugin.headers?.['User-Agent'] ?? DESKTOP_UA;

  if (modeFor(plugin, kind) === 'browser') {
    const r = await renderHtml(first.toString(), {
      waitFor: waitForFor(plugin, kind),
      minCount: minCountFor(plugin, kind),
      capture: captureFor(plugin, kind),
      timeoutMs: plugin.fetch?.timeoutMs,
      userAgent: ua,
      background: opts.background,
    });
    if (r.format === 'json') return { html: '', images: r.captured ?? [] };
    return { html: r.html ?? '', images: [] };
  }

  let current = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = { 'user-agent': ua, ...headersFor(current.hostname.toLowerCase()) };
    const res = await fetch(current, {
      headers,
      // 必须手动跟：fetch 的 follow 会把 302 → 127.0.0.1 的内网跳转直接吃掉
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const loc = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      await res.body?.cancel().catch(() => {});
      current = await assertSafePageUrl(new URL(loc, current).toString());
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { html: await readTextLimited(res), images: [] };
  }
  throw new Error('重定向次数过多');
}
