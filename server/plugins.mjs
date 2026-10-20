/**
 * 已装插件的读取
 *
 * 从 db.mjs 抽出来：db.mjs 管的是连接、迁移和同步读写，而这三个函数管的是
 * "把插件 JSON 变成代理要用的东西"（域名、请求头）。混在一起的话 db.mjs 就超过了
 * 工具文件的行数上限，而且两件事的变化原因完全不同。
 */
import { openDb } from './db.mjs';

/**
 * 已装插件的解析结果。
 *
 * 坏 JSON 直接跳过：一条脏数据不该让整个代理拿不到白名单，
 * 更不该把 /api/health 一起带崩。
 */
export function installedPlugins() {
  const rows = openDb().prepare('SELECT data FROM plugins').all();
  const out = [];
  for (const row of rows) {
    try {
      const plugin = JSON.parse(row.data);
      if (plugin && typeof plugin === 'object') out.push(plugin);
    } catch {
      /* 坏数据留着跳过，不阻塞别的插件 */
    }
  }
  return out;
}

/**
 * 一个插件拥有哪些域名：entry / chapterHost 的 hostname，加上 imageHosts 的后缀。
 *
 * 白名单和"该用哪个插件声明的请求头"都必须用同一份归属判断，
 * 否则会出现「这个域名被放行了，但它的 UA 没生效」这种分裂。
 */
/**
 * 公共后缀不是「一个 CDN 的后缀」，把它放进白名单等于放行整个 TLD/托管域。
 * 不引完整 PSL（那是几百 KB 的数据），只挡住最常见且真会造成大范围放行的那些；
 * 没有点的后缀一律拒绝 —— `imageHosts: ["com"]` 是最容易写错、后果最大的一种。
 */
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'co.kr', 'com.tw', 'com.hk', 'com.sg',
  'com.br', 'co.in', 'co.nz', 'co.za',
  'github.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'blogspot.com',
]);

/** 只接受像域名的后缀；IP 字面量也走这条（点分四段能通过） */
function plausibleSuffix(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!s || s.includes('*') || s.includes('/') || s.includes(':') || !s.includes('.')) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  if (PUBLIC_SUFFIXES.has(s)) return null;
  return s;
}

export function pluginHostsOf(plugin) {
  const hosts = new Set();
  for (const raw of [plugin.entry, plugin.chapterHost]) {
    if (!raw) continue;
    try {
      const host = plausibleSuffix(new URL(raw).hostname);
      if (host) hosts.add(host);
    } catch {
      /* 插件里写了非法地址就跳过，不阻塞 */
    }
  }
  for (const suffix of plugin.imageHosts ?? []) {
    const host = plausibleSuffix(suffix);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/**
 * 从已安装的插件推导抓取代理的白名单。
 *
 * 为什么要放在这里做：用户在应用里装好插件后，白名单应该是**自动生效**的，
 * 而不是再去改环境变量重启服务 —— 同一份信息不该填两遍。
 */
export function allowedHostsFromPlugins() {
  const hosts = new Set();
  for (const plugin of installedPlugins()) for (const h of pluginHostsOf(plugin)) hosts.add(h);
  return [...hosts].filter(Boolean);
}
