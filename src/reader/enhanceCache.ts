/**
 * 画面增强的内存里那一份
 *
 * 同一张图、同一个显示宽度只算一次，靠的就是这一层：键是 `src@targetW`，值是一个
 * blob 地址。盘上那一份在 enhanceDisk.ts，排队和算在 enhance.ts。
 *
 * 为什么键里要带宽度：增强版是按这台设备此刻的显示宽度重采样的，换个视口、换个
 * fit 档、双页与否，出来的那张都不一样 —— 拿 1440 的结果去填 1170 的槽是错的，
 * 而缓存键对不上的表现只是"一张都命中不了"，不报错，最难查。
 */
import { markImageReady } from '@/components/RetryableImage';

/**
 * 内存里同时留几张增强结果。
 *
 * 这条上限就是"翻过去的那一页是增强图还是空白"的另一半：预取排得再前，
 * 算完的结果要是先被挤掉了，那一页还是要重算、还是要等。blob 活在浏览器的
 * blob store 里（不在 JS 堆上，见 enhance.worker.ts），放宽的代价是那些 PNG
 * 副本，约 2.6MB × 张数。
 */
const CACHE_MAX = 80;
/**
 * 超出上限太多时，连"还挂在 DOM 上"的也撤销。
 *
 * 撤销一个正在用的 blob 地址不会把已显示的图弄坏 —— <img> 早就解码进自己的
 * 位图了，revoke 只挡住"以后再用这个地址加载一次"。真正会被咬到的只有这一种：
 * 组件卸载重挂、拿同一个地址重新加载一遍。所以留 8 张余量（一屏最多两张、
 * 回翻时同时挂着的也就这个量级），到顶再硬撤销。
 */
const CACHE_HARD = CACHE_MAX + 8;
export const cache = new Map<string, string>();

export function keyOf(src: string, targetW: number) {
  return `${src}@${targetW}`;
}

/**
 * 正在被某页显示着的地址，按消费者计数。
 * 两张页共用同一个地址时（章节里出现重复图），其中一张卸载不能把另一张的保护撤掉。
 */
const pins = new Map<string, number>();
export function pinEnhanced(url: string) {
  pins.set(url, (pins.get(url) ?? 0) + 1);
}
export function unpinEnhanced(url: string) {
  const n = (pins.get(url) ?? 0) - 1;
  if (n > 0) pins.set(url, n);
  else pins.delete(url);
}

/**
 * LRU：命中就重新插到末尾。
 *
 * 规矩，缺一条就会把还在显示的地址撤销掉（都踩过）：
 *   - 刚插进来的这条不能是自己的淘汰对象 —— 它这会儿还没被组件 pin 上，
 *     一旦轮到它，页面拿到的就是一个已失效的 blob 地址，直接「加载失败」。
 *   - 只撤销 refcount 为 0 的，一次腾一个位置。
 *   - 但**必须有顶**：滚动模式整章都挂在 DOM 上、全都被 pin 住，190 页读到底
 *     就是 190 张 × 2.6MB。所以超过 CACHE_HARD 时开始撤销最老的、还在显示的，
 *     理由见 CACHE_MAX 那段（已解码的那张不会被弄坏）。撤销过的地址盘上还有，
 *     真被重新要用时从盘上取回来，不重算。
 */
export function remember(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  if (cache.size <= CACHE_MAX) return;
  for (const [k, u] of cache) {
    if (k === key || (pins.get(u) ?? 0) > 0) continue;
    drop(k, u);
    break;
  }
  if (cache.size <= CACHE_HARD) return;
  for (const [k, u] of cache) {
    if (k === key) continue;
    drop(k, u);
    break;
  }
}

/**
 * 从内存里腾位置。
 *
 * **盘上那一份不动** —— 这一层就是内存腾不出来的去处，删了它等于白落盘
 * （实测过：40 页读到底、内存把开头几张顶掉之后再回去，盘上也没了，
 * 于是又老老实实重算一遍）。盘上的总量归 enhanceDisk 那一层按张数封顶。
 */
function drop(key: string, url: string) {
  cache.delete(key);
  URL.revokeObjectURL(url);
}

/**
 * 算出来过、但挂上去失败的地址对应的键。
 * 失败一次就不再重来 —— 否则"退回原图 → 观察器又触发 → 又算一版 → 又失败"会转圈。
 */
export const bad = new Set<string>();

/** 已经交过活（在排、在算、已算完）的键，只给 queueAhead 用来不重复排队 */
export const seenKeys = new Set<string>();

/**
 * 同步问一句：这张图的增强版是不是已经躺在那儿了。
 * 命中就能在 useLayoutEffect 里直接当 src 用 —— 第一次 paint 画的就是增强版。
 */
export function peekEnhanced(src: string, targetW: number): string | null {
  const key = keyOf(src, targetW);
  if (bad.has(key) || targetW < 2) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  remember(key, hit);
  markImageReady(hit);
  return hit;
}

/** 这一版挂上去失败过：这个键不再重试，免得退回原图后又被同一个坏地址顶上 */
export function giveUp(src: string, targetW: number) {
  bad.add(keyOf(src, targetW));
}
