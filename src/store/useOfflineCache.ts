import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cacheChapterImages,
  deleteCachedByPluginAndSlug,
  getCachedChapter,
  listCachedChapters,
} from '@/store/chapters';
import { removeFromShelf } from '@/store/shelf';
import { onDataChange } from '@/store/dataEvents';
import { getChapter, type Chapter } from '@/site/engine';
import type { Plugin } from '@/site/types';

export type CachedMap = Record<string, { bytes: number }>;

/**
 * 一部漫画的离线缓存
 *
 * 从 ComicPage 抽出来：「哪些章节已缓存 + 整本下载 + 同步回来后要刷新」
 * 是一组自带状态的逻辑，留在页面里就把界面和数据混在了同一 250 行。
 */
export function useOfflineCache(plugin: Plugin | null, slug: string, chapters: Chapter[]) {
  const [cached, setCached] = useState<CachedMap>({});
  const [caching, setCaching] = useState<{ done: number; total: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!plugin) return;
    try {
      const list = await listCachedChapters(plugin.meta.id, slug);
      const map: CachedMap = {};
      for (const item of list) map[item.chapterId] = { bytes: item.bytes };
      setCached(map);
    } catch {
      /* 读失败就保持现状，别打断浏览 */
    }
  }, [plugin, slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * 同步把别处的「加入书架 / 离线下载」变更拉回来时刷新本地状态。
   * 只重读本地这几项，不重新抓漫画详情 —— 数据没变就白请求一次。
   */
  useEffect(() => onDataChange(refresh), [refresh]);

  /** 逐章抓取并缓存。已缓存的跳过，单章失败只记日志不中断整本 */
  const cacheAll = useCallback(async () => {
    if (!plugin?.meta.id) return;
    const targets = chapters.filter((c) => !cached[c.id]);
    if (targets.length === 0) {
      alert('所有章节都已缓存');
      return;
    }
    if (!confirm(`将下载 ${targets.length} 章到本机离线存储，可能占用较多空间。继续？`)) return;

    const total = targets.length;
    setCaching({ done: 0, total });

    for (let i = 0; i < targets.length; i++) {
      const ch = targets[i];
      try {
        const existing = await getCachedChapter(plugin.meta.id, slug, ch.id);
        const images = existing?.images ?? (await getChapter(plugin, slug, ch.id)).images;
        const bytes = await cacheChapterImages(plugin.meta.id, slug, ch.id, images, (p) =>
          setCaching({ done: i + p.done / p.total, total }),
        );
        setCached((m) => ({ ...m, [ch.id]: { bytes } }));
      } catch (e) {
        console.error(`缓存 ${ch.id} 失败`, e);
      }
    }

    setCaching(null);
    alert('下载完成');
  }, [plugin, slug, chapters, cached]);

  /** 从书架移除时连同整本的离线缓存一起清掉 */
  const dropEverything = useCallback(
    async (comicTitle: string) => {
      if (!plugin) return false;
      /*
       * 两件事的时机不一样，必须分开说：这台设备的离线缓存是立刻清，
       * 服务端那台机器替这本书铺的缓存是**一天后**才腾 —— 一天内把书加回书架，
       * 那份原样留着。不写这一句，用户会以为移除就等于全部丢掉。
       */
      if (
        !confirm(
          `移除《${comicTitle}》？\n\n这台设备的离线缓存会立刻清除；服务端为它铺好的章节缓存在一天后清除，一天内重新加入书架就原样保留。`,
        )
      )
        return false;
      await deleteCachedByPluginAndSlug(plugin.meta.id, slug);
      await removeFromShelf(plugin.meta.id, slug);
      return true;
    },
    [plugin, slug],
  );

  const cachedBytes = useMemo(
    () => Object.values(cached).reduce((s, v) => s + v.bytes, 0),
    [cached],
  );

  return { cached, caching, cachedBytes, cacheAll, dropEverything, refresh };
}
