/**
 * 翻页前的解码预热
 *
 * 为什么要它：<img> 挂上不等于画得出来。decoding="async" 把解码推到绘制那一帧，
 * 而翻页动画从第 0 帧就要这张图。回翻时新页是**盖在上面扫进来**的那一层，
 * 解码没完成的几帧它是一片透明 —— 用户看到的"先扫进来一层空气、图再啪地出现"就是这个。
 * 往前翻时同一张图躺在旧页底下，空白期被盖住了，所以只有回翻那个方向会闪。
 *
 * capMs 是硬上限：预热失败、图还没下完、或者机器慢，都不能把翻页卡住。
 * 翻页是用户的手势，手势的反馈必须按时到，宁可演一次带空白的动画。
 */
export function warmImages(el: HTMLElement | null, capMs: number): Promise<void> {
  const pending = el
    ? [...el.querySelectorAll('img')].filter((img) => !img.complete || !img.naturalWidth)
    : [];
  if (!pending.length) return Promise.resolve();

  const decoded = Promise.all(pending.map((img) => img.decode().catch(() => {}))).then(() => {});
  const capped = new Promise<void>((resolve) => {
    window.setTimeout(resolve, capMs);
  });
  return Promise.race([decoded, capped]);
}
