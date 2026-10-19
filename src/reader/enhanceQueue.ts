/**
 * 画面增强的排队策略：什么时候把哪些活交给队列
 *
 * 单独一个文件是因为这一层的事跟"怎么算一张"（enhance.ts）不同：这里只决定
 * **按什么顺序、提前多远**去要那一堆增强版。
 *
 * 为什么要预取到章尾：每张图自己那套 IntersectionObserver 只提前两屏
 * （见 enhancePage.ts 的 OBSERVE_MARGIN），而一页要算 500ms 且只有一台 Worker ——
 * 一秒滑过两屏就追不上。追不上的那些不是"先给你看原图"，而是黑底空白：
 * 增强版没就绪时那一页被按住不画（这是"不掉闪"换来的代价，别搞反）。
 * 实测对照（40 页合成章、冷开 1 秒后一下跳到章末）：不预取时 20 秒后仍空着 36 张，
 * 预取到章尾时同一时刻 40 张全已就绪。
 */
import { bad, cache, enhanceSource, keyOf, seenKeys } from './enhance';

/**
 * 把整章的增强活排进队列：先脚下那一页，再一路往后。
 *
 * 幂等：已经算过、正在排、已经放弃的都跳过，所以翻到章末把它整个再叫一遍也不浪费。
 */
export function queueAhead(srcs: readonly string[], targetW: number, fromIndex = 0): void {
  if (!srcs.length || targetW < 2) return;
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[(fromIndex + i) % srcs.length];
    const key = keyOf(src, targetW);
    /* 越靠后的排得越远：prio 只要保证顺序就行，不必是真实像素距离 */
    if (cache.has(key) || seenKeys.has(key) || bad.has(key)) continue;
    void enhanceSource(src, targetW, i).catch(() => {});
  }
}

const PAGE_IMG = '.reader__cell img, .reader__page';
/** 等排版的那一小段时间：页图刚挂上时可能还是 0 宽（图片方向那一档要重排） */
const TRY_MS = [0, 120, 480];

/**
 * 这一档显示模式下的目标宽度（设备像素）。
 *
 * 量第一个已经排好版的页图，而不是用 viewport 推：fit 档位（适应宽度/高度/原始）
 * 和图片方向都会改真实显示宽度，靠算的会算出一个用不上的尺寸 —— 增强版是按宽度
 * 缓存的，宽度算错就一张都命中不了。
 */
function currentTargetWidth(): number {
  const dpr = window.devicePixelRatio || 1;
  for (const el of document.querySelectorAll(PAGE_IMG)) {
    const w = Math.round((el as HTMLElement).offsetWidth * dpr);
    if (w >= 2) return w;
  }
  return 0;
}

/** 入口：章到手之后（页图已排版）叫一次。参数里的 images 就是这一章的页图地址表 */
export function prefetchChapterEnhancement(images: readonly string[] | null, fromIndex = 0): void {
  if (!images?.length) return;
  let i = 0;
  const tryNow = () => {
    const targetW = currentTargetWidth();
    if (targetW >= 2) queueAhead(images, targetW, fromIndex);
    else if (i < TRY_MS.length - 1) setTimeout(tryNow, TRY_MS[++i] - TRY_MS[i - 1]);
  };
  tryNow();
}
