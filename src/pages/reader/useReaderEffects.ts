import { useEffect, useRef, useState } from 'react';
import { getShelf } from '@/store/shelf';

/**
 * 阅读器副作用
 *
 * 都只跟"订阅 + 释放"有关：常亮锁、图片预加载、提示条计时、切章时读进度。
 * 抽出来是因为 ReaderPage 该剩下的只有「谁依赖谁」。
 */

/**
 * 从书架记录里读上次读到百分之几。
 * 只在切章时读一次 —— 滚动过程中反复读 IndexedDB 没必要。
 */
export function useSavedPercent(
  pluginId: string | undefined,
  slug: string,
  chapterId: string,
): number {
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!pluginId) return;

    void getShelf(pluginId).then((shelf) => {
      if (cancelled) return;
      const entry = shelf.find((s) => s.slug === slug);
      setPercent(entry?.positions?.[chapterId] ?? 0);
    });

    return () => {
      cancelled = true;
    };
  }, [pluginId, slug, chapterId]);

  return percent;
}

/**
 * 分页模式的进度恢复。
 *
 * 每章进来定位一次，落在上次读到的百分比上。
 * 这里不能像滚动那样「两端宽限」：ReaderPage 换章不重挂，
 * page 是带着上一章的屏号过来的，所以哪怕进度是 0 也要显式归零，
 * 否则新章一进来就在第 5 屏。
 *
 * 走 setPage 而不是 seek —— seek 是用户拖进度条，会写进度；
 * 这条是程序定位，写回去只是把刚读出来的数再存一遍。
 */
export function useRestorePagedPosition(
  enabled: boolean,
  percent: number,
  totalPages: number,
  setPage: (n: number) => void,
) {
  useEffect(() => {
    if (!enabled || totalPages < 1) return;
    // usePaging 记的是 page/(totalPages-1)，这里取逆
    const target = Math.round((percent / 100) * (totalPages - 1));
    setPage(Math.max(0, Math.min(totalPages - 1, target)));
  }, [enabled, percent, totalPages, setPage]);
}

/** 提示条 2.6 秒后自动消失 */
export function useAutoDismiss(text: string | null, clear: () => void) {
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(clear, 2600);
    return () => clearTimeout(t);
  }, [text, clear]);
}

/**
 * 屏幕常亮
 *
 * Wake Lock 只能在页面「已可见」时申请，且页面隐藏会自动释放。
 * 所以每次可见都要重新申请，否则息屏后锁就没了。
 *
 * @param enabled 是否保持常亮
 * @param ready  内容是否已就绪（就绪才申请，避免加载中就锁屏）
 */
export function useKeepAwake(enabled: boolean, ready: boolean) {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!enabled || !ready) return;

    let disposed = false;

    const acquire = async () => {
      // 非安全上下文（比如 http 局域网访问）或浏览器不支持
      if (!('wakeLock' in navigator)) return;
      try {
        lockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // 用户在系统里关了、或者权限被拒。静默降级。
      }
    };

    const onVisibleChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibleChange);

    return () => {
      disposed = true;
      void disposed; // 标记已卸载，acquire 的晚到结果直接丢弃
      document.removeEventListener('visibilitychange', onVisibleChange);
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [enabled, ready]);
}

/**
 * 图片预加载
 *
 * 分页模式下把当前页前后各几张塞进浏览器缓存，翻页就不用等。
 * 用 new Image() 而不是 <img>，因为不需要渲染进 DOM。
 */
export function useImagePreload(
  images: string[] | null,
  startIndex: number,
  count: number,
  enabled: boolean,
  radius = 2,
) {
  const done = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !images) return;

    const from = Math.max(0, startIndex - radius);
    const to = Math.min(images.length, startIndex + count + radius);

    for (let i = from; i < to; i++) {
      const src = images[i];
      if (!src || done.current.has(src)) continue;
      done.current.add(src);
      const img = new Image();
      img.src = src;
    }
  }, [images, startIndex, count, enabled, radius]);

  /** 换章时清空记录，否则同一章的图片不会重新预热 */
  useEffect(() => {
    done.current.clear();
  }, [images]);
}
