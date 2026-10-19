/**
 * 一张页面图怎么用画面增强
 *
 * 单独一个文件是因为它管的是"这一页什么时候可以画"，跟 enhance.ts 的
 * 「怎么排队、怎么算一张」是两件事。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { markImageReady } from '@/components/RetryableImage';
import { enhanceSource, giveUp, peekEnhanced, pinEnhanced, unpinEnhanced } from './enhance';

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
  /** 这张已经可以画了：要么本来就不需要增强，要么增强版已就绪 */
  const [reveal, setReveal] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  /*
   * 用 LayoutEffect 而不是 Effect：cache 命中时这里同步 setUrl，
   * React 会在第一次 paint 之前把新 src 提交上去。晚一帧就变成
   * "空白一帧 → 增强版"，那是把闪换了个颜色，不是没闪。
   */
  useLayoutEffect(() => {
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
    /*
     * 用 offsetWidth 而不是 getBoundingClientRect().width：
     * 后者把翻页动画的 transform 也算进去，折页那一瞬间量到的宽度是错的。
     */
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || started) return;
        started = true;
        io.disconnect();
        const targetW = Math.round(el.offsetWidth * (window.devicePixelRatio || 1));
        if (targetW < 2) {
          setReveal(true);
          return;
        }
        usedW.current = targetW;
        /* 离视口越近越先算：一次进章有十几张在排队，先算脚下的那几张 */
        const prio = Math.max(0, Math.round(entries[0].boundingClientRect.top - window.innerHeight / 2));
        void enhanceSource(src, targetW, prio).then((u) => {
          if (cancelled) return;
          if (!u) return setReveal(true);
          /* 先登记这个地址能直接画，换上去那一帧才不会是透明的（见 RetryableImage 的 readySrcs） */
          markImageReady(u);
          setUrl(u);
          setReveal(true);
        });
      },
      { rootMargin: OBSERVE_MARGIN },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
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

  return { ref, url, revert, reveal };
}
