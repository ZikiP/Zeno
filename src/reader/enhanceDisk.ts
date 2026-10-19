/**
 * 画面增强的盘上那一份（Cache Storage）
 *
 * 为什么要有这一层：一台 Worker 一页要算 310~500ms，一章读到底的算量是几十秒，
 * 而**重读同一章要的是完全一样的那张图**。写进 Cache Storage 之后，重读、
 * 内存被撤销过、甚至下次开应用，都是"读盘 + 包一个 blob 地址"，不出网也不算。
 *
 * 为什么选 Cache Storage 而不是自己往 D:\\zeno\\cache 写：那个目录是**源站字节**的
 * 缓存，键是上游地址、由服务端管淘汰；增强版是这台设备按自己的屏幕宽度现造的，
 * 换设备就不可复用。放在浏览器侧的桶里，键和生命周期都归这一层自己管，
 * 也不用给后端加一条能写任意内容的通路。
 *
 * 这一层的失败全部当"没有盘上缓存"处理：拿不到桶（无痕、老 Safari）不该让
 * 增强整体坏掉。
 */

/** 桶名。跟 Service Worker 自己的 site-pages/comic-images 分开，别互相淘汰 */
const BUCKET = 'zeno-enhanced';

let bucketPromise: Promise<Cache | null> | null = null;
function bucket(): Promise<Cache | null> {
  if (!bucketPromise) {
    bucketPromise =
      typeof caches !== 'undefined' && caches.open
        ? caches.open(BUCKET).catch(() => null)
        : Promise.resolve(null);
  }
  return bucketPromise;
}

/** 地址里带着 src 本身（它是个已经编码好的代理 URL），所以整串塞进 path 是合法的 */
const diskKey = (key: string) => `https://enhanced.invalid/${encodeURIComponent(key)}`;

/** blob 直接留着用，不要绕回 object URL 再 fetch 一次 */
export async function readDiskBlob(key: string): Promise<Blob | null> {
  const c = await bucket();
  if (!c) return null;
  const res = await c.match(new Request(diskKey(key))).catch(() => null);
  if (!res) return null;
  const blob = await res.blob().catch(() => null);
  return blob && blob.size ? blob : null;
}

export function persistDiskBlob(key: string, blob: Blob): Promise<unknown> {
  return bucket().then((c) =>
    c ? c.put(new Request(diskKey(key)), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/png' } })) : undefined,
  ).catch(() => {});
}

/** 想要就持久一点：这些全可再生成，被系统清掉也能活着，但能少清就少清 */
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => {});
}
