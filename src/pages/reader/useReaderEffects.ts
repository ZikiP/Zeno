import { useCallback, useEffect, useRef, useState } from 'react';
import { getShelf } from '@/store/shelf';
import { markImageReady } from '@/components/RetryableImage';
import {
  fullscreenSupported,
  isFullscreen,
  onFullscreenChange,
  toggleFullscreen,
} from '@/reader/fullscreen';
import { useRestoreScrollPosition } from './useChapterLoader';

/**
 * 阅读器副作用
 *
 * 都只跟"订阅 + 释放"有关：常亮锁、图片预加载、提示条计时、切章时读进度。
 * 抽出来是因为 ReaderPage 该剩下的只有「谁依赖谁」。
 */

/**
 * 这本书的阅读进度。
 *
 * percent = 本章上次读到几成（恢复位置用）；
 * positions = 全书各章的百分比，章节目录靠它把读过的压暗。
 *
 * 只在换书时读一次 IndexedDB：percent 是从 positions 现推的，
 * 换章不该再多跑一趟盘。
 */
export function useShelfProgress(
  pluginId: string | undefined,
  slug: string,
  chapterId: string,
): { percent: number; positions: Record<string, number> } {
  const [positions, setPositions] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    if (!pluginId) return;

    void getShelf(pluginId).then((shelf) => {
      if (cancelled) return;
      const entry = shelf.find((s) => s.slug === slug);
      setPositions(entry?.positions ?? {});
    });

    return () => {
      cancelled = true;
    };
  }, [pluginId, slug]);

  return { percent: positions[chapterId] ?? 0, positions };
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

/**
 * 进度恢复。
 *
 * 滚动模式由 ScrollView 的 onScroll 顺带上报，恢复只看滚动容器；
 * 翻页模式的上报走 usePaging 的翻页动作（程序定位不算，否则切一下模式
 * 就把 0% 盖回真进度上），恢复单独一条 —— 换章不重挂，page 是带着
 * 上一章的屏号过来的。
 */
export function useRestoreProgress(args: {
  mode: 'scroll' | 'paged';
  /** 图片到手了才有位置可恢复 */
  ready: boolean;
  percent: number;
  scrollRef: React.RefObject<HTMLDivElement>;
  totalPages: number;
  setPage: (n: number) => void;
}) {
  const { mode, ready, percent, scrollRef, totalPages, setPage } = args;
  useRestoreScrollPosition(mode === 'scroll' && ready, percent, scrollRef);
  useRestorePagedPosition(mode === 'paged' && ready, percent, totalPages, setPage);
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
 *
 * 加载成功后顺手标一下 ready —— 翻页时那一页会以"已经能画"的状态挂载。
 * 少了这一步，它第一帧是透明的，露出来的那张是黑的，看着就是闪。
 */
export function useImagePreload(
  images: string[] | null,
  startIndex: number,
  count: number,
  enabled: boolean,
  radius = 2,
) {
  /**
   * 预热过的图片要留着引用，并且主动 decode 一次。
   *
   * 只把 src 记在 Set 里的话，Image 对象随时会被回收，浏览器手里只剩
   * 一份没解码的字节；翻页槽位那一刻挂上 <img> 仍要现场解码，
   * 实测每隔一屏就会撞上 WARM_MS=90 的上限（翻页慢约 100ms）。
   */
  const cache = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => {
    if (!enabled || !images) return;

    const from = Math.max(0, startIndex - radius);
    const to = Math.min(images.length, startIndex + count + radius);

    for (let i = from; i < to; i++) {
      const src = images[i];
      if (!src || cache.current.has(src)) continue;
      const img = new Image();
      img.decoding = 'async';
      /* 预热图不该和当前屏抢上行；同一条闸里让当前页先走 */
      img.fetchPriority = 'low';
      img.onload = () => {
        /* load 不等于 decode 完；标记 ready 也放到解码之后，第一帧才有东西可画 */
        void img
          .decode()
          .catch(() => {})
          .finally(() => markImageReady(src));
      };
      img.src = src;
      cache.current.set(src, img);
    }

    /*
     * 只保留"当前屏 + 往后一个预热半径"的解码结果。
     * 一张全屏漫画解码后是十几 MB，一路攒下来会把手机内存吃穿；
     * 正向阅读占绝对多数，回翻时重新解码一次可以接受（而且字节本来就在缓存里）。
     */
    const keepTo = Math.min(images.length, startIndex + count + radius);
    for (const key of cache.current.keys()) {
      const at = images.indexOf(key);
      if (at < 0 || at < startIndex || at >= keepTo) cache.current.delete(key);
    }
  }, [images, startIndex, count, enabled, radius]);

  /** 换章时清空记录，否则同一章的图片不会重新预热 */
  useEffect(() => {
    cache.current.clear();
  }, [images]);
}

/**
 * 全屏（沉浸式阅读）
 *
 * 状态必须跟着系统手势走：安卓拉下状态栏、桌面无障碍退出、按 ESC 都会掉出全屏，
 * 那时按钮图标得一起变，所以订阅 fullscreenchange，而不是只在点击回调里读一次。
 *
 * `auto` 为真时进阅读器试一次自动全屏。requestFullscreen 要用户手势 —— 从书架
 * 点进来那一下的激活还在有效期内，通常能成；被拒就算了，全屏是锦上添花，
 * 不该为此报错或反复重试。
 */
export function useImmersiveFullscreen(auto: boolean): {
  supported: boolean;
  active: boolean;
  toggle: () => void;
} {
  const supported = fullscreenSupported();
  const [active, setActive] = useState(false);
  const tried = useRef(false);

  useEffect(() => {
    if (!supported) return;
    setActive(isFullscreen());
    return onFullscreenChange(() => setActive(isFullscreen()));
  }, [supported]);

  useEffect(() => {
    if (!auto || !supported || tried.current) return;
    tried.current = true;
    if (isFullscreen()) return;
    void toggleFullscreen().then(setActive);
  }, [auto, supported]);

  const toggle = useCallback(() => {
    if (!supported) return;
    void toggleFullscreen().then(setActive);
  }, [supported]);

  return { supported, active, toggle };
}
