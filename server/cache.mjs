/**
 * 图片缓存对外的两张脸：给客户端回图、给设置页管配置
 *
 * 盘上怎么存、账本怎么记都在 cache-store.mjs，「放哪儿、放多少、有没有坏」
 * 在 cache-config.mjs。这里只做组装和 HTTP。
 *
 * 为什么值得做：Service Worker 那份图片缓存（CacheFirst，800 张 / 90 天）是
 * **每台设备各自的**；这份是**所有设备共用的** —— 手机看过的图平板第一次看
 * 不用再回源站，超出 800 张上限的老图、以及根本没装起 SW 的场景
 * （隐私模式、非 HTTPS 的局域网直连）也由它兜住。
 * 漫画图片的 URL 基本是永久的，所以不存在"读到旧内容"这种失效问题。
 *
 * 命中路径不去问上游，因此 CDN 限流或抽风时已经看过的图照样出
 * （实测掐掉源站仍 200）。
 *
 * 只缓存图片。browser 模式渲染出的 HTML 有时效（新话、章节变动），
 * 那份继续走 render.mjs 自己的 TTL，不进这里。
 */
import { createReadStream } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { json, readBody } from './respond.mjs';
import {
  assertCacheDir,
  cacheDir,
  cacheMaxBytes,
  cacheOn,
  defaultCacheDir,
  ensureCacheDir,
  getWarning,
  resetWarning,
  saveCacheDir,
  saveCacheMaxMb,
} from './cache-config.mjs';
import { reconcile, totals, wipeFiles, wipeIndex } from './cache-store.mjs';

/** 图片给浏览器的时效：URL 基本不变，放到一天，过期了还能先给旧的再后台补 */
export const IMG_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * 把缓存里的图直接回给客户端。
 *
 * X-Zeno-Cache 是给我们自己看的：测试和排查「这张图到底有没有命中」
 * 靠响应头比靠日志靠谱。
 */
export function serveCached(res, hit, method, extraHeaders = {}) {
  res.writeHead(200, {
    ...extraHeaders,
    'Content-Type': hit.ctype || 'application/octet-stream',
    'Content-Length': String(hit.bytes),
    'Cache-Control': IMG_CACHE_CONTROL,
    'X-Zeno-Cache': 'HIT',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const s = createReadStream(hit.path);
  // 文件可能在 writeHead 之后被人删掉。头已经发出去了，只能就地收尾
  s.on('error', () => res.end());
  s.pipe(res);
}

export async function cacheStatus() {
  const dir = cacheDir();
  const { files, bytes } = totals();
  let freeBytes = null;
  if (dir) {
    try {
      const s = await statfs(dir);
      freeBytes = s.bsize * s.bavail;
    } catch {
      /* 目录还没建（刚清空过），或平台不支持 statfs */
    }
  }
  return {
    dir,
    enabled: cacheOn(),
    maxBytes: cacheMaxBytes(),
    files,
    bytes,
    freeBytes,
    defaultDir: defaultCacheDir(),
    warning: getWarning(),
  };
}

export async function setConfig({ dir, maxMb }) {
  if (dir !== undefined) {
    const abs = assertCacheDir(dir);
    // 当场建出来，否则用户要到第一张图落盘时才发现路径写错了
    ensureCacheDir(abs);
    // 换目录：旧目录的账本跟着作废，不然统计全是陈旧行
    if (abs !== cacheDir()) wipeIndex();
    saveCacheDir(abs);
    resetWarning();
  }
  if (maxMb !== undefined) {
    const n = Number(maxMb);
    if (!Number.isFinite(n) || n < 0) throw new Error('上限要是不小于 0 的数（0 = 关掉缓存）');
    saveCacheMaxMb(n);
  }
  await reconcile();
  return cacheStatus();
}

export async function clearCache() {
  await wipeFiles();
  wipeIndex();
  return cacheStatus();
}

/**
 * @returns {Promise<boolean>} 已经处理完了（true 时调用方不要再往下走）
 */
export async function handleCacheApi(req, res, url, auth) {
  const path = url.pathname;
  if (!path.startsWith('/api/cache')) return false;

  if (!auth(req)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    if (path === '/api/cache' && req.method === 'GET') {
      json(res, 200, await cacheStatus());
      return true;
    }
    if (path === '/api/cache/config' && req.method === 'POST') {
      json(res, 200, await setConfig(await readBody(req)));
      return true;
    }
    if (path === '/api/cache/clear' && req.method === 'POST') {
      json(res, 200, await clearCache());
      return true;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 400, { error: e.message });
  }
  return true;
}
