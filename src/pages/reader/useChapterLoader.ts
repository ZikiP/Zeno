import { useEffect, useRef, useState } from 'react';
import { getChapter } from '@/site/engine';
import type { Plugin } from '@/site/types';
import { cacheChapterImages, getCachedChapter } from '@/store/chapters';
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
        // 后台静默缓存，不阻塞阅读
        void cacheChapterImages(pluginId!, slug, chapterId, result.images);
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
    // plugin 对象引用变化频繁，用它的 id 做依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, pluginId, slug, chapterId, nonce]);

  /** 进度写入做 600ms 节流，连续滚动时不会疯狂写 IndexedDB */
  const record = (ratio: number) => {
    if (!pluginId) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void savePosition(pluginId, slug, chapterId, Math.round(ratio * 100));
    }, 600);
  };

  /** 组件卸载时立即补写一次，避免 debounce 期间切页丢进度 */
  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current);
      const el = scrollRef.current;
      if (pluginId && el) {
        const total = el.scrollHeight - el.clientHeight;
        if (total > 0 && el.scrollTop > 0) {
          void savePosition(pluginId, slug, chapterId, Math.round((el.scrollTop / total) * 100));
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
 * 必须等图片撑开高度才能定位，否则设了 scrollTop 也没用。
 * 所以连等两帧。
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

    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const total = el.scrollHeight - el.clientHeight;
        if (total > 0) el.scrollTop = (total * percent) / 100;
      });
    });

    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [enabled, percent, container]);
}
