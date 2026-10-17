import { useCallback, useEffect, useRef, useState } from 'react';
import { getChapter } from '@/site/engine';
import type { Plugin } from '@/site/types';
import { getCachedChapter, saveChapterTable } from '@/store/chapters';
import { savePosition } from '@/store/shelf';

/**
 * 章节加载与进度保存
 *
 * 只管一件事：把某一章的图片搞到手，并把阅读进度记下来。
 * 渲染、快捷键、书签都不在这里。
 */
export interface ChapterLoader {
  images: string[] | null;
  error: string | null;
  loading: boolean;
  fromCache: boolean;
  /**
   * 章节取到了但不完整（内页翻到一半失败了）。
   * 单独一条而不是塞进 error：图片是能读的，只是末尾缺一截，
   * 藏着不说的话，用户会当成"这章就这么短"。
   */
  warning: string | null;
  /** 记录当前进度（传 0–1 的比例，内部换算成百分比） */
  record: (ratio: number) => void;
  /** 重新加载 */
  reload: () => void;
  /** 滚动容器引用，恢复进度时要用 */
  scrollRef: React.RefObject<HTMLDivElement>;
}

/**
 * 比例 → 百分比，钳到 0..100。
 *
 * 不钳的话会写出 100 以上的假进度：卸载补写那一刻图片正在收起，
 * scrollHeight 可能比 scrollTop 还小，比值超过 1 ——
 * 之前 ScrollView 的 ref 没接上，这条路径根本没跑过，所以没暴露。
 * 移动端回弹（overscroll）也能给出 >1 的比值。
 */
const pctOf = (ratio: number) => Math.max(0, Math.min(100, Math.round(ratio * 100)));

export function useChapterLoader(
  plugin: Plugin | null,
  slug: string,
  chapterId: string,
): ChapterLoader {
  const [images, setImages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);

  const pluginId = plugin?.meta.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!plugin) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setWarning(null);
    setImages(null);

    (async () => {
      try {
        // 优先本地缓存 —— 离线时这是唯一能出图的路
        const cached = await getCachedChapter(pluginId!, slug, chapterId);
        if (cancelled) return;
        if (cached) {
          setImages(cached.images);
          setFromCache(true);
          setLoading(false);
          return;
        }

        setFromCache(false);
        const result = await getChapter(plugin, slug, chapterId);
        if (cancelled) return;

        if (result.images.length === 0) {
          setError('这一章没有图片。请检查插件的「章节正文 URL」与「图片属性」配置');
          setLoading(false);
          return;
        }

        setImages(result.images);
        setLoading(false);
        if (result.truncated) {
          setWarning('后面有几页没取到（网络或渲染失败），这一章可能不完整');
          /*
           * 不缓存残缺的一份 —— 缓存是按章节整条存的，写进去之后
           * 下次进这一章直接命中，缺的那几页就永远补不回来了。
           */
          return;
        }
        // 后台静默存地址表，不阻塞阅读：图片由 Service Worker 边看边存
        void saveChapterTable(pluginId!, slug, chapterId, result.images);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    /*
     * 依赖里只有 id，没有 plugin 那个对象 —— 它每轮 reload 都换个身份
     * （PluginContext 重新 parse 一份 JSON），带上它就等于"同步推完、拉完，各重来一次"。
     * 阅读器里重来一遍的代价比详情页大：cleanup 把正在飞的那次标成 cancelled，
     * 那一轮的结果整个丢掉，读者等到的是从零再抓一遍。
     * 实测开一章 6 跳（这一章在源站本来就分成几页，最后一跳是下一章预取）
     * 被顶成 16 跳。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, slug, chapterId, nonce]);

  /**
   * 进度写入做 600ms 节流，连续滚动时不会疯狂写 IndexedDB。
   *
   * 用 useCallback 钉住引用：翻页模式也要上报进度，而 usePaging 要把
   * 它放进翻页动作的依赖里 —— 每次渲染都换一个新函数的话，
   * 键盘监听和 PagedView 每帧都在重挂。
   */
  const record = useCallback(
    (ratio: number) => {
      if (!pluginId) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void savePosition(pluginId, slug, chapterId, pctOf(ratio));
      }, 600);
    },
    [pluginId, slug, chapterId],
  );

  /** 组件卸载时立即补写一次，避免 debounce 期间切页丢进度 */
  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current);
      const el = scrollRef.current;
      if (pluginId && el) {
        const total = el.scrollHeight - el.clientHeight;
        if (total > 0 && el.scrollTop > 0) {
          void savePosition(pluginId, slug, chapterId, pctOf(el.scrollTop / total));
        }
      }
    };
  }, [pluginId, slug, chapterId]);

  return {
    images,
    error,
    warning,
    loading,
    fromCache,
    record,
    reload: () => setNonce((n) => n + 1),
    scrollRef,
  };
}

/**
 * 恢复上次的滚动位置。
 *
 * 前提是 container 真的指着那个滚动容器 —— ScrollView 以前没把 ref 接上，
 * 于是这条整段都是空转：记录进度好用（走 onScroll），恢复却永远不动，
 * 从界面上看不出是"没实现"还是"实现错了"。
 *
 * 不能「一次算完 scrollTop」就收工：图片是 lazy 的，刚挂上的那一刻
 * scrollHeight 只算得出一小部分，而且上面那些图陆续加载完之前高度一直在长，
 * 按百分比算的 scrollTop 会跟着漂。所以盯到它稳下来为止。
 *
 * 用户自己滚了（滚轮或触摸）就立刻让位。我们设 scrollTop 触发的是 scroll
 * 事件，不会自己把这个「用户动过」的标志点亮。
 */
export function useRestoreScrollPosition(
  enabled: boolean,
  percent: number,
  container: React.RefObject<HTMLDivElement>,
) {
  useEffect(() => {
    if (!enabled || percent <= 2 || percent >= 98) return;
    const el = container.current;
    if (!el) return;

    let touched = false;
    let steady = 0;
    let last = el.scrollHeight;
    let poll = 0;
    let cap = 0;

    const apply = () => {
      const total = el.scrollHeight - el.clientHeight;
      if (total > 0) el.scrollTop = (total * percent) / 100;
    };
    const onUserScroll = () => {
      touched = true;
    };
    const stop = () => {
      window.clearInterval(poll);
      window.clearTimeout(cap);
      el.removeEventListener('wheel', onUserScroll);
      el.removeEventListener('touchstart', onUserScroll);
    };

    apply();
    poll = window.setInterval(() => {
      if (touched) return stop();
      const h = el.scrollHeight;
      if (h !== last) {
        last = h;
        steady = 0;
        return apply();
      }
      // 连续一秒钟没再长，认为图片该到的都到了
      if (++steady >= 5) stop();
    }, 200);
    // 别为了等一张永远加载不出来的图无限轮询下去
    cap = window.setTimeout(stop, 10_000);

    el.addEventListener('wheel', onUserScroll, { passive: true });
    el.addEventListener('touchstart', onUserScroll, { passive: true });

    return stop;
  }, [enabled, percent, container]);
}
