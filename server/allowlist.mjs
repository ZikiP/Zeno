import { allowedHostsFromPlugins, installedPlugins, pluginHostsOf } from './plugins.mjs';

/**
 * 抓取白名单 + 插件声明的请求头
 *
 * 两者都从**已安装的插件**推导：用户在应用里装好插件，域名和 UA 一起生效，
 * 不需要再去改环境变量、重启服务 —— 同一份信息不填两遍。
 * ALLOWED_HOSTS 只作为「还没装插件就想先调代理」时的补充手段。
 */

const EXTRA = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * 只有这几个头值得替插件转发出去。
 *
 * 刻意不含 Cookie / Authorization：插件是一份分享给别人用的配置文件，
 * 一旦代理愿意转发 Cookie，"把自己的登录态发给站点"就变成了插件的一个字段，
 * 而那正是插件仓库免责声明里划掉的线。
 */
const FORWARDABLE = ['user-agent', 'accept-language', 'accept', 'referer'];

let allowed = new Set();
/** 域名后缀 → 该插件声明的请求头（小写键） */
let headersByHost = new Map();

/** 从数据库重新推导。插件变动后（push / forget-plugin）必须调 */
export function refreshAllowed() {
  allowed = new Set([...EXTRA, ...allowedHostsFromPlugins()]);
  headersByHost = new Map();
  for (const plugin of installedPlugins()) {
    const raw = plugin.headers ?? {};
    const picked = {};
    for (const key of FORWARDABLE) {
      const match = Object.keys(raw).find((k) => k.toLowerCase() === key);
      if (match && raw[match]) picked[key] = String(raw[match]);
    }
    if (!Object.keys(picked).length) continue;
    for (const host of pluginHostsOf(plugin)) headersByHost.set(host, picked);
  }
  return [...allowed];
}

export function allowedHosts() {
  return allowed;
}

/**
 * 域名匹配。填 `example.com` 会同时放行 `cdn.example.com`。
 *
 * 必须整体或以点为界才算命中：拿 `endsWith(host)` 的话
 * `notexample.com` 也会匹配上 `example.com`。
 */
export function hostAllowed(host) {
  const h = host.toLowerCase();
  for (const a of allowed) {
    if (h === a || h.endsWith(`.${a}`)) return true;
  }
  return false;
}

/**
 * 这个域名该用哪个插件声明的请求头。
 *
 * 命中多个后缀时取**最长**的那个：插件同时写了 `mangafunb.fun`（图片 CDN）
 * 和 `www.mangacopy.com`（正文域名）时，图片域名的头不该盖掉正文域名的。
 */
export function headersFor(host) {
  const h = String(host).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const [suffix, headers] of headersByHost) {
    if ((h === suffix || h.endsWith(`.${suffix}`)) && suffix.length > bestLen) {
      best = headers;
      bestLen = suffix.length;
    }
  }
  return best ?? {};
}
