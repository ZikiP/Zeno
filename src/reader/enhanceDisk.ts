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
 *
 * 它自己有上限（见 cap）：这一层全是可以再生成的东西，占多的那部分不是资产而是负担 ——
 * 配额吃紧时浏览器是整桶回收的，那之后每一章都要从头算。
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

/**
 * 桶里最多留多少张。
 *
 * 没有这一条它会一直长：实测连铺 5 章就到 220 条、浏览器报的 usage 已经 1.28GB，
 * 而追漫的窗口是 50 章 —— 照那个数下去是 5~6GB。更糟的不是占盘而是结局：
 * 配额吃紧时浏览器是**整桶回收**的，那一天之后每一章都要从头算，正好是黑屏本身。
 * 500 张 ≈ 1.3GB（一张 1440 宽的 PNG 约 2.6MB），够盖住"最近十来章重读不用重算"。
 * enhanceDiskMax 是测试和量东西时改档用的口子，平时不设。
 */
const cap = () => Math.max(10, Number(globalThis.localStorage?.getItem('enhanceDiskMax')) || 500);
/**
 * 到顶一次腾到哪儿 —— 不是刚好腾一张。
 *
 * 数一遍全桶是 O(条目)，挂在每张的落盘上就成了每写一张都要翻一遍 500 条；
 * 一次腾到九成，平均下来每二十来张才数一次（见 COUNT_EVERY）。
 */
const TRIM_KEEP = 0.9;
/**
 * 每落这么多次盘才数一次条目数。
 *
 * 数全桶是 O(条目)，挂在每张的落盘上就成了每写一张翻一遍五百条；但也不能数得太稀
 * —— 静止时桶里可能压在限额上方这么多张。8 这一档实测把超出压在个位数。
 */
const COUNT_EVERY = 8;

/**
 * 该删哪几条：桶里现在是 keys（**按写入顺序**排的，头是最老的），返回要删的那段。
 *
 * 没超上限就返回空。写入顺序约等于阅读顺序，所以砍掉的正是"离你脚下最远的那一截" ——
 * 这也意味着增强是沿着阅读方向往前滚的，重读最近几章仍然全是命中。
 * Chromium 实测确实按写入顺序回（41 页的章砍到剩 9、13~43）。真有那么个浏览器
 * 不按这个顺序回，砍错的也只是"哪几张要重算"—— 这一层全可再生成，读不坏。
 */
export function trimPlan(keys: readonly string[], max = cap(), keep = TRIM_KEEP): string[] {
  if (keys.length <= max) return [];
  const to = Math.max(1, Math.floor(max * keep));
  return keys.slice(0, keys.length - to);
}

let writes = 0;

export function persistDiskBlob(key: string, blob: Blob): Promise<unknown> {
  return bucket()
    .then(async (c) => {
      if (!c) return;
      await c.put(new Request(diskKey(key)), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/png' } })).catch(() => {});
      if (++writes < COUNT_EVERY) return;
      writes = 0;
      const doomed = trimPlan((await c.keys().catch(() => [])).map((r) => r.url));
      for (const url of doomed) await c.delete(new Request(url)).catch(() => {});
    })
    .catch(() => {});
}

/**
 * 要不要持久存储。拿不拿到都由浏览器判（Chrome 看参与度，无痕里恒为 false），
 * 但**不开口一定没有**，所以起应用时先悄悄要一次。
 *
 * 用户在设置里亲手打开画面增强那一刻再要一次也算这条：Firefox 那条路是有弹窗的，
 * 而弹窗只认用户手势；没有手势的那次调用在那儿等于白调。
 */
let persisted: boolean | null = null;

export async function requestPersist(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null;
  try {
    persisted = await navigator.storage.persist();
  } catch {
    /* 拿不到就当没拿到：这一层全可再生成，不该因为存储的事把阅读挡住 */
  }
  return persisted;
}

/**
 * 设置那一栏要说的两句实话：桶里现在存了几张（上限多少）、这台浏览器给没给持久存储。
 *
 * 只报张数不报字节：`navigator.storage.estimate()` 是整个源的（还含 Service Worker
 * 那两份图和 IndexedDB），拿它说"增强图占了多少盘"是假数字；而逐张问 blob 大小
 * 等于把 500 张 PNG 全读一遍，为了显示一行说明不值得。
 */
export async function diskStatus(): Promise<{ entries: number; max: number; persisted: boolean | null } | null> {
  const c = await bucket();
  if (!c) return null;
  if (persisted === null && typeof navigator !== 'undefined' && navigator.storage?.persisted) {
    persisted = await navigator.storage.persisted().catch(() => null);
  }
  return { entries: (await c.keys().catch(() => [])).length, max: cap(), persisted };
}

void requestPersist();
