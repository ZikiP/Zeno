import { allowedHostsFromPlugins } from './db.mjs';

/**
 * 抓取白名单
 *
 * 主要来源是**已安装的插件**：用户在应用里装好插件，白名单自动生效，
 * 不需要再去改环境变量、重启服务 —— 同一份信息不填两遍。
 * ALLOWED_HOSTS 只作为「还没装插件就想先调代理」时的补充手段。
 */

const EXTRA = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

let allowed = new Set();

/** 从数据库重新推导。插件变动后（push / forget-plugin）必须调 */
export function refreshAllowed() {
  allowed = new Set([...EXTRA, ...allowedHostsFromPlugins()]);
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
