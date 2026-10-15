/**
 * 渲染结果缓存
 *
 * browser 模式一次渲染要 1-3s，而阅读里重复取同一个 URL 的场景很多：
 * 返回列表再点进来、章节抽屉来回切、失败后重试。
 *
 * 键必须带上判据（waitFor / minCount / capture）：同一个 URL 等不同条件，
 * "算不算成功"的判据不同，共用一份结果会把列表页的成功当成详情页的成功。
 *
 * TTL 故意短：列表/详情内容本来就在变，缓存久了用户看到的就是旧章节。
 */
const RENDER_TTL_MS = Number(process.env.RENDER_TTL_MS || 90_000);
const MAX_ENTRIES = Number(process.env.RENDER_CACHE_MAX || 24);

/** Map 的迭代顺序就是插入顺序，容量满了从头开始挤 */
const store = new Map();
let hits = 0;

export function keyFor(url, opts) {
  return JSON.stringify([url, opts.waitFor ?? '', opts.minCount ?? '', opts.capture ?? '']);
}

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry || Date.now() - entry.at >= RENDER_TTL_MS) return null;
  hits++;
  return entry.out;
}

/** 失败的结果不缓存 —— 那等于把一次抖动钉住整个 TTL，用户重试只拿到同一个坏结果 */
export function cachePut(key, out) {
  if (out.status >= 400) return;
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { at: Date.now(), out });
}

export function renderCacheStats() {
  return { size: store.size, hits, ttlMs: RENDER_TTL_MS };
}
