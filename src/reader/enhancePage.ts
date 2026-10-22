/**
 * 一张页面图怎么用画面增强
 *
 * 单独一个文件是因为它管的是"这一页什么时候可以画"，跟 enhance.ts 的
 * 「怎么排队、怎么算一张」是两件事。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { markImageReady } from '@/components/RetryableImage';
import { giveUp, peekEnhanced, pinEnhanced, unpinEnhanced } from './enhanceCache';
import { enhanceSource } from './enhance';

/** 每张图自己的观察窗：章级预取排到章尾，这里只兜"没被排到"的情况（回翻、改宽度） */
const OBSERVE_MARGIN = '200% 0px';

/**
 * 给一张页面图用：按当前显示宽度拿它的增强版。
 *
 * 三种落点，只有一个会被用户看成"没变化"：
 *   - 增强版已经在缓存里 → 在 useLayoutEffect 里同步取用，第一次 paint 画的就是它，
 *     既不等也不换，这一页从头到尾只有一张图（这才叫不掉闪）。
 *   - 还没算出来、而这张是第一次上屏 → 先不画（reveal=false）。
 *     顺序反过来就是被报上来的那一下：先看到原图、半秒后被硬换成增强版。
 *   - 这张已经画出原图了（比如回翻到一张早已显示过的页）→ 不再凭空变空白，
 *     照旧晚半秒盖上去。
 */
export function useEnhancedSource(src: string, enabled: boolean) {
  const ref = useRef<HTMLImageElement>(null);
  const usedW = useRef(0);
  /** 用户手动点了刷新：这一张不再等增强，晚到的结果也不要再换上来 */
  const abandoned = useRef(false);
  /** 这张已经可以画了：要么本来就不需要增强，要么增强版已就绪 */
  const [reveal, setReveal] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  /*
   * 用 LayoutEffect 而不是 Effect：cache 命中时这里同步 setUrl，
   * React 会在第一次 paint 之前把新 src 提交上去。晚一帧就变成
   * "空白一帧 → 增强版"，那是把闪换了个颜色，不是没闪。
   */
  useLayoutEffect(() => {
    abandoned.current = false;
    const el = ref.current;
    if (!enabled || !el) {
      setReveal(true);
      setUrl(null);
      return;
    }
    const targetW = Math.round(el.offsetWidth * (window.devicePixelRatio || 1));
    const hit = peekEnhanced(src, targetW);
    if (hit) {
      usedW.current = targetW;
      setUrl(hit);
      setReveal(true);
      return;
    }
    setReveal(false);
    setUrl(null);
  }, [src, enabled]);

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    let started = false;
    let io: IntersectionObserver | null = null;
    let ro: ResizeObserver | null = null;

    const stop = () => {
      io?.disconnect();
      ro?.disconnect();
      io = null;
      ro = null;
    };

    const start = (rect: DOMRect) => {
      if (cancelled || started) return;
      started = true;
      stop();
      /*
       * 用 offsetWidth 而不是 getBoundingClientRect().width：
       * 后者把翻页动画的 transform 也算进去，折页那一瞬间量到的宽度是错的。
       */
      const targetW = Math.round(el.offsetWidth * (window.devicePixelRatio || 1));
      if (targetW < 2) {
        setReveal(true);
        return;
      }
      usedW.current = targetW;
      /* 离视口越近越先算：一次进章有十几张在排队，先算脚下的那几张 */
      const prio = Math.max(0, Math.round(rect.top - window.innerHeight / 2));
      void enhanceSource(src, targetW, prio).then((u) => {
        if (cancelled || abandoned.current) return;
        if (!u) return setReveal(true);
        /* 先登记这个地址能直接画，换上去那一帧才不会是透明的（见 RetryableImage 的 readySrcs） */
        markImageReady(u);
        setUrl(u);
        setReveal(true);
      });
    };

    /*
     * 还没排上版的页（lazy 图没有自然高度）**不能**在这里起活。
     *
     * 换章挂载那一帧整章都还没有高度，全部叠在 top:0 —— 每张图的观察器都会
     * 判成"在屏幕上"，各自用 prio 0 去插队，章级预排（离章头多远）的顺序被
     * 整章抹平。实测换下一章的第一页因此排到三十多页之后，黑 5 秒以上。
     * 所以这里只给"已有尺寸且真在观察窗里"的页起活；其余交给 queueAhead，
     * 等它滚到附近、图有了尺寸，观察器再按真实位置纠偏。
     */
    const near = (rect: DOMRect) => {
      const vh = window.innerHeight;
      return rect.bottom > -2 * vh && rect.top < 3 * vh;
    };
    const check = () => {
      if (cancelled || started) return;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 2 && rect.height >= 2 && near(rect)) start(rect);
    };

    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) check();
      },
      { rootMargin: OBSERVE_MARGIN },
    );
    io.observe(el);
    /* IO 的 isIntersecting 在"零高度 → 有高度"时不一定再报一次，尺寸变化单独接一条 */
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(check);
      ro.observe(el);
    }

    return () => {
      cancelled = true;
      stop();
    };
  }, [src, enabled]);

  /* 正在显示的这张不许被淘汰；换页或关掉开关时松手 */
  useEffect(() => {
    if (!url) return;
    pinEnhanced(url);
    return () => unpinEnhanced(url);
  }, [url]);

  /**
   * 增强版挂上去失败了 → 退回原图。
   * 增强是锦上添花，它失败不能把一页好端端的图换成「加载失败 · 点此重试」。
   */
  const revert = useCallback(() => {
    if (!url) return;
    giveUp(src, usedW.current);
    setUrl(null);
  }, [url, src]);

  /**
   * 用户等不下去了，点刷新：这一张不再等增强，直接画原图。
   *
   * 已经排上的活收不回来（取字节那趟也没有取消的口子），所以记一笔 abandoned，
   * 结果晚到时不再换 src —— 否则点完刷新过一会儿又硬换一下，比黑着更难受。
   * 同时 giveUp 这个键，免得观察器又触发、又排一张、又等一轮。
   */
  const forceOriginal = useCallback(() => {
    if (!enabled) return;
    abandoned.current = true;
    const w =
      usedW.current ||
      Math.round((ref.current?.offsetWidth ?? 0) * (window.devicePixelRatio || 1));
    if (w >= 2) giveUp(src, w);
    setUrl(null);
    setReveal(true);
  }, [enabled, src]);

  return { ref, url, revert, reveal, forceOriginal };
}
