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
export function pluginHostsOf(plugin) {
  const hosts = new Set();
  for (const raw of [plugin.entry, plugin.chapterHost]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      /* 插件里写了非法地址就跳过，不阻塞 */
    }
  }
  for (const suffix of plugin.imageHosts ?? []) {
    if (!suffix) continue;
    const s = String(suffix).toLowerCase().replace(/^\./, '');
    if (s) hosts.add(s);
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
