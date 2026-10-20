/**
 * 章节 HTML 的进程内短缓存
 *
 * 只缓存**章节页**，而且由客户端显式用 `X-Zeno-Page: chapter` 标记。
 * 列表/详情页不缓存：新章信息不能被十分钟的缓存挡住（test-cache 钉着这条）。
 *
 * 章节页的内容在十分钟内基本不变，而它是阅读器最大的一段等待（实测 0.4–1.8s）。
 * 同一台机器上换设备、刷新、重开都会命中；图片仍走磁盘缓存，互不干扰。
 */
const TTL_MS = Math.max(0, Number(process.env.HTML_CACHE_MS ?? 10 * 60_000));
const MAX_ENTRIES = Math.max(1, Number(process.env.HTML_CACHE_MAX ?? 120));
const MAX_TOTAL_BYTES = Math.max(0, Number(process.env.HTML_CACHE_MAX_BYTES ?? 32 * 1024 * 1024));
const MAX_OBJECT_BYTES = Math.max(0, Number(process.env.PAGE_MAX_BYTES ?? 8 * 1024 * 1024));

const store = new Map();
let totalBytes = 0;

const isHtml = (ctype) => /^text\/html\b|^application\/xhtml\+xml\b/i.test(String(ctype ?? ''));

export function getHtml(key) {
  if (!TTL_MS || !key) return null;
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(key);
    totalBytes -= hit.body.length;
    return null;
  }
  return hit;
}

function putHtml(key, body, contentType) {
  if (!TTL_MS || !key || !body?.length) return;
  if (body.length > MAX_OBJECT_BYTES || body.length > MAX_TOTAL_BYTES) return;
  const old = store.get(key);
  if (old) totalBytes -= old.body.length;
  store.set(key, { at: Date.now(), body, contentType });
  totalBytes += body.length;
  while ((totalBytes > MAX_TOTAL_BYTES || store.size > MAX_ENTRIES) && store.size) {
    const [oldKey, oldVal] = store.entries().next().value;
    store.delete(oldKey);
    totalBytes -= oldVal.body.length;
  }
}

/**
 * 攒一份 HTML。流结束才提交，客户端中途断开不落半页。
 * @returns {{push: (chunk: Uint8Array) => void, commit: () => void} | null}
 */
export function htmlCollector(key, contentType) {
  if (!TTL_MS || !key || !isHtml(contentType)) return null;
  const chunks = [];
  let size = 0;
  let dead = false;
  return {
    push(chunk) {
      if (dead) return;
      size += chunk.length;
      if (size > MAX_OBJECT_BYTES) {
        dead = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    },
    commit() {
      if (dead || !chunks.length) return;
      putHtml(key, Buffer.concat(chunks), contentType);
    },
  };
}

export function htmlCacheStats() {
  return { entries: store.size, bytes: totalBytes, ttlMs: TTL_MS };
}
